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
- **Fields from the message** – measurements in the text such as `cpu=72.3% mem=1.2GB took 340ms` become columns of
  their own, the file stays as it is. On opening the app looks at up to 2000 entries spread over the file and offers
  what it finds in the status bar („3 Felder erkannt“, once per format, never as a dialog); IDs, times and constants
  are left out. The dialog „ƒ Felder“ lists the suggestions with examples and share (name and type changeable),
  the rules of the format (edit, delete) and builds a rule from marked text: right click „Spalte aus Auswahl …“ or
  type the value, the preview shows the hits in the loaded lines. Types text, number, percent, duration and size;
  units are converted, so `took > 500 ms` in the filter tree also finds `1.2s`. Rules are regexes with one group,
  stored per format in the settings and valid for every file of that format right away. At most 32 per format.
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
  current view, the visible part as a band, bookmarks as flags and the selected line as a triangle. FATAL and ERROR
  share the left lane, warnings have the right one; the longer a bar, the denser its level there (the tooltip gives
  the share), so a busy log is not one solid colour and a single error among millions of lines is still a short
  3 px mark. Click a mark to go to the next entry from that place, anywhere else to go there; the selection stays. The arrow at its foot goes to the end and follows. `E`/`W` jump to the next error or warning,
  `M` bookmarks the selected entry (flag in the gutter, kept until the file starts over), `N` goes to the next
  bookmark. Switch it off in the settings.
- **Timeline** – a 56 px strip above the log shows the entries of the whole file over *time*, stacked by level
  (the rest in grey, WARN, ERROR and FATAL on top), so peaks, bursts of errors and outages stand out. An outage (no
  entries for ten times the usual spacing) is hatched, its tooltip says „keine Einträge 10:04–10:51“; the band marks
  what the log shows. Click to jump to that time (the selection stays, following stops), drag to mark a window and use
  it „Als Filter“ (a time condition in the tab's filter tree) or „Hineinzoomen“; the wheel zooms, „Ganze Datei“ goes
  back. By keyboard: arrows move a cursor (`Shift`: mark a window), `Enter` jumps, `+`/`-` zoom. The axis runs from
  the 1st to the 99th percentile, widened, so a stray 1970 timestamp does not squash it; entries outside are counted
  at its edge. Counts come from a running summary per 256 lines and are approximate (≈). It shows all lines of the
  file, also in a filtered tab. Files without timestamps get a one-line note instead. `Z`, the toolbar („Zeit“) or the
  settings switch it off.
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
- **Filter tabs (drill-down)** – a filter opened as a tab of its own shows the result of its tab and filters further,
  step by step: „app.log › ERROR › OrderService › 4711“. Each step stays open as a tab right of its parent, so you can
  go back and work next to it; changing a filter above updates every tab below it live. Open one with „⧉ Als Tab“ in
  the toolbar, `Cmd/Ctrl+Shift+T`, „⧉ Tab“ (or `T`) at a filter in the sidebar tree, right click „In neuem Tab
  filtern …“ on a line or a cell, or a bar of the dashboard without time axis. Closing a tab keeps the tabs below it
  as they are. All tabs of a file share one index, one tail and the freeze; bookmarks belong to the file. The tree
  shows the tabs below their file, the tab title the whole chain. At most 8 tabs per file.
- **Dashboard** – charts over time from SQL: errors per minute, the error rate, a measurement such as `took` per
  minute (mean and maximum), entries per file of a merge. `Cmd/Ctrl+Shift+D` or „▥ Dashboard“ lays it over the tab,
  the log keeps running below. On first use a small SQLite database is built in the background from the index, one
  row per entry (stack traces count once) with `line`, `ts`, `level`, `source` and the numbers of the format and of
  the extracted fields, never the message; it follows the tail every 5 s while shown and goes with the tab. Panels
  start from templates and show their SQL to change: line, area, bars, stacked bars, pie, table, single value, in a
  grid. `bucket(ts, '1m')` groups by minute (`'30s'`, `'1h'`, `'1d'` …). Click a point or bar (or pick it with
  `←`/`→` and `Enter`) to jump to the first line of that minute, a table row with a `line` column to that line, a bar
  without time axis (`GROUP BY logger`) to a filter tab on it. Queries only read: one statement, no `ATTACH`, no
  `PRAGMA`, no extensions, at most 10,000 rows and 10 s. Dashboards are stored per format.
- **Export** – the selection, the view or the whole file as text, CSV or JSON Lines (`Cmd/Ctrl+Shift+E`, „⤓ Export“
  or File → Export…): pick the scope, the format and (for CSV/JSON Lines) the columns, then where to save. The backend
  writes straight into the file in the background, so gigabytes are fine (500 MB as text in about half a second);
  progress and „Abbrechen“ are in the status bar, a cancelled export leaves nothing behind. The end is fixed when it
  starts, so a growing file does not keep it going. CSV quotes every field and puts a `'` in front of cells that a
  spreadsheet would run as a formula (`=`, `+`, `-`, `@`); the open log itself is refused as target.
- **Notes** – `Shift+M` (or right click „Notiz …“) puts a short note on an entry: a pencil in the gutter, a diamond on
  the ruler, the text in the detail panel. Like bookmarks they belong to the file.
- **Workspace** – „❖ Speichern …“ in the tab bar or File → Save Workspace… writes a `.lcw` file (JSON): the open files
  and merges, every tab with its filter, filter tree and chain, dashboard mode, position and selection, bookmarks and
  notes, the column mode and layouts, detail panel, sidebar, timeline and ruler. Open it from the start screen, File →
  Open Workspace…, the recent files (marked ❖) or like any file. Paths are kept absolute and relative to the `.lcw`,
  so a folder with the workspace and its logs can be moved or shared; missing files can be looked for or skipped.
  Bookmarks and notes are anchored by line, byte offset and a hash of the line, so they are found again after lines
  were inserted before them; what is not found is listed and kept. A workspace from someone else is checked field by
  field and never runs anything; dashboards are not part of it.
- **Syslog receiver** – „Quelle …“ in the tab bar, the start screen, File → Open Source… or `Cmd/Ctrl+Shift+L`:
  receive syslog over UDP (RFC 3164 and 5424) and TCP (RFC 6587: octet counting and newline framing; no TLS) and
  watch it like a file, with everything a file has (filters, search, freeze, columns, timeline, dashboard, export,
  merge with a log file by time). Each message becomes one line: time of receipt, sender, the message as received;
  it is escaped so it stays one unambiguous line (`\\` for a backslash, `\n`, `\r`, `\xNN` for control characters and
  broken bytes, `\u{XXXX}` for C1 controls, bidi marks and line/paragraph separators); messages over 64 KB are cut and
  marked. The priority gives the level. The tab shows „⇣ Syslog :5514“, the status bar the state and counters
  (received, dropped, cut, refused), the spool's path in its tooltip, „Spool behalten“ and „Speichern unter …“.
  Freeze holds the view while receiving goes on. Sources are remembered (without secrets) and saved in workspaces.
  See [security](#receiving-syslog-safely) below.
- **Remote files over SSH/SFTP** – „Remote …“ in the tab bar, the start screen, „Quelle öffnen“ → Remote-Datei, File →
  Open Remote File… or `Cmd/Ctrl+Shift+H`: follow a log file on a Linux server live without downloading it by hand.
  Host (hosts of `~/.ssh/config` are offered, their user and port taken over), user, port, login (SSH agent, key file
  with passphrase, password), path with a folder browser, start („die letzten 50 MB“ by default or the whole file)
  and how often to check (500 ms). The file is polled over SFTP into a spool like syslog, so everything a file has
  works (filters, search, freeze, columns, timeline, dashboard, export, merge with local files by time). Rotation
  (the old file is read to its end first) and truncation on the server are recognised; a broken connection is tried
  again after 1, 2, 4 … 60 s and continues where it stopped, the lines stay. Several files of one server share one
  connection. The tab shows „⇅ host:/var/log/app.log“, the status bar connection, lines, bytes and latency. See
  [SSH logins and host keys](#ssh-logins-and-host-keys).
- **Windows event logs** (only on Windows; invisible on macOS and Linux) – „Quelle öffnen“ → Windows-Ereignisse:
  Application, System, Security or any other channel (the list of the computer with a filter) of this computer or of
  another one, live instead of the slow Event Viewer. First the events of a period (24 hours by default, 1 h … all),
  then a subscription for new ones; after a broken connection it goes on at the bookmark without gap or doubles (a log
  cleared meanwhile is counted as a gap). Each event becomes one JSON line (`timestamp`, `level`, `provider`,
  `eventId`, `message`, `channel`, `computer`, `task`, `user`, `recordId`, optionally the whole `xml` for the detail
  panel), so filters, search, columns, timeline, dashboard and export work as for any JSON log. Levels: Critical →
  FATAL, Error and audit failure → ERROR, Warning → WARN, Information and audit success → INFO, Verbose → DEBUG. The
  columns start with time, level, provider, event ID and message; right click „Gleiche Event-ID“ filters on the ID.
  Several channels open several tabs, optionally merged by time. „Security“ needs administrator rights or the group
  *Event Log Readers*; the app never asks for elevation and says so instead. Another computer is read with the
  logged-on Windows identity or with user and password (password only for this connect, or in the Windows
  Credential Manager when ticked; never in settings, workspaces or logs; a workspace never connects by itself).
  Remote reading needs the firewall rule „Remote Event Log Management“ on that computer.
- **Logs from databases** – „Quelle öffnen“ → Datenbank: a `SELECT` on PostgreSQL, MySQL/MariaDB, SQL Server or a
  SQLite file, live. „Tabelle wählen“ writes the query for a table, „Vorschau“ shows the first 20 rows as they will
  arrive. The rows come in order of a *key column* (an id or a time), in batches of up to 10 000, starting with the
  last N rows (1000 by default) or all; then every 2 s (0.5 s … 1 h) the new ones (`key >= last`). Rows with the same
  key (equal times) are neither lost nor doubled: the ones already shown are remembered. Each row becomes one JSON line
  – the time column as `timestamp`, the level column as `level`, then the other columns – so columns, filters,
  timeline, dashboard and export work as for any JSON log; times in ISO 8601, numbers as numbers, binary data as
  „(binär, N Byte)“. The tab is called `db:schema.table`, the status bar shows the rows and the last query with its
  duration. After a broken connection it reconnects (1 … 60 s) and goes on from the last key; a refused login stops.
  See [Reading databases safely](#reading-databases-safely).
- **Share** – right click „Als Markdown kopieren“ or „Als Jira kopieren“: file, lines, time span and filter as a head,
  the selected lines as a code block, the notes as a list, up to 64 KB (for more there is the export).
- **Search** – filter or highlight, regular expressions, case sensitivity, jump between matches.
- **Follow** – stays at the end while you are there; scroll up and it pauses and counts the new lines.
- **Freeze** – holds a tab to read in peace: lines, counts and the position stay put while filters and search keep
  working. Resuming reads everything written in between.
- **Comfort** – tabs with a red dot for new errors in the background, drag & drop, command line, recent files,
  copying whole entries, adjustable level colours.
- **Colour schemes** – 17 schemes in a gallery with previews („◐“ in the toolbar, View → Colour Scheme… or
  `Cmd/Ctrl+Alt+T`): dark and light plus One Dark, One Dark Vivid, True Dark, True Black, True Light, Matrix, Amber,
  Solarized Light, Mystico – C64, Crimson and five Rainglow themes. Arrow keys show a scheme at once, `Enter` keeps it,
  `Esc` goes back; „System folgen“ takes a light and a dark scheme of your choice. Every scheme passes WCAG AA, the
  window frame follows it. See [docs/themes.md](docs/themes.md).
- **Encodings** – UTF-8, UTF-16 by BOM, Latin-1 detection; invalid bytes never stop it. ANSI colours in logs are removed.

| | |
|---|---|
| ![Search](docs/screenshots/search.png) | ![Light theme](docs/screenshots/light.png) |
| ![Detail panel](docs/screenshots/detail.png) | ![Sidebar](docs/screenshots/sidebar.png) |
| ![Merged files](docs/screenshots/merge.png) | ![Merge dialog](docs/screenshots/merge-dialog.png) |
| ![Filter tree](docs/screenshots/filter-tree.png) | ![Narrow window](docs/screenshots/narrow.png) |
| ![Fields dialog](docs/screenshots/fields.png) | ![Extracted columns](docs/screenshots/extracted.png) |
| ![Dashboard](docs/screenshots/dashboard.png) | ![Dashboard with SQL and schema](docs/screenshots/dashboard-sql.png) |
| ![Overview ruler on a busy log](docs/screenshots/ruler-dense.png) | ![The same in the light theme](docs/screenshots/ruler-dense-light.png) |
| ![Filter tabs: a chain of filters](docs/screenshots/drilldown.png) | ![Colour scheme picker](docs/screenshots/scheme-picker.png) |
| ![Scheme One Dark](docs/screenshots/schemes/one-dark.png) | ![Scheme Solarized Light](docs/screenshots/schemes/solarized-light.png) |
| ![Scheme Matrix](docs/screenshots/schemes/matrix.png) | ![Scheme Mystico – C64](docs/screenshots/schemes/mystico-c64.png) |
| ![Received syslog](docs/screenshots/syslog.png) | ![Opening a syslog source](docs/screenshots/source-dialog.png) |
| ![Timeline with an outage and a marked window](docs/screenshots/timeline.png) | ![Timeline in the light theme](docs/screenshots/timeline-light.png) |
| ![A remote file over SFTP](docs/screenshots/remote.png) | ![Remote dialog: browser and host key](docs/screenshots/remote-dialog.png) |
| ![Windows events (mock, taken on macOS)](docs/screenshots/winevent.png) | ![Windows events dialog (mock, taken on macOS)](docs/screenshots/winevent-dialog.png) |
| ![A database table as a log (mock data)](docs/screenshots/database.png) | ![Database dialog with table and preview (mock data)](docs/screenshots/database-dialog.png) |
| ![Keyboard shortcuts: search, record, reset](docs/screenshots/shortcuts.png) | |

## Receiving syslog safely

A syslog listener takes data from the network. Log Commander keeps it small and visible:

- **Only this computer by default:** `127.0.0.1`, port 5514. Listening on all interfaces (`0.0.0.0`, `::`) or another
  address needs an explicit tick in the dialog, which warns that other computers can then reach the port. Without a
  sender filter it accepts whatever reaches it; the optional filter takes addresses and networks (`10.0.0.0/8`,
  `fd00::/8`). A workspace never starts a source that listens beyond this computer.
- **Port 514** needs administrator or root rights; the dialog says so, and a port in use is reported with its number.
  Point the sender (or a local forwarder such as rsyslog) at 5514 instead.
- **Firewall:** listening on `127.0.0.1` asks nothing. The first time the app listens on another address, macOS asks
  „Allow incoming network connections?“ (for an unsigned development build again after each rebuild) and Windows
  Defender Firewall asks for the network types. Declining leaves the port reachable from this computer only.
- **The sender filter is no authentication** for UDP: sender addresses can be forged.
- **Bounded:** at most 64 KB per message, 64 TCP connections (8 per sender; idle ones close after 120 s, a message
  not finished within 30 s ends its connection, at the limit the longest idle one makes room), 8 sources at a time,
  32 MB waiting for the disk; when the disk cannot keep
  up, messages are dropped and counted instead of filling memory. The spool (a file in the app's cache folder) is
  at most 2 GB per source (settings), split into files of 256 MB; beyond it the oldest file is deleted and the view
  starts over. Closing the tab stops the listener and deletes the spool, unless „Spool behalten“ is ticked (then it
  moves to `spool/kept/` in the cache folder; the settings show their size and delete them). Spool folders and files
  are readable by your user only (Unix).
- **Nothing is sent back** (no replies, no amplification), no host names are looked up, and the text of messages is
  never interpreted as markup.

Measured with `cargo test --release --test syslog_integration -- --ignored --nocapture measure_`: 50,000 and 100,000
messages per second over UDP without loss, a single sender pushing 120,000 per second without loss, about 0.1 s from
receipt to the index.

## Reading databases safely

A database source runs SQL from you – or from a workspace someone sent – on a server with real data.

**Use a read-only database account.** Give Log Commander its own user with `SELECT` on the log table and nothing
else: no superuser, no `FILE` privilege (MySQL), not in `pg_write_server_files`/`pg_read_server_files` (PostgreSQL),
not `sysadmin` (SQL Server). The checks below are a second line, not a replacement: the integration tests show that a
read-only *transaction* does **not** stop `SELECT … INTO OUTFILE` (MySQL, MariaDB) or `lo_export` (PostgreSQL) for an
account that has those rights – only the account's rights do.

- **One SELECT:** the query must be a single `SELECT` (or `WITH … SELECT`). Words that write or act on the server
  (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `INTO`, `OUTFILE`, `DUMPFILE`, `FOR UPDATE`, `DROP`, `EXEC`, `OPENROWSET`,
  `ATTACH`, `PRAGMA`, …), a list of functions with side effects (`LOAD_FILE`, `GET_LOCK`, `lo_export`,
  `pg_read_file`, `pg_terminate_backend`, `dblink_exec`, advisory locks, `set_config`, `xp_cmdshell`, …) and a second
  statement are refused, also when hidden behind comments, quotes or dialect quirks (MySQL `--1`, `x#`, non-ASCII
  names). The app wraps the query as a subquery and adds the key condition, order and batch limit (so no
  `ORDER BY`/`LIMIT`).
- **Read-only on the server:** PostgreSQL in a read-only session and `BEGIN READ ONLY` per query, MySQL/MariaDB in a
  read-only session and `START TRANSACTION READ ONLY`, SQL Server (no read-only session for a normal database) in a
  transaction that is always rolled back, SQLite opened read-only with an authorizer that allows reading only. Table
  writes fail even through a function in the query.
- **What remains with a privileged account:** functions the list does not know (extensions, `CLR` code, user-defined
  functions with side effects, extended procedures behind synonyms), server files, other sessions, locks. Hence the
  account recommendation above.
- **Limits:** 30 s per query (server side where possible, and in the app; a cancelled query closes the connection –
  SQL Server was seen to stop it within 0.2 s), at most 10 000 rows or 32 MB per batch, 200 columns; texts over 32 000
  characters and lines over 256 KB are cut and marked. The drivers read a whole row into memory before the app cuts it.
- **TLS** is on and the certificate checked by default (system certificates plus an optional CA file). Switching the
  check or TLS off shows a warning in the dialog and in a workspace's confirmation.
- **Passwords** are asked for in the dialog and kept in memory only while the source runs. „Im Schlüsselbund merken“
  puts them into the system keychain – only when ticked, only after the login worked, and bound to the TLS mode: a
  password stored with certificate check is never sent over a connection without it. Never written to the settings, a
  workspace, a log or an error message. A refused login is not retried.
- **Workspaces** keep the connection and the query, never a password and no CA file. Opening one never connects by
  itself: the database is listed unticked in the confirmation **with its query**, and a password is asked for in the
  dialog.
- **Values are foreign data:** escaped like received syslog (one line per row, control characters, bidi marks and line
  separators as `\uXXXX`), shown as text, never as markup.

## SSH logins and host keys

Remote files (SSH/SFTP) touch credentials and other people's servers. Log Commander keeps that strict:

- **Host keys:** checked against `~/.ssh/known_hosts` (only read, never written) and the app's own list
  (`known_hosts` in the app's config folder, readable by your user only). An **unknown** key is shown with its type and
  SHA256 fingerprint (compare it, e.g. with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server);
  only „Vertrauen und verbinden“ records exactly that key. A **changed** key (or a key of another type than the one
  recorded) ends the connection – there is no „connect anyway“. Check the server and remove the old line by hand.
  A key marked `@revoked`, an `@cert-authority` line for the host (host certificates are not supported), an entry
  whose key cannot be read or an unreadable known_hosts file also end the connection, with the reason. The app reads
  known_hosts like OpenSSH (any whitespace, host lists, patterns with `*`/`?`/`!`, `[host]:port`, hashed hosts, host
  names in any case). The host key is checked before you are asked for a password, and again on every reconnect.
- **Logins:** the SSH agent first (`SSH_AUTH_SOCK`; on Windows the OpenSSH agent, then Pageant), a key file (asked
  for its passphrase if it has one), or a password. Passwords and passphrases are asked for in the dialog and kept in
  memory only while the connection lives (to reconnect). „Im Schlüsselbund merken“ puts them into the system keychain
  (macOS Keychain, Windows Credential Manager, Secret Service on Linux) – only when ticked and only after the login
  worked; „Gespeichertes vergessen“ removes them. They are never written to the settings, a workspace, a log or an
  error message. A refused login is not retried by itself (no locked accounts). With the agent, the keys of the
  host's `IdentityFile`s are offered first, at most six. (The SSH library keeps its own copy of a password while
  logging in, which is not wiped; the app's copies are.)
- **Only SFTP:** the app requests the SFTP subsystem and nothing else – no shell, no commands, no port forwarding, no
  agent forwarding – and refuses every channel a server tries to open towards it.
- **`~/.ssh/config`:** `Host` (with `*`, `?`, `!`), `HostName`, `User`, `Port`, `IdentityFile` and `Include` are read;
  `Match` blocks are skipped, `ProxyCommand`, `ProxyJump`, `LocalCommand` and `KnownHostsCommand` are never run (a host
  with a proxy is reported as not supported).
- **Workspaces and saved connections** keep host, user, port, path, the kind of login and the start – never a secret
  (a workspace not even the key file). Opening a workspace never connects by itself: a remote file is listed unticked
  in the confirmation, and a host key or password it needs is asked for in the dialog.
- **Remote content is foreign data:** each line is decoded (UTF-8, UTF-16, Latin-1), ANSI colours are removed and
  control characters, bidi marks and line separators are escaped (`\xNN`, `\u{XXXX}`) before it reaches the spool;
  lines over 1 MB are cut and marked.

## Install

Packages for each platform are built by the [release workflow](.github/workflows/release.yml) (unsigned until the signing
secrets are set; see the comments there).

## Usage

```bash
log-commander /var/log/app.log /var/log/other.log
```

Every shortcut below is an action with a stable id and can be changed in the app: **Help → Keyboard Shortcuts…**,
`Cmd/Ctrl+Shift+K`, or `?` for an overview (search, record, remove, reset; own shortcuts are stored in the settings and
the native menu shows them too). The table holds the defaults and is written from the keymaps
(`src/app/core/actions/keymaps/*.json`) by `node scripts/keymap-table.mjs`; `npm run check` fails when it is out of date.
Plain keys act in the log only, not in text fields, dialogs or the widgets below.

<!-- keymap:start (generated by scripts/keymap-table.mjs, do not edit) -->
| Key | Action |
|---|---|
| `Cmd/Ctrl+O` | Open a file |
| `Cmd/Ctrl+Shift+O` | Type or paste a path to open (`~` works) |
| `Cmd/Ctrl+Shift+L` | Open a source: receive syslog over UDP/TCP, a database query (kind „Datenbank“) |
| `Cmd/Ctrl+Shift+H` | Open a remote file over SSH/SFTP |
| `Cmd/Ctrl+Shift+M` | Merge files into one tab, sorted by time |
| `Cmd/Ctrl+Shift+E` | Export the selection, the view or the file |
| – | Open a workspace (`.lcw`) |
| – | Save the workspace: files, filter tabs, bookmarks, notes, layout |
| `Cmd/Ctrl+,` | Settings |
| `Cmd/Ctrl+W` | Close the tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |
| `Cmd/Ctrl+Shift+T` | The result of the tab as a new filter tab, to filter further there (`T` on a filter in the tree) |
| `Cmd/Ctrl+B` | Show or hide the sidebar |
| `Cmd/Ctrl+Shift+D` | Dashboard of the tab, or back to the log |
| `T` | Columns or raw lines |
| `D` | Detail panel with the whole entry (also a double click on a line); in it the arrows scroll the panel |
| `Z` | Show or hide the timeline above the log |
| `Shift+F10`, `ContextMenu` | Column menu (show, hide, move, resize, reset) |
| `Cmd/Ctrl+Alt+T` | Colour scheme picker (arrows try, `Enter` keeps, `Esc` goes back) |
| `End`, `F` | Go to the end and follow |
| `Space` | Pause or resume following |
| `P` | Freeze: hold or resume reading the file of this tab |
| `Home` | Go to the first line |
| `PageUp` | One page up |
| `PageDown` | One page down |
| `↑` | One line up |
| `↓` | One line down |
| `E` | Next error (ERROR, FATAL) in the view; the selection stays |
| `Shift+E` | Previous error |
| `W` | Next warning or worse |
| `Shift+W` | Previous warning or worse |
| `N` | Next bookmark |
| `Shift+N` | Previous bookmark |
| `Cmd/Ctrl+C` | Copy the selected lines (marked text copies itself) |
| `Esc` | Drop the selection |
| `M` | Bookmark on the selected entry, or off again |
| `Shift+M` | Note on the selected entry (write, change, delete) |
| `G` | Selected line in the whole log (filter lifted and kept, the filter tree too), again: back to the filter |
| `I` | Filter on the marked text (filter tree); also by right click on a line |
| `Shift+I` | Exclude the marked text |
| `>` | Section from the selected entry (filter tree) |
| `<` | Section up to the selected entry |
| `Cmd/Ctrl+F` | Search |
| `Enter` | In the search field: next match |
| `Shift+Enter` | In the search field: previous match |
| `Esc` | In the search field: clear it |
| `Cmd/Ctrl+Shift+K` | Keyboard shortcuts: view, record, remove, reset (also Help → Keyboard Shortcuts…) |
| `?` | Keyboard shortcuts as an overview |
<!-- keymap:end -->

Keys of single widgets are fixed and stay with them:

| Key | Where | Action |
|---|---|---|
| `←`, `→`, `Shift+←/→`, `Home`, `End`, `Enter`, `+`, `-`, `Esc` | Timeline | Move the cursor, mark a window, jump to its time, zoom, drop the window |
| `↑`, `↓`, `Home`, `End` (`Shift`: bigger steps), double click | Bars between panes | Height of the detail panel, width of the sidebar (default) |
| `↑`, `↓`, `←`, `→`, `Home`, `End`, `Enter`, `Space`, `Delete` | Tree | Move, open and close nodes; activate; `Enter` on „Aktiver Filter“ saves it; remove a filter |
| `A`, `Shift+A`, `T`, `N`, `Alt+↑`, `Alt+↓` | Tree | Add a condition or a group, a filter as a new tab, negate, move among its siblings |
| `←`, `→`, `Home`, `End`, `Enter` | Chart of the dashboard | Pick a point (values in the legend), jump to its first line |
| `Cmd/Ctrl+Enter` | SQL of a panel, note | Run the query, save the note |
| `↑`, `↓`, `Enter`, `Esc` | Menus, dialogs | Choose, confirm, close |
| Click, `Shift`+click | Log | Select an entry, or a range (an open detail panel follows) |
| Click | Overview ruler | Go to the next marked entry from there, a bookmark, the selection or that place |

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
| `get_timeline` (1000 buckets) / `position_at_time` | 0.6 ms / 0.13 ms |
| `get_lines`, 5000 lines with 0 / 4 / 16 extracted fields (`extract_integration`) | 7.8 / 11.8 / 12.8 ms |
| Dashboard database: build / size (numbers only) / errors per minute (`report_integration`) | 12.8 s / 226 MB / 1.0 s |
| Read and filter with 1 / 4 / 8 filter tabs open (`views_integration`) | 2.2 / 3.6 / 4.6 s |
| Export of all lines as text / CSV with 5 columns (`export_integration`) | 0.55 / 9.8 s |

At 10,000 lines per second the UI's event loop was never blocked for more than 8 ms (debug build, `npm run e2e`).

## License

[MIT](LICENSE) © Marc Kronberg
