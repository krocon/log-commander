//! The user's query (prompt 019): checked to be one `SELECT` without anything that writes, then
//! wrapped per dialect, so the app adds the key condition, the order and the batch limit:
//!
//! ```sql
//! SELECT * FROM (<query>) lc WHERE lc."id" >= $1 ORDER BY lc."id" LIMIT 10001
//! ```
//!
//! The check is the first wall, not the only one: every database also runs the query read-only
//! (`database/mod.rs`). It tokenizes like the dialect does (strings, quoted names, comments, dollar
//! quotes, `#` comments in MySQL), so a `;` or a keyword inside a string is not mistaken for one
//! outside, and a hidden one outside is found.

use crate::error::{AppError, AppResult, ErrorCode};

/// Longer queries are refused.
pub const MAX_QUERY_BYTES: usize = 64 * 1024;
/// Alias of the wrapped query.
pub const ALIAS: &str = "lc";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Dialect {
    Postgres,
    /// MySQL and MariaDB.
    Mysql,
    /// SQL Server.
    Mssql,
    Sqlite,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidQuery, message)
}

/// Words that never belong into a reading query (anywhere outside strings and quoted names).
/// `INTO` covers `SELECT … INTO table/OUTFILE`, `UPDATE` covers `FOR UPDATE`, `DELETE`/`INSERT`/
/// `UPDATE`/`MERGE` data-modifying CTEs. SQL Server runs statements separated by whitespace alone, so
/// statement words are refused too. Words that are common column names in log tables (`comment`,
/// `handler`, `load`) are not listed: they cannot start a statement inside the wrapped subquery.
const FORBIDDEN: &[&str] = &[
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "UPSERT",
    "DROP",
    "ALTER",
    "CREATE",
    "TRUNCATE",
    "GRANT",
    "REVOKE",
    "EXEC",
    "EXECUTE",
    "DO",
    "INTO",
    "COPY",
    "ATTACH",
    "DETACH",
    "PRAGMA",
    "VACUUM",
    "REINDEX",
    "ANALYZE",
    "LOCK",
    "UNLOCK",
    "SHUTDOWN",
    "KILL",
    "BACKUP",
    "RESTORE",
    "DBCC",
    "WAITFOR",
    "OPENROWSET",
    "OPENQUERY",
    "OPENDATASOURCE",
    "OPENXML",
    "BULK",
    "DECLARE",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT",
    "BEGIN",
    "LISTEN",
    "NOTIFY",
    "PREPARE",
    "DEALLOCATE",
    "DISCARD",
    "REFRESH",
    "CLUSTER",
    "USE",
    "GO",
    // Writing files on the server (MySQL `SELECT … INTO OUTFILE/DUMPFILE`, also with `INTO`).
    "OUTFILE",
    "DUMPFILE",
];

/// Functions with effects beyond reading the query's rows (files, other sessions, locks,
/// connections to elsewhere). Not exhaustive: a read-only database account is the real safeguard.
const FORBIDDEN_FUNCTIONS: &[&str] = &[
    "LOAD_FILE",
    "GET_LOCK",
    "RELEASE_LOCK",
    "RELEASE_ALL_LOCKS",
    "SYS_EXEC",
    "SYS_EVAL",
    "LO_EXPORT",
    "LO_IMPORT",
    "LO_UNLINK",
    "LO_CREATE",
    "LO_PUT",
    "LO_FROM_BYTEA",
    "PG_READ_FILE",
    "PG_READ_BINARY_FILE",
    "PG_LS_DIR",
    "PG_STAT_FILE",
    "PG_TERMINATE_BACKEND",
    "PG_CANCEL_BACKEND",
    "PG_RELOAD_CONF",
    "PG_ROTATE_LOGFILE",
    "PG_PROMOTE",
    "PG_NOTIFY",
    "SET_CONFIG",
    "DBLINK",
    "DBLINK_EXEC",
    "DBLINK_CONNECT",
    "DBLINK_SEND_QUERY",
    "PG_ADVISORY_LOCK",
    "PG_ADVISORY_LOCK_SHARED",
    "PG_ADVISORY_XACT_LOCK",
    "PG_ADVISORY_XACT_LOCK_SHARED",
    "PG_TRY_ADVISORY_LOCK",
    "PG_TRY_ADVISORY_XACT_LOCK",
    "XP_CMDSHELL",
    "XP_DIRTREE",
    "XP_FILEEXIST",
    "XP_REGREAD",
    "FN_XE_FILE_TARGET_READ_FILE",
    "FN_GET_AUDIT_FILE",
    "FN_TRACE_GETTABLE",
    "READFILE",
    "WRITEFILE",
    "LOAD_EXTENSION",
    "FTS3_TOKENIZER",
];

/// What the tokenizer sees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
    /// A bare word (keyword or name), as written.
    Word(String),
    /// A quoted name, unquoted.
    Quoted(String),
    /// A string literal (content not kept).
    Str,
    /// A number or other literal piece.
    Literal,
    Symbol(char),
}

/// Splits `sql` like the dialect does. Unterminated strings, names and comments are an error.
pub fn tokenize(sql: &str, dialect: Dialect) -> AppResult<Vec<Token>> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    let n = chars.len();
    let at = |i: usize| chars.get(i).copied();
    while i < n {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        // Comments. In MySQL `--` starts one only before whitespace, a control character or the end
        // (`--1` is `- -1`), and `#` anywhere, also right after a word (`x#`).
        let dash_comment = c == '-'
            && at(i + 1) == Some('-')
            && (dialect != Dialect::Mysql
                || at(i + 2).is_none_or(|n| n.is_whitespace() || n.is_control()));
        if dash_comment || c == '#' && dialect == Dialect::Mysql {
            while i < n && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && at(i + 1) == Some('*') {
            // MySQL runs the inside of `/*! … */` and `/*M! … */`: refused, not skipped.
            if dialect == Dialect::Mysql && matches!(at(i + 2), Some('!') | Some('M')) {
                return Err(invalid("MySQL-Kommentare mit /*! … */ sind nicht erlaubt"));
            }
            let nested = matches!(dialect, Dialect::Postgres | Dialect::Mssql);
            let mut depth = 1;
            i += 2;
            while depth > 0 {
                if i >= n {
                    return Err(invalid("Kommentar /* ohne Ende"));
                }
                if chars[i] == '*' && at(i + 1) == Some('/') {
                    depth -= 1;
                    i += 2;
                } else if nested && chars[i] == '/' && at(i + 1) == Some('*') {
                    depth += 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        // Strings: '…' everywhere, N'…' (SQL Server), E'…' (PostgreSQL, backslash escapes),
        // backslash escapes always in MySQL.
        let prefixed = matches!(c, 'N' | 'n' | 'E' | 'e' | 'X' | 'x' | 'B' | 'b')
            && at(i + 1) == Some('\'')
            && (i == 0 || !is_word_char(chars[i - 1], dialect));
        if c == '\'' || prefixed {
            let backslash = dialect == Dialect::Mysql
                || (dialect == Dialect::Postgres && prefixed && matches!(c, 'E' | 'e'));
            i += if prefixed { 2 } else { 1 };
            loop {
                if i >= n {
                    return Err(invalid("Text in ' ohne Ende"));
                }
                if backslash && chars[i] == '\\' {
                    i += 2;
                    continue;
                }
                if chars[i] == '\'' {
                    if at(i + 1) == Some('\'') {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            out.push(Token::Str);
            continue;
        }
        // MySQL also takes "…" as a string (unless ANSI_QUOTES); a name elsewhere.
        if c == '"' || c == '`' || (c == '[' && matches!(dialect, Dialect::Mssql | Dialect::Sqlite))
        {
            if c == '`' && !matches!(dialect, Dialect::Mysql | Dialect::Sqlite) {
                return Err(invalid("` ist hier kein Anführungszeichen"));
            }
            let close = if c == '[' { ']' } else { c };
            let backslash = dialect == Dialect::Mysql && c == '"';
            let mut name = String::new();
            i += 1;
            loop {
                if i >= n {
                    return Err(invalid(format!("{c} ohne Ende")));
                }
                if backslash && chars[i] == '\\' {
                    if let Some(next) = at(i + 1) {
                        name.push(next);
                    }
                    i += 2;
                    continue;
                }
                if chars[i] == close {
                    if at(i + 1) == Some(close) {
                        name.push(close);
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                name.push(chars[i]);
                i += 1;
            }
            out.push(if dialect == Dialect::Mysql && c == '"' {
                Token::Str
            } else {
                Token::Quoted(name)
            });
            continue;
        }
        // PostgreSQL dollar quotes: $$…$$, $tag$…$tag$ ($1 is a parameter).
        if c == '$' && dialect == Dialect::Postgres {
            let mut j = i + 1;
            while j < n && (chars[j].is_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            if j < n && chars[j] == '$' && !chars.get(i + 1).is_some_and(char::is_ascii_digit) {
                let tag: String = chars[i..=j].iter().collect();
                let tag: Vec<char> = tag.chars().collect();
                let mut k = j + 1;
                loop {
                    if k + tag.len() > n {
                        return Err(invalid("$-Text ohne Ende"));
                    }
                    if chars[k..k + tag.len()] == tag[..] {
                        k += tag.len();
                        break;
                    }
                    k += 1;
                }
                i = k;
                out.push(Token::Str);
                continue;
            }
        }
        if is_word_start(c, dialect) {
            let start = i;
            while i < n && is_word_char(chars[i], dialect) {
                i += 1;
            }
            out.push(Token::Word(chars[start..i].iter().collect()));
            continue;
        }
        if c.is_ascii_digit() {
            // Digits, a fraction, an exponent or a hex/binary number; letters right after it start
            // a word of their own (so `1INTO` still shows `INTO`).
            if c == '0' && matches!(at(i + 1), Some('x' | 'X' | 'b' | 'B')) {
                i += 2;
                while i < n && chars[i].is_ascii_hexdigit() {
                    i += 1;
                }
            } else {
                while i < n && (chars[i].is_ascii_digit() || chars[i] == '.') {
                    i += 1;
                }
                if matches!(at(i), Some('e' | 'E')) {
                    let sign = usize::from(matches!(at(i + 1), Some('+' | '-')));
                    if at(i + 1 + sign).is_some_and(|d| d.is_ascii_digit()) {
                        i += 1 + sign;
                        while i < n && chars[i].is_ascii_digit() {
                            i += 1;
                        }
                    }
                }
            }
            out.push(Token::Literal);
            continue;
        }
        out.push(Token::Symbol(c));
        i += 1;
    }
    Ok(out)
}

/// PostgreSQL, MySQL and SQLite take every non-ASCII character as part of a name; `#` is a
/// comment in MySQL and an operator in PostgreSQL, a temp-table prefix only in SQL Server.
fn is_word_start(c: char, dialect: Dialect) -> bool {
    match dialect {
        Dialect::Mssql => c.is_alphabetic() || matches!(c, '_' | '@' | '#'),
        Dialect::Mysql => c.is_ascii_alphabetic() || !c.is_ascii() || matches!(c, '_' | '@'),
        Dialect::Postgres | Dialect::Sqlite => c.is_ascii_alphabetic() || !c.is_ascii() || c == '_',
    }
}

fn is_word_char(c: char, dialect: Dialect) -> bool {
    is_word_start(c, dialect) || c.is_ascii_digit() || c == '$'
}

fn word_is(t: &Token, w: &str) -> bool {
    matches!(t, Token::Word(x) if x.eq_ignore_ascii_case(w))
}

/// The query, checked: one `SELECT` (or `WITH … SELECT`), no forbidden word, no `;` in between,
/// no `ORDER BY`/`LIMIT` at the top (the app orders and limits). Returns it without a final `;`.
pub fn check_select(sql: &str, dialect: Dialect) -> AppResult<String> {
    if sql.len() > MAX_QUERY_BYTES {
        return Err(invalid(format!(
            "Abfrage länger als {} KB",
            MAX_QUERY_BYTES / 1024
        )));
    }
    if sql.contains('\0') {
        return Err(invalid("Abfrage enthält ein NUL-Zeichen"));
    }
    let trimmed = sql
        .trim()
        .trim_end_matches(|c: char| c == ';' || c.is_whitespace());
    let tokens = tokenize(trimmed, dialect)?;
    let Some(first) = tokens.first() else {
        return Err(invalid("Abfrage fehlt"));
    };
    if !word_is(first, "SELECT") && !word_is(first, "WITH") {
        return Err(invalid("Nur SELECT-Abfragen sind erlaubt"));
    }
    let mut depth: i32 = 0;
    for (k, t) in tokens.iter().enumerate() {
        match t {
            Token::Symbol(';') => {
                return Err(invalid("Nur eine Anweisung ist erlaubt (; gefunden)"))
            }
            Token::Symbol('(') => depth += 1,
            Token::Symbol(')') => {
                depth -= 1;
                if depth < 0 {
                    return Err(invalid("Klammer ) ohne ("));
                }
            }
            // `"pg_read_file"(…)`, `[xp_cmdshell]`: a quoted name is still a function.
            Token::Quoted(w) if FORBIDDEN_FUNCTIONS.contains(&w.to_ascii_uppercase().as_str()) => {
                return Err(invalid(format!(
                    "Die Funktion „{}“ ist in der Abfrage nicht erlaubt",
                    w.to_lowercase()
                )));
            }
            Token::Word(w) => {
                let upper = w.to_ascii_uppercase();
                if FORBIDDEN.contains(&upper.as_str()) {
                    return Err(invalid(format!(
                        "„{upper}“ ist in der Abfrage nicht erlaubt"
                    )));
                }
                if FORBIDDEN_FUNCTIONS.contains(&upper.as_str()) {
                    return Err(invalid(format!(
                        "Die Funktion „{}“ ist in der Abfrage nicht erlaubt",
                        w.to_lowercase()
                    )));
                }
                // Sequences move on even when rolled back (SQL Server).
                if upper == "NEXT" && tokens.get(k + 1).is_some_and(|t| word_is(t, "VALUE")) {
                    return Err(invalid("„NEXT VALUE FOR“ ist nicht erlaubt"));
                }
                if depth == 0 {
                    let next = tokens.get(k + 1);
                    if upper == "ORDER" && next.is_some_and(|t| word_is(t, "BY")) {
                        return Err(invalid(
                            "ORDER BY weglassen: die App sortiert nach der Schlüsselspalte",
                        ));
                    }
                    if matches!(upper.as_str(), "LIMIT" | "OFFSET" | "FETCH") {
                        return Err(invalid(format!(
                            "{upper} weglassen: die App holt in Stapeln ab dem letzten Schlüssel"
                        )));
                    }
                }
                if upper == "TOP" && depth == 0 && dialect == Dialect::Mssql {
                    return Err(invalid("TOP weglassen: die App holt in Stapeln"));
                }
            }
            _ => {}
        }
    }
    if depth != 0 {
        return Err(invalid("Klammer ( ohne )"));
    }
    Ok(trimmed.to_string())
}

/// `"name"` (PostgreSQL, SQLite), `` `name` `` (MySQL), `[name]` (SQL Server), quotes doubled.
pub fn quote_ident(name: &str, dialect: Dialect) -> String {
    match dialect {
        Dialect::Mysql => format!("`{}`", name.replace('`', "``")),
        Dialect::Mssql => format!("[{}]", name.replace(']', "]]")),
        Dialect::Postgres | Dialect::Sqlite => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// The parameter for the key: `$1`, `?`, `@P1`, `?1`.
fn param(dialect: Dialect) -> &'static str {
    match dialect {
        Dialect::Postgres => "$1",
        Dialect::Mysql => "?",
        Dialect::Mssql => "@P1",
        Dialect::Sqlite => "?1",
    }
}

/// How rows are asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bound {
    /// From the start.
    None,
    /// `key >= ?` (the rows at the edge are filtered out afterwards).
    AtLeast,
    /// `key > ?` (only when the edge got too large).
    After,
}

/// No rows, only the columns: `… WHERE 1 = 0`.
pub fn probe_sql(query: &str) -> String {
    format!("SELECT * FROM ({query}) {ALIAS} WHERE 1 = 0")
}

/// The first `limit` rows of the query as it is (the preview).
pub fn preview_sql(query: &str, dialect: Dialect, limit: u32) -> String {
    match dialect {
        Dialect::Mssql => format!("SELECT TOP ({limit}) * FROM ({query}) {ALIAS}"),
        _ => format!("SELECT * FROM ({query}) {ALIAS} LIMIT {limit}"),
    }
}

/// A batch in key order. Rows whose key is NULL never come (no comparison holds for NULL).
pub fn batch_sql(query: &str, key: &str, dialect: Dialect, bound: Bound, limit: u32) -> String {
    let k = format!("{ALIAS}.{}", quote_ident(key, dialect));
    let cond = match bound {
        Bound::None => format!("{k} IS NOT NULL"),
        Bound::AtLeast => format!("{k} >= {}", param(dialect)),
        Bound::After => format!("{k} > {}", param(dialect)),
    };
    match dialect {
        Dialect::Mssql => {
            format!("SELECT TOP ({limit}) * FROM ({query}) {ALIAS} WHERE {cond} ORDER BY {k}")
        }
        _ => format!("SELECT * FROM ({query}) {ALIAS} WHERE {cond} ORDER BY {k} LIMIT {limit}"),
    }
}

/// The key of the n-th newest row (start „letzte N“); no row: fewer rows than that.
pub fn nth_newest_sql(query: &str, key: &str, dialect: Dialect, n: u32) -> String {
    let k = format!("{ALIAS}.{}", quote_ident(key, dialect));
    let skip = n.saturating_sub(1);
    match dialect {
        Dialect::Mssql => format!(
            "SELECT {k} FROM ({query}) {ALIAS} WHERE {k} IS NOT NULL ORDER BY {k} DESC \
             OFFSET {skip} ROWS FETCH NEXT 1 ROWS ONLY"
        ),
        _ => format!(
            "SELECT {k} FROM ({query}) {ALIAS} WHERE {k} IS NOT NULL ORDER BY {k} DESC \
             LIMIT 1 OFFSET {skip}"
        ),
    }
}

/// The query of „Tabelle wählen“: `SELECT * FROM "schema"."table"`.
pub fn table_query(schema: Option<&str>, table: &str, dialect: Dialect) -> String {
    match schema.filter(|s| !s.is_empty()) {
        Some(s) => format!(
            "SELECT * FROM {}.{}",
            quote_ident(s, dialect),
            quote_ident(table, dialect)
        ),
        None => format!("SELECT * FROM {}", quote_ident(table, dialect)),
    }
}

/// The table after the first top-level `FROM` (`schema.table`), for the tab's name.
pub fn table_of(query: &str, dialect: Dialect) -> Option<String> {
    let tokens = tokenize(query, dialect).ok()?;
    let mut depth = 0;
    let mut k = 0;
    while k < tokens.len() {
        match &tokens[k] {
            Token::Symbol('(') => depth += 1,
            Token::Symbol(')') => depth -= 1,
            t if depth == 0 && word_is(t, "FROM") => {
                let mut parts = Vec::new();
                let mut j = k + 1;
                while let Some(Token::Word(w)) | Some(Token::Quoted(w)) = tokens.get(j) {
                    parts.push(w.clone());
                    if tokens.get(j + 1) == Some(&Token::Symbol('.')) {
                        j += 2;
                    } else {
                        break;
                    }
                }
                return (!parts.is_empty()).then(|| parts.join("."));
            }
            _ => {}
        }
        k += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Dialect; 4] = [
        Dialect::Postgres,
        Dialect::Mysql,
        Dialect::Mssql,
        Dialect::Sqlite,
    ];

    fn ok(sql: &str, d: Dialect) -> bool {
        check_select(sql, d).is_ok()
    }

    #[test]
    fn plain_selects_pass() {
        for d in ALL {
            assert!(ok("SELECT * FROM logs", d));
            assert!(ok("  select id, msg from logs where level = 'ERROR';  ", d));
            assert!(ok(
                "WITH x AS (SELECT * FROM logs) SELECT * FROM x WHERE msg LIKE '%; DELETE%'",
                d
            ));
            assert!(ok("SELECT * FROM logs -- ; DROP TABLE logs\n", d));
            assert!(ok("SELECT * FROM logs /* ; delete */ WHERE id > 0", d));
            assert!(ok(
                "SELECT replace(msg, 'a', 'b') AS m FROM (SELECT * FROM logs ORDER BY id LIMIT 5) t",
                d
            ) || d == Dialect::Mssql);
        }
        assert!(ok("SELECT \"update\" FROM logs", Dialect::Postgres));
        assert!(ok("SELECT [delete] FROM logs", Dialect::Mssql));
        assert!(ok("SELECT `into` FROM logs", Dialect::Mysql));
        assert!(ok("SELECT $$; drop$$ AS x FROM logs", Dialect::Postgres));
        assert!(ok("SELECT E'it\\'s; delete' FROM logs", Dialect::Postgres));
        assert!(ok("SELECT 'it\\'s; delete' FROM logs", Dialect::Mysql));
        assert!(ok("SELECT * FROM logs # ; delete", Dialect::Mysql));
        assert!(ok("SELECT N'Grüße 🎉' FROM logs", Dialect::Mssql));
        assert_eq!(
            check_select("SELECT 1 ;; ", Dialect::Sqlite).unwrap(),
            "SELECT 1"
        );
    }

    #[test]
    fn writing_and_more_than_one_statement_are_refused() {
        for d in ALL {
            for bad in [
                "",
                "   ",
                "DELETE FROM logs",
                "UPDATE logs SET x = 1",
                "INSERT INTO logs VALUES (1)",
                "SELECT 1; DELETE FROM logs",
                "SELECT 1; SELECT 2",
                "SELECT * INTO copy FROM logs",
                "SELECT * FROM logs FOR UPDATE",
                "WITH d AS (DELETE FROM logs RETURNING *) SELECT * FROM d",
                "SELECT * FROM logs ORDER BY id",
                "SELECT * FROM logs LIMIT 5",
                "SELECT (1",
                "SELECT 1)",
                "SELECT 'open",
                "SELECT /* open",
                "DROP TABLE logs",
                "EXPLAIN SELECT 1",
                "SHOW TABLES",
                "SELECT 1\0",
            ] {
                assert!(!ok(bad, d), "{d:?}: {bad}");
            }
        }
        // A string ends where the database ends it: a hidden statement after it is found.
        assert!(!ok(
            "SELECT 'a'''; DELETE FROM logs; SELECT ''",
            Dialect::Postgres
        ));
        assert!(!ok("SELECT 'a\\'; DELETE FROM logs", Dialect::Postgres));
        assert!(!ok("SELECT 'a\\\\'; DELETE FROM logs", Dialect::Mysql));
        assert!(!ok("SELECT /* /* */ ; DELETE */ 1", Dialect::Sqlite));
        assert!(!ok("SELECT /*! DELETE FROM logs */ 1", Dialect::Mysql));
        assert!(!ok(
            "SELECT 1 x) y; DELETE FROM logs; SELECT * FROM (SELECT 1",
            Dialect::Mssql
        ));
        assert!(!ok("SELECT NEXT VALUE FOR seq", Dialect::Mssql));
        assert!(!ok("SELECT TOP 5 * FROM logs", Dialect::Mssql));
        assert!(!ok("SELECT * FROM OPENROWSET('x','y','z')", Dialect::Mssql));
        assert!(!ok("SELECT 1 WAITFOR DELAY '00:01'", Dialect::Mssql));
        assert!(!ok(
            &format!("SELECT '{}'", "x".repeat(MAX_QUERY_BYTES)),
            Dialect::Sqlite
        ));
    }

    #[test]
    fn dialect_lexing_finds_breakouts() {
        // Review 019 #1: in MySQL `--1` is `- -1`, not a comment; `x#` starts one.
        let breakout = "SELECT 1 AS id--1) lc INTO OUTFILE '/var/lib/mysql-files/x' #";
        assert!(!ok(breakout, Dialect::Mysql));
        assert!(!ok("SELECT 1 AS id--1) lc #", Dialect::Mysql));
        assert!(ok("SELECT 1 AS id -- 1) lc\n", Dialect::Mysql));
        assert!(ok("SELECT id--1 AS x FROM logs", Dialect::Mysql));
        let hash = tokenize("SELECT x#') lc INTO OUTFILE 'y'\n FROM t", Dialect::Mysql).unwrap();
        assert_eq!(hash.len(), 4, "{hash:?}");
        assert!(ok(
            "SELECT x#') lc INTO OUTFILE 'y'\n FROM t",
            Dialect::Mysql
        ));
        assert!(!ok("SELECT x#'\n) lc INTO OUTFILE 'y'", Dialect::Mysql));
        // `#` is not part of a name in MySQL or PostgreSQL.
        assert!(!ok("SELECT a#b\n) x; DELETE FROM t", Dialect::Mysql));
        assert!(!ok("SELECT 1 # 2) x FOR UPDATE", Dialect::Postgres));
        // Review 019 #4: non-ASCII characters belong to names in PostgreSQL and MySQL.
        assert!(!ok(
            "SELECT 1 AS €$$) lc FOR UPDATE --$$",
            Dialect::Postgres
        ));
        assert!(!ok(
            "SELECT 1 AS é$$) lc FOR UPDATE --$$",
            Dialect::Postgres
        ));
        assert!(ok("SELECT größe, €uro FROM logs", Dialect::Postgres));
        assert!(ok("SELECT größe FROM logs", Dialect::Mysql));
        // Numbers end where letters begin.
        assert!(!ok("SELECT 1INTO x FROM t", Dialect::Mysql));
        assert!(ok("SELECT 1e5, 0x1F, 2.5E-3 FROM t", Dialect::Mysql));
        // Files and other side effects, also as a quoted name.
        for (q, d) in [
            ("SELECT * FROM logs INTO OUTFILE '/tmp/x'", Dialect::Mysql),
            ("SELECT * FROM logs INTO DUMPFILE '/tmp/x'", Dialect::Mysql),
            ("SELECT load_file('/etc/passwd') AS id", Dialect::Mysql),
            ("SELECT GET_LOCK('x', 1) AS id", Dialect::Mysql),
            ("SELECT lo_export(1, '/tmp/x') AS id", Dialect::Postgres),
            ("SELECT \"lo_export\"(1, '/tmp/x') AS id", Dialect::Postgres),
            (
                "SELECT pg_catalog.pg_read_file('x') AS id",
                Dialect::Postgres,
            ),
            ("SELECT pg_terminate_backend(1) AS id", Dialect::Postgres),
            ("SELECT dblink_exec('x', 'y') AS id", Dialect::Postgres),
            ("SELECT pg_advisory_lock(1) AS id", Dialect::Postgres),
            (
                "SELECT set_config('a', 'b', false) AS id",
                Dialect::Postgres,
            ),
            ("SELECT [xp_cmdshell]('dir') AS id", Dialect::Mssql),
        ] {
            assert!(!ok(q, d), "{q}");
        }
    }

    #[test]
    fn wrapped_queries_per_dialect() {
        let q = "SELECT * FROM logs";
        assert_eq!(
            batch_sql(q, "id", Dialect::Postgres, Bound::AtLeast, 10_001),
            "SELECT * FROM (SELECT * FROM logs) lc WHERE lc.\"id\" >= $1 ORDER BY lc.\"id\" LIMIT 10001"
        );
        assert_eq!(
            batch_sql(q, "ts", Dialect::Mysql, Bound::After, 5),
            "SELECT * FROM (SELECT * FROM logs) lc WHERE lc.`ts` > ? ORDER BY lc.`ts` LIMIT 5"
        );
        assert_eq!(
            batch_sql(q, "a]b", Dialect::Mssql, Bound::None, 5),
            "SELECT TOP (5) * FROM (SELECT * FROM logs) lc WHERE lc.[a]]b] IS NOT NULL ORDER BY lc.[a]]b]"
        );
        assert!(batch_sql(q, "x\"y", Dialect::Sqlite, Bound::AtLeast, 1)
            .contains("lc.\"x\"\"y\" >= ?1"));
        assert_eq!(
            nth_newest_sql(q, "id", Dialect::Mssql, 100),
            "SELECT lc.[id] FROM (SELECT * FROM logs) lc WHERE lc.[id] IS NOT NULL ORDER BY lc.[id] DESC OFFSET 99 ROWS FETCH NEXT 1 ROWS ONLY"
        );
        assert!(nth_newest_sql(q, "id", Dialect::Postgres, 1).ends_with("LIMIT 1 OFFSET 0"));
        assert_eq!(
            probe_sql(q),
            "SELECT * FROM (SELECT * FROM logs) lc WHERE 1 = 0"
        );
        assert_eq!(
            preview_sql(q, Dialect::Mssql, 20),
            "SELECT TOP (20) * FROM (SELECT * FROM logs) lc"
        );
        // Every wrapped form is itself a valid single SELECT for the check (as a subquery it would be).
        for d in ALL {
            let wrapped = batch_sql(q, "id", d, Bound::AtLeast, 10);
            assert!(tokenize(&wrapped, d).is_ok());
        }
    }

    #[test]
    fn table_template_and_name() {
        assert_eq!(
            table_query(Some("app"), "logs", Dialect::Postgres),
            "SELECT * FROM \"app\".\"logs\""
        );
        assert_eq!(
            table_query(None, "lo`gs", Dialect::Mysql),
            "SELECT * FROM `lo``gs`"
        );
        assert_eq!(
            table_query(Some("dbo"), "Log", Dialect::Mssql),
            "SELECT * FROM [dbo].[Log]"
        );
        let name = |q: &str, d| table_of(q, d);
        assert_eq!(
            name("SELECT * FROM \"app\".\"logs\"", Dialect::Postgres).as_deref(),
            Some("app.logs")
        );
        assert_eq!(
            name("select a from logs where x = 1", Dialect::Sqlite).as_deref(),
            Some("logs")
        );
        assert_eq!(
            name(
                "SELECT (SELECT 1 FROM other) FROM [dbo].[Log] l",
                Dialect::Mssql
            )
            .as_deref(),
            Some("dbo.Log")
        );
        assert_eq!(name("SELECT 1", Dialect::Mysql), None);
    }
}
