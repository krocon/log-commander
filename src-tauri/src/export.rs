//! Export of a view, a selection or the whole file (prompt 015) as text, CSV or JSON Lines. The
//! backend writes straight into a temporary file next to the target and renames it at the end, so a
//! cancelled or failed export leaves nothing behind and an export of gigabytes never goes through IPC.
//! The session hands out lines in steps (`LogSession::export_batch`) under a short read lock; the tail
//! never waits for an export.

use crate::encoding::display_text;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::fields::FormatGuess;
use crate::indexer::{LineReader, MAX_LINE_BYTES};
use crate::level::Level;
use crate::model::{ExportProgress, ExportState};
use crate::session::{LogSession, EXPORT_BATCH};
use parking_lot::Mutex;
use serde::Deserialize;
use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Read buffer per step; lines are read in order, so one read serves many lines.
const READ_BLOCK: usize = 1024 * 1024;
const WRITE_BUFFER: usize = 1024 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// Columns of one export at most (a format has far fewer).
const MAX_COLUMNS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Txt,
    Csv,
    Jsonl,
}

impl ExportFormat {
    /// File name extensions a target of this format may have (checked, so the command cannot be used
    /// to write other kinds of files).
    pub fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::Txt => &["txt", "log"],
            Self::Csv => &["csv"],
            Self::Jsonl => &["jsonl", "ndjson", "json"],
        }
    }
}

/// What to export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportRange {
    /// The lines of the view between two line numbers (the selection).
    Selection { first: u32, last: u32 },
    /// Everything the view shows.
    View,
    /// All lines of the file, whatever the filter hides.
    All,
}

#[derive(Debug, Clone)]
pub struct ExportRequest {
    pub view: u32,
    pub range: ExportRange,
    pub format: ExportFormat,
    /// Column ids (prompt 008/009) for CSV and JSON Lines; empty: line, level and text.
    pub columns: Vec<String>,
    pub target: PathBuf,
}

/// Checks the target before anything is written: an absolute path without `..`, a file name with an
/// extension of the format, an existing folder, no folder of that name.
pub fn validate_target(target: &Path, format: ExportFormat) -> AppResult<PathBuf> {
    let invalid = |message: &str| {
        let mut err = AppError::new(ErrorCode::InvalidExport, message);
        err.path = Some(target.display().to_string());
        err
    };
    if !target.is_absolute() {
        return Err(invalid("the target must be an absolute path"));
    }
    if target
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(invalid("the target must not contain . or .."));
    }
    let Some(name) = target.file_name().and_then(|n| n.to_str()) else {
        return Err(invalid("the target has no file name"));
    };
    let extension = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !format.extensions().contains(&extension.as_str()) {
        return Err(invalid(&format!(
            "the file name must end in .{}",
            format.extensions()[0]
        )));
    }
    let parent = target.parent().ok_or_else(|| invalid("no folder"))?;
    if !parent.is_dir() {
        return Err(
            AppError::new(ErrorCode::NotFound, "the folder does not exist").with_path(parent),
        );
    }
    if target.is_dir() {
        return Err(
            AppError::new(ErrorCode::IsADirectory, "the target is a folder").with_path(target),
        );
    }
    Ok(target.to_path_buf())
}

/// The target must not be a file the session reads: not by path (also a deleted one the tail waits
/// for) and not by identity (a hard link, a symlink, a rotated file).
pub fn check_not_source(target: &Path, session: &LogSession) -> AppResult<()> {
    let refuse = || {
        AppError::new(
            ErrorCode::InvalidExport,
            "the target is the open log file itself",
        )
        .with_path(target)
    };
    let canonical = |p: &Path| -> PathBuf {
        // A missing file: its folder canonical, the name as it is.
        std::fs::canonicalize(p).unwrap_or_else(|_| {
            match (
                p.parent().and_then(|d| std::fs::canonicalize(d).ok()),
                p.file_name(),
            ) {
                (Some(dir), Some(name)) => dir.join(name),
                _ => p.to_path_buf(),
            }
        })
    };
    let target_canonical = canonical(target);
    for path in session.paths() {
        if same_name(&canonical(&path), &target_canonical) {
            return Err(refuse());
        }
    }
    if let Ok(id) = crate::platform::file_id(target) {
        if session.open_file_ids().contains(&id) {
            return Err(refuse());
        }
    }
    Ok(())
}

/// Paths compared as the platform does: case-insensitive on Windows and macOS (default file systems).
fn same_name(a: &Path, b: &Path) -> bool {
    if cfg!(any(windows, target_os = "macos")) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// The temporary file next to the target: hidden, unique for this process and job.
pub fn temp_path(target: &Path, job: u64) -> PathBuf {
    let name = target
        .file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    target.with_file_name(format!(".{name}.{}-{job}.part", std::process::id()))
}

/// Removes the temporary file unless the export got through.
struct TempFile {
    path: PathBuf,
    keep: bool,
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Exports that may run at the same time; each reads the whole range and writes up to gigabytes.
pub const MAX_PARALLEL_EXPORTS: usize = 2;

struct RunningExport {
    cancel: Arc<AtomicBool>,
    /// Its temporary file, removed when the app quits during the export.
    temp: PathBuf,
}

/// Running exports by job id, for cancelling and for cleaning up when the app quits.
#[derive(Default)]
pub struct ExportJobs {
    next: AtomicU64,
    running: Mutex<HashMap<u64, RunningExport>>,
}

impl ExportJobs {
    /// A new job id and its cancel flag for an export to `target`; refused while
    /// `MAX_PARALLEL_EXPORTS` run.
    pub fn start(&self, target: &Path) -> AppResult<(u64, Arc<AtomicBool>)> {
        let mut running = self.running.lock();
        if running.len() >= MAX_PARALLEL_EXPORTS {
            return Err(AppError::new(
                ErrorCode::TooLarge,
                format!("at most {MAX_PARALLEL_EXPORTS} exports at a time"),
            ));
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let cancel = Arc::new(AtomicBool::new(false));
        running.insert(
            id,
            RunningExport {
                cancel: Arc::clone(&cancel),
                temp: temp_path(target, id),
            },
        );
        Ok((id, cancel))
    }

    pub fn finish(&self, id: u64) {
        self.running.lock().remove(&id);
    }

    /// Asks a running export to stop; it removes its file. False if there is no such job (any more).
    pub fn cancel(&self, id: u64) -> bool {
        match self.running.lock().get(&id) {
            Some(job) => {
                job.cancel.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// The app quits: every export stops and its temporary file goes (the job thread may not get
    /// to it before the process ends). A crash can still leave a hidden `.part` next to the target.
    pub fn shutdown(&self) {
        let running = std::mem::take(&mut *self.running.lock());
        for job in running.values() {
            job.cancel.store(true, Ordering::SeqCst);
            let _ = std::fs::remove_file(&job.temp);
        }
    }
}

/// Writes the export and reports on the way. Returns the final progress (done or cancelled); an
/// error leaves no file either.
pub fn run_export(
    session: &LogSession,
    request: &ExportRequest,
    job: u64,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(&ExportProgress),
) -> AppResult<ExportProgress> {
    let target = validate_target(&request.target, request.format)?;
    check_not_source(&target, session)?;
    if request.columns.len() > MAX_COLUMNS {
        return Err(AppError::new(ErrorCode::InvalidExport, "too many columns"));
    }
    let (view, lines) = match request.range {
        ExportRange::Selection { first, last } => (Some(request.view), Some((first, last))),
        ExportRange::View => (Some(request.view), None),
        ExportRange::All => (None, None),
    };
    let mut cursor = session.export_cursor(view, lines)?;
    let mut progress = ExportProgress {
        job_id: job,
        state: ExportState::Running,
        lines: 0,
        total: cursor.total,
        bytes: 0,
        path: target.display().to_string(),
        error: None,
    };
    let temp = TempFile {
        path: temp_path(&target, job),
        keep: false,
    };
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp.path)
        .map_err(|e| AppError::from_io(&e, &temp.path))?;
    let io_err = |e: std::io::Error| AppError::from_io(&e, &target);
    let mut out = RowWriter::new(
        BufWriter::with_capacity(WRITE_BUFFER, file),
        request.format,
        &request.columns,
        session.source_names(),
    );
    out.header().map_err(io_err)?;
    on_progress(&progress);
    let mut last_report = Instant::now();
    // The reader and the number of segments it knows (a rotation adds one on the way).
    let mut reader: Option<(LineReader, usize)> = None;
    while let Some(batch) = session.export_batch(&mut cursor, EXPORT_BATCH)? {
        if reader
            .as_ref()
            .is_none_or(|(_, known)| *known != batch.segments.len())
        {
            reader = Some((
                LineReader::new(batch.segments.clone(), READ_BLOCK),
                batch.segments.len(),
            ));
        }
        let Some((reader, _)) = reader.as_mut() else {
            break;
        };
        out.use_format(&batch.format);
        for (i, (line, entry)) in batch.lines.iter().enumerate() {
            if i % 1024 == 0 && cancel.load(Ordering::Relaxed) {
                progress.state = ExportState::Cancelled;
                on_progress(&progress);
                return Ok(progress);
            }
            let (raw, encoding) = reader
                .raw(entry, MAX_LINE_BYTES)
                .map_err(|e| AppError::from_io(&e, &session.path))?;
            let text = display_text(raw, encoding);
            out.row(
                *line,
                entry.level(),
                entry.source(),
                entry.is_continuation(),
                &text,
            )
            .map_err(io_err)?;
            progress.lines += 1;
        }
        if last_report.elapsed() >= PROGRESS_INTERVAL {
            progress.bytes = out.written;
            progress.total = progress.total.max(progress.lines);
            on_progress(&progress);
            last_report = Instant::now();
        }
    }
    if cancel.load(Ordering::Relaxed) {
        progress.state = ExportState::Cancelled;
        on_progress(&progress);
        return Ok(progress);
    }
    let file = out.finish().map_err(io_err)?;
    file.sync_all().map_err(io_err)?;
    drop(file);
    std::fs::rename(&temp.path, &target).map_err(io_err)?;
    let mut temp = temp;
    temp.keep = true;
    progress.state = ExportState::Done;
    progress.total = progress.lines;
    on_progress(&progress);
    Ok(progress)
}

fn level_name(level: Level) -> &'static str {
    match level {
        Level::Unknown => "UNKNOWN",
        Level::Trace => "TRACE",
        Level::Debug => "DEBUG",
        Level::Info => "INFO",
        Level::Warn => "WARN",
        Level::Error => "ERROR",
        Level::Fatal => "FATAL",
    }
}

/// Writes rows in one format; counts the bytes.
struct RowWriter {
    out: BufWriter<File>,
    format: ExportFormat,
    /// Requested column ids, and their keys in JSON Lines (renamed where they collide with ours).
    columns: Vec<String>,
    keys: Vec<String>,
    /// Index of each requested column in the current format, per format (by pointer).
    mapping: Vec<Option<usize>>,
    format_ptr: usize,
    parser: Option<Arc<FormatGuess>>,
    sources: Vec<String>,
    written: u64,
    line_buf: String,
}

impl RowWriter {
    fn new(
        out: BufWriter<File>,
        format: ExportFormat,
        columns: &[String],
        sources: Vec<String>,
    ) -> Self {
        let columns = if format == ExportFormat::Txt {
            Vec::new()
        } else {
            columns.to_vec()
        };
        let keys = columns
            .iter()
            .map(|id| match id.as_str() {
                "line" | "level" | "file" | "text" => format!("{id}_field"),
                _ => id.clone(),
            })
            .collect();
        Self {
            out,
            format,
            columns,
            keys,
            mapping: Vec::new(),
            format_ptr: 0,
            parser: None,
            sources,
            written: 0,
            line_buf: String::new(),
        }
    }

    fn use_format(&mut self, format: &Arc<FormatGuess>) {
        let ptr = Arc::as_ptr(format) as usize;
        if ptr == self.format_ptr {
            return;
        }
        self.format_ptr = ptr;
        let available = format.parser.columns();
        self.mapping = self
            .columns
            .iter()
            .map(|id| available.iter().position(|c| &c.id == id))
            .collect();
        self.parser = Some(Arc::clone(format));
    }

    fn put(&mut self, text: &str) -> std::io::Result<()> {
        self.written += text.len() as u64;
        self.out.write_all(text.as_bytes())
    }

    fn header(&mut self) -> std::io::Result<()> {
        if self.format != ExportFormat::Csv {
            return Ok(());
        }
        // A BOM so spreadsheet programs read UTF-8 (umlauts) as such.
        let mut row = String::from("\u{feff}");
        let mut names: Vec<String> = vec!["line".into()];
        if !self.sources.is_empty() {
            names.push("file".into());
        }
        names.push("level".into());
        if self.columns.is_empty() {
            names.push("text".into());
        } else {
            names.extend(self.columns.iter().cloned());
        }
        push_csv_row(&mut row, names.iter().map(|n| Cow::Borrowed(n.as_str())));
        self.put(&row)
    }

    fn row(
        &mut self,
        line: u32,
        level: Level,
        source: usize,
        continuation: bool,
        text: &str,
    ) -> std::io::Result<()> {
        let mut buf = std::mem::take(&mut self.line_buf);
        buf.clear();
        match self.format {
            ExportFormat::Txt => {
                buf.push_str(text);
                buf.push('\n');
            }
            ExportFormat::Csv => {
                let mut cells: Vec<Cow<str>> = vec![Cow::Owned((line + 1).to_string())];
                if !self.sources.is_empty() {
                    cells.push(Cow::Owned(self.source_name(source)));
                }
                cells.push(Cow::Borrowed(level_name(level)));
                if self.columns.is_empty() {
                    cells.push(Cow::Borrowed(text));
                } else {
                    for value in self.values(text, continuation) {
                        cells.push(Cow::Borrowed(value));
                    }
                }
                push_csv_row(&mut buf, cells.into_iter());
            }
            ExportFormat::Jsonl => {
                use std::fmt::Write as _;
                let _ = write!(buf, "{{\"line\":{}", line + 1);
                if !self.sources.is_empty() {
                    buf.push_str(",\"file\":");
                    push_json_string(&mut buf, &self.source_name(source));
                }
                buf.push_str(",\"level\":\"");
                buf.push_str(level_name(level));
                buf.push('"');
                if self.columns.is_empty() {
                    buf.push_str(",\"text\":");
                    push_json_string(&mut buf, text);
                } else {
                    let values = self.values(text, continuation);
                    for (key, value) in self.keys.iter().zip(values) {
                        buf.push(',');
                        push_json_string(&mut buf, key);
                        buf.push(':');
                        push_json_string(&mut buf, value);
                    }
                }
                buf.push_str("}\n");
            }
        }
        let result = self.put(&buf);
        self.line_buf = buf;
        result
    }

    fn source_name(&self, source: usize) -> String {
        self.sources.get(source).cloned().unwrap_or_default()
    }

    /// The text of each requested column; a continuation (stack trace) is all message.
    fn values<'t>(&self, text: &'t str, continuation: bool) -> Vec<&'t str> {
        let Some(format) = &self.parser else {
            return vec![""; self.columns.len()];
        };
        let parser = &format.parser;
        let spans = if continuation {
            parser.whole_line(text)
        } else {
            parser.parse(text, false)
        };
        let ranges = utf16_spans_to_bytes(text, &spans);
        self.mapping
            .iter()
            .map(|index| {
                index
                    .and_then(|i| ranges.get(i).copied())
                    .map_or("", |(a, b)| &text[a..b])
            })
            .collect()
    }

    fn finish(self) -> std::io::Result<File> {
        self.out.into_inner().map_err(|e| e.into_error())
    }
}

/// Byte ranges of spans given in UTF-16 code units (as `FieldParser` gives them to the frontend).
pub fn utf16_spans_to_bytes(text: &str, spans: &[[u32; 2]]) -> Vec<(usize, usize)> {
    let mut points: Vec<(u32, usize)> = Vec::with_capacity(spans.len() * 2);
    for (i, span) in spans.iter().enumerate() {
        points.push((span[0], i * 2));
        points.push((span[1].max(span[0]), i * 2 + 1));
    }
    points.sort_unstable();
    let mut bytes = vec![text.len(); spans.len() * 2];
    let mut units = 0u32;
    let mut chars = text.char_indices();
    for (target, slot) in points {
        while units < target {
            match chars.next() {
                Some((_, c)) => units += c.len_utf16() as u32,
                None => break,
            }
        }
        // The byte offset of the next character, or the end.
        bytes[slot] = chars.clone().next().map_or(text.len(), |(i, _)| i);
    }
    (0..spans.len())
        .map(|i| {
            let a = bytes[i * 2].min(text.len());
            let b = bytes[i * 2 + 1].clamp(a, text.len());
            (a, b)
        })
        .collect()
}

/// One CSV row (RFC 4180): every field in quotes, quotes doubled, `\r\n` at the end.
fn push_csv_row<'a>(out: &mut String, cells: impl Iterator<Item = Cow<'a, str>>) {
    for (i, cell) in cells.enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('"');
        let cell = guard_formula(&cell);
        if cell.contains('"') {
            out.push_str(&cell.replace('"', "\"\""));
        } else {
            out.push_str(&cell);
        }
        out.push('"');
    }
    out.push_str("\r\n");
}

/// A cell a spreadsheet would run as a formula (`=`, `+`, `-`, `@`, tab, CR at the start) gets a `'`
/// in front (CSV injection, OWASP); a plain number such as `-12.5` stays as it is.
pub fn guard_formula(cell: &str) -> Cow<'_, str> {
    let risky = matches!(
        cell.chars().next(),
        Some('=' | '+' | '-' | '@' | '\t' | '\r')
    );
    if risky && !is_plain_number(cell) {
        Cow::Owned(format!("'{cell}"))
    } else {
        Cow::Borrowed(cell)
    }
}

fn is_plain_number(cell: &str) -> bool {
    let body = cell.strip_prefix(['+', '-']).unwrap_or(cell);
    let mut digits = 0;
    let mut separators = 0;
    for c in body.chars() {
        match c {
            '0'..='9' => digits += 1,
            '.' | ',' => separators += 1,
            _ => return false,
        }
    }
    digits > 0 && separators <= 1
}

fn push_json_string(out: &mut String, text: &str) {
    // serde_json escapes control characters, quotes and backslashes; it cannot fail on a `str`.
    out.push_str(&serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into()));
}

trait WithPath {
    fn with_path(self, path: &Path) -> Self;
}

impl WithPath for AppError {
    fn with_path(mut self, path: &Path) -> Self {
        self.path = Some(path.display().to_string());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formulas_are_guarded_numbers_are_not() {
        assert_eq!(guard_formula("=1+1"), "'=1+1");
        assert_eq!(guard_formula("+cmd"), "'+cmd");
        assert_eq!(guard_formula("-2+3"), "'-2+3");
        assert_eq!(guard_formula("@SUM(A1)"), "'@SUM(A1)");
        assert_eq!(guard_formula("\tx"), "'\tx");
        assert_eq!(guard_formula("-12.5"), "-12.5");
        assert_eq!(guard_formula("+3,5"), "+3,5");
        assert_eq!(guard_formula("plain"), "plain");
        assert_eq!(guard_formula("-"), "'-");
    }

    #[test]
    fn csv_rows_quote_everything() {
        let mut row = String::new();
        push_csv_row(
            &mut row,
            ["a\"b", "c,d", "=x"].into_iter().map(Cow::Borrowed),
        );
        assert_eq!(row, "\"a\"\"b\",\"c,d\",\"'=x\"\r\n");
    }

    #[test]
    fn utf16_spans_map_to_bytes() {
        let text = "ä😀b c";
        // ä = 1 unit, 😀 = 2 units, b = 1, space, c.
        let ranges = utf16_spans_to_bytes(text, &[[0, 1], [1, 3], [3, 4], [5, 6], [0, 99]]);
        let parts: Vec<&str> = ranges.iter().map(|&(a, b)| &text[a..b]).collect();
        assert_eq!(parts, vec!["ä", "😀", "b", "c", "ä😀b c"]);
    }

    #[test]
    fn exports_are_limited_and_cleaned_up_on_quit() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.txt");
        let jobs = ExportJobs::default();
        let (a, cancel_a) = jobs.start(&target).unwrap();
        let (_b, _) = jobs.start(&target).unwrap();
        assert_eq!(jobs.start(&target).unwrap_err().code, ErrorCode::TooLarge);
        jobs.finish(a);
        let (c, cancel_c) = jobs.start(&target).unwrap();
        let temp = temp_path(&target, c);
        std::fs::write(&temp, "half").unwrap();
        jobs.shutdown();
        assert!(cancel_c.load(Ordering::SeqCst));
        assert!(!cancel_a.load(Ordering::SeqCst));
        assert!(!temp.exists());
        assert!(!jobs.cancel(c));
    }

    #[test]
    fn targets_are_checked() {
        let dir = tempfile::tempdir().unwrap();
        let ok = dir.path().join("out.csv");
        assert!(validate_target(&ok, ExportFormat::Csv).is_ok());
        assert!(validate_target(&dir.path().join("OUT.CSV"), ExportFormat::Csv).is_ok());
        let wrong = validate_target(&dir.path().join("out.sh"), ExportFormat::Csv).unwrap_err();
        assert_eq!(wrong.code, ErrorCode::InvalidExport);
        let relative = validate_target(Path::new("out.csv"), ExportFormat::Csv).unwrap_err();
        assert_eq!(relative.code, ErrorCode::InvalidExport);
        let traversal = dir.path().join("a").join("..").join("out.csv");
        assert_eq!(
            validate_target(&traversal, ExportFormat::Csv)
                .unwrap_err()
                .code,
            ErrorCode::InvalidExport
        );
        let missing = dir.path().join("nope").join("out.txt");
        assert_eq!(
            validate_target(&missing, ExportFormat::Txt)
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        std::fs::create_dir(dir.path().join("x.jsonl")).unwrap();
        assert_eq!(
            validate_target(&dir.path().join("x.jsonl"), ExportFormat::Jsonl)
                .unwrap_err()
                .code,
            ErrorCode::IsADirectory
        );
    }
}
