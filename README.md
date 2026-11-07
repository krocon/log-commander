<p align="center"><img src="src-tauri/icons/128x128@2x.png" width="128" alt=""></p>

<h1 align="center">Log Commander</h1>

<p align="center"><b>A fast, colourful live log viewer for macOS, Windows and Linux.</b><br>
Like <code>tail -f</code> with a GUI: millions of lines, instant filters, no waiting.</p>

![Log Commander, dark theme](docs/screenshots/dark.png)

## Features

- **Live tail** – new lines appear at once. Detects truncation (`> app.log`), rotation (`app.log` → `app.log.1`), and a
  file that disappears and comes back. Never blocks the writing process.
- **Huge files** – the Rust backend keeps an index, not the text. 500 MB and 5 million lines: first lines after 25 ms,
  fully indexed in about 2 seconds, 78 MB of index ([measurements](#performance)).
- **Levels and colours** – TRACE, DEBUG, INFO, WARN, ERROR, FATAL, with chips that count live. Click toggles,
  Alt-click shows only this level, double click shows this level and worse. Presets `WARN+` and `ERROR+`.
- **Stack traces stay together** – continuation lines inherit the level of their entry, and filtering and selecting
  treat the entry as a unit.
- **Formats** – detected from the first lines: Log4j/Logback/Spring Boot, Python `logging`, Serilog, syslog,
  nginx/Apache error logs, JSON Lines (including numeric Pino/Bunyan levels), Common/Combined access logs, W3C/IIS,
  NLog, Java GC (unified logging), FIX, logfmt. Add your own regex with `(?P<level>...)`.
- **Fields** – each line is split into fields such as time, thread, level, logger and message, without defining a
  format. JSON and logfmt keys and FIX tags become fields; an unknown format is inferred (delimiters or timestamp,
  level, `[thread]`, `logger:`), otherwise the line stays one message. The profile tooltip shows how well the format
  fits ("Log4j · 97 %"); custom profiles take layouts (regexes with named groups) with a live preview.
- **Columns** – a recognised format is shown as a table with a header: one column per field, stack traces run
  across the full width. Drag a column edge to resize it (double click fits it to the rows on screen), drag a title
  to move it; right click on the header or `Shift+F10` opens a menu to show, hide, move and resize columns or reset
  them. The layout is remembered per format. `T` or the toolbar switch goes back to the raw lines. No sorting: the
  view stays in file order.
- **Detail panel** – the whole entry of the selected line below the log: head line and stack trace, without the
  cut at the screen edge and whatever the filter hides. Embedded JSON or XML is indented and coloured by its own
  tokenizer, so 64-bit ids stay exact and fragments work. Double click a line (or `D`) to open it, click other lines
  to browse, drag or use the arrow keys on the bar above it to change its height.
- **Sidebar** – left of the log, a tree with the open files (state, new errors, frozen), the active filter of each
  file (remove a part with `×`) and filters saved under a name (click applies one to the active tab). Below it a
  statistics table with lines per level for the whole file and for the current view; click a level to show only it,
  Alt-click to switch it on or off. Width and the split between tree and statistics are draggable; `Cmd/Ctrl+B` or
  the toolbar shows and hides it, below 900 px window width it steps aside by itself.
- **Merge files** – several logs (2 to 16) in one tab, their entries sorted by timestamp so they read like the log of
  one process. Each line shows its file as a short name and a colour stripe in the gutter; chips in the toolbar (and
  nodes in the sidebar) filter by file. New lines keep coming in live, held back up to 1 s so the files can catch up;
  an entry that arrives later than that is appended at the end and counted („N verspätet · Neu sortieren“). Open it
  with `Cmd/Ctrl+Shift+M`, the button in the tab bar or the menu: tick open tabs or pick files, the profile of each
  file is suggested and can be changed, the dialog shows its first and last time.
- **Overview ruler** – a narrow bar right of the log shows where errors (red), FATAL entries and warnings lie in the
  current view, the visible part as a band, bookmarks as flags and the selected line as a triangle; a single error
  among millions of lines is still a 3 px mark. Click a mark to go to its entry, anywhere else to go there; the
  selection stays. The arrow at its foot goes to the end and follows. `E`/`W` jump to the next error or warning,
  `M` bookmarks the selected entry (flag in the gutter, kept until the file starts over), `N` goes to the next
  bookmark. Switch it off in the settings.
- **From the filter to the whole log** – `G` (or „Im Gesamtlog“ in the toolbar and the detail panel) shows the
  selected line of a filtered view in the whole log, with the search kept as highlighting; `G` again (or „Zurück zum
  Filter“) brings the filter back at the same line. Changing the filter by hand forgets the way back.
- **Filter tree** – conditions in the sidebar, nested in groups joined with AND or OR (the joining word stands
  between the rows): text or regex, levels, a field of the head (`=`, contains, regex, `>`, `<`, between; numbers
  compare as numbers), a time span, a section between a start and an end marker, line numbers. Each can be negated,
  switched off with its check mark, moved with `Alt+↑/↓` or by dragging. Conditions hold for the whole entry: a
  request id in the head and „Timeout“ in its stack trace match together. The quick ways: mark text in a line and
  press `I` (`Shift+I` excludes it) or right click „Filtern auf …“, in the column view „Filtern nach Thread = …“,
  „Abschnitt ab hier“/„bis hier“ (`>`/`<`) for the selection. Errors (a broken regex, an unknown time) show at
  their condition. The level chips and the search stay on top as an AND; saved filters keep the tree. At most 64
  conditions.
- **Search** – filter or highlight, regular expressions, case sensitivity, jump between matches.
- **Follow** – stays at the end while you are there; scroll up and it pauses and counts the new lines.
- **Freeze** – holds a tab to read in peace: lines, counts and the position stay put while filters and search keep
  working. Resuming reads everything written in between.
- **Comfort** – tabs with a red dot for new errors in the background, drag & drop, command line, recent files,
  copying whole entries, dark and light themes that follow the system, adjustable colours.
- **Encodings** – UTF-8, UTF-16 by BOM, Latin-1 detection; invalid bytes never stop it. ANSI colours in logs are removed.

| | |
|---|---|
| ![Search](docs/screenshots/search.png) | ![Light theme](docs/screenshots/light.png) |
| ![Detail panel](docs/screenshots/detail.png) | ![Sidebar](docs/screenshots/sidebar.png) |
| ![Merged files](docs/screenshots/merge.png) | ![Merge dialog](docs/screenshots/merge-dialog.png) |
| ![Filter tree](docs/screenshots/filter-tree.png) | ![Narrow window](docs/screenshots/narrow.png) |

## Install

Packages for each platform are built by the [release workflow](.github/workflows/release.yml) (unsigned until the signing
secrets are set; see the comments there).

## Usage

```bash
log-commander /var/log/app.log /var/log/other.log
```

| Key | Action |
|---|---|
| `Cmd/Ctrl+O` | Open a file |
| `Cmd/Ctrl+Shift+O` | Type or paste a path to open (`~` works) |
| `Cmd/Ctrl+Shift+M` | Merge files into one tab, sorted by time |
| `End`, `F` | Go to the end and follow |
| `Space` | Pause or resume following |
| `P` | Freeze: hold or resume reading the file of this tab |
| `T` | Columns or raw lines |
| `D`, double click on a line | Detail panel with the whole entry; in it the arrows scroll the panel |
| `↑`, `↓` on the panel's bar | Panel height (`Shift`: bigger steps, `Home`/`End`, double click: default) |
| `Cmd/Ctrl+B` | Show or hide the sidebar |
| `↑`, `↓`, `←`, `→`, `Home`, `End` in the tree | Move, open and close nodes; `Enter`/`Space` activates, `Enter` on „Aktiver Filter“ saves it, `Delete` removes a filter |
| `←`, `→` on the sidebar's bar | Sidebar width (`Shift`: bigger steps, double click: default) |
| `Shift+F10` | Column menu (show, hide, move, resize, reset) |
| `Home`, `PageUp`, `PageDown`, `↑`, `↓` | Move through the file |
| `E`, `Shift+E` | Next / previous error (ERROR, FATAL) in the view; the selection stays |
| `W`, `Shift+W` | Next / previous warning or worse |
| `M` | Bookmark on the selected entry, or off again |
| `N`, `Shift+N` | Next / previous bookmark |
| `G` | Selected line in the whole log (filter lifted and kept, the filter tree too), again: back to the filter |
| `I`, `Shift+I` | Filter on the marked text, or exclude it (filter tree); also by right click on a line |
| `>`, `<` | Section from / up to the selected entry (filter tree) |
| `A`, `Shift+A` in the tree | Add a condition or a group (on a file, a group or next to a condition) |
| `Space`, `N`, `Enter` on a condition | Switch on/off, negate, edit (on a group `Enter` toggles AND/OR); `Delete` removes |
| `Alt+↑`, `Alt+↓` in the tree | Move a condition or group among its siblings |
| Click on the overview ruler | Go to the mark's entry, a bookmark, the selection or that place |
| `Cmd/Ctrl+F` | Search; `Enter` next match, `Shift+Enter` previous, `Esc` clear |
| Click, `Shift`+click | Select an entry, or a range (an open detail panel follows) |
| `Cmd/Ctrl+C` | Copy the selected lines |
| `Cmd/Ctrl+W`, `Ctrl+Tab` | Close a tab, next tab |
| `Cmd/Ctrl+,` | Settings |

## Development

Requires Node ≥ 22, Rust stable and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
npm install
```

```bash
npm run tauri:dev
```

(`cargo tauri dev` works too, once `cargo install tauri-cli` is done.) `npm run check` runs everything except the
end-to-end test; `npm run e2e` runs the real app with a real log file. Details: [CLAUDE.md](CLAUDE.md).

Try it with live data:

```bash
npm run demo:log     # writes /tmp/app.log, stop with Ctrl+C
npm run demo:app     # in a second terminal: the app with that file
npm run demo:clean   # removes the files afterwards (macOS, Linux)
```

For other data use `npm run gen-log -- /tmp/app.log` with `--rate N`, `--format spring|python|json|nginx`,
`--rotate-every N`, `--truncate-every N`, `--lines N`, `--stack 0..1`. Example files are in [`samples/`](samples/).

## Performance

Measured on an Apple Silicon Mac, release build, with
`cargo test --release --test tail_integration -- --ignored --nocapture measure_` (500 MB, 5.1 million lines):

| | |
|---|---|
| First lines | 25 ms |
| Fully indexed | 2.2 s |
| Index in RAM | 78 MB |
| Level filter over all lines | 15 ms |
| Full text search over all lines | 0.7 s |
| Filter tree with 1 / 5 / 20 text conditions | 0.8 / 0.8 / 1.0 s |
| `get_lines`, 200 lines at a random position | 43 µs |
| `get_overview` (800 px, 1000 bookmarks) | 0.3 ms |
| `find_level`, no FATAL in 5.1 million lines | 0.13 ms |

At 10,000 lines per second the UI's event loop was never blocked for more than 8 ms (debug build, `npm run e2e`).

## License

[MIT](LICENSE) © Marc Kronberg
