# 012 Dashboard und SQL-Timeline: Spike, Design und Stand

Status: umgesetzt, nicht committet · Datum: 2026-11-07 · Branch `feat/dashboard-sql-timeline`

Marc hat die Prompts zur selbständigen Abarbeitung freigegeben. Der Prompt verlangt nach dem Spike einen Halt; vereinbart
war: anhalten nur, wenn der Spike das Feature als nicht sinnvoll machbar zeigt (Binärgröße > ~15 MB mehr, oder der Tail
müsste warten). Beides ist nicht der Fall, deshalb ist die Entscheidung unten selbst getroffen und die Umsetzung folgt.

## Abweichungen vom Stand des Prompts

- Die alte eigene Ansicht gibt es nicht mehr; die Log-Ansicht ist die GuiExpert Table (`features/log-table/`). Das
  Dashboard liegt als Überlagerung über Tabelle, Ruler und Detail-Panel; die Tabelle bleibt darunter montiert und
  lebendig (`visibility: hidden`, `inert`), ihre Tasten (`onKey`) ruhen im Dashboard-Modus.
- `run_filter` steht nicht mehr bei `session.rs:677`, `epoch` nicht bei `:107`; gemeint sind `run_filter` und
  `SessionData.epoch`. Der Aufbau folgt dem Muster (Stapel, kurze Sperren, Abbruch), hat aber eine eigene Stopp-Flagge
  statt der Job-Generation, weil er neben Filter-Jobs laufen muss.
- 013 (Filter-Tab) ist nicht umgesetzt: Ein Säulenbalken ohne Zeitachse setzt einen Filter (010), kein Filter-Tab.
- 021 (Aktionskatalog) ist nicht umgesetzt: das Kürzel kommt wie bisher in `app.ts`.
- Für die Spalten-Panels taugt die GuiExpert Table auch, wäre aber für höchstens 10 000 Zeilen mit festen Spalten
  überdimensioniert; die Panel-Art „Tabelle“ ist eine einfache HTML-Tabelle (Werte per Interpolation, nie `innerHTML`).

## Spike (Phase 1)

Gemessen auf Apple Silicon (10 Kerne), Release-Profil des Projekts (`lto = "thin"`, `codegen-units = 4`, `strip`).

### Binärgröße

| Variante | Größe | Zuwachs | Bauzeit (frisch) |
|---|---|---|---|
| App vorher (`target/release/log-commander`) | 10 936 832 B (10,4 MiB) | | |
| App mit `rusqlite` 0.41 `bundled` (SQLite 3.5x, ohne Extension-Loading) | 12 832 864 B (12,2 MiB) | **+1,81 MiB** | +17 s (C-Teil) |
| Leeres Programm (Vergleich) | 340 096 B | | |
| Leeres Programm + `rusqlite` bundled | 2 069 024 B | +1,65 MiB | 17 s |
| Leeres Programm + `duckdb` 1.2 bundled | 45 571 056 B | **+43,1 MiB** | 3 min 2 s (16,5 CPU-min) |

DuckDB wäre für Analysen schneller (spaltenorientiert), kostet aber das Vierfache der ganzen App und verlängert jeden
frischen Build (CI) um Minuten. Damit ist die Wahl klar.

### Diagramm-Bibliothek (Bundle)

| Paket | minifiziert | gzip | CSP |
|---|---|---|---|
| `uplot` 1.6.32 (`uPlot.iife.min.js`) | 51 KB | 22 KB | kein `eval`, kein `new Function`, Legende über `textContent` |
| `uplot` CSS | 1,9 KB | 0,8 KB | |
| `echarts` 6.1 komplett | 1 122 KB | 368 KB | enthält `new Function(...)` (verstößt gegen `script-src 'self'` ohne `unsafe-eval`, sobald der Pfad läuft) |
| `echarts` „simple“ | 500 KB | 169 KB | wie oben |

uPlot bringt keinen Kreis; der wird mit 40 Zeilen Canvas selbst gezeichnet. Im Build: eigener Lazy-Chunk (siehe unten).

### Aufbau, Größe, Abfragen (500 MB, 5,1 Mio. Zeilen, ein Eintrag je 10 ms über 14 h)

`cargo test --release --test report_integration -- --ignored --nocapture measure_` (Log4j-Layout, Regel `took` als Dauer):

| | nur Zahlen (Vorgabe: `took`) | plus `logger`, `thread` (Text) |
|---|---|---|
| Aufbau (5 112 757 Köpfe, inkl. Zeit-Index) | 12,8 s | 13,3 s |
| Datei | 226 MB (≈ 44 B je Eintrag) | 394 MB |
| `bucket(ts,'1m'), count(*) GROUP BY t` (853 Zeilen) | 1,04 s | 1,05 s |
| dasselbe mit `ts / 60000 * 60000` | 1,10 s | 1,10 s |
| `… GROUP BY t, level` (4265 Zeilen) | 2,12 s | 2,15 s |
| `avg(took), max(took)` je Minute | 1,34 s | 1,39 s |
| `count(*) WHERE level = 'ERROR'` | 0,21 s | 0,26 s |
| `min(line)` in einer Minute (Klick auf einen Punkt) | 0,44 ms | 0,43 ms |

- Erster Durchlauf ohne Zeit-Index und mit WAL: Datei 226 MB + 74 MB WAL. Jetzt wird der Index einmal am Ende gebaut
  und die WAL danach gekürzt (`wal_checkpoint(TRUNCATE)`, `journal_size_limit` 64 MB).
- `bucket()` parste das Intervall zuerst je Zeile (1,21 s); mit Auxdata einmal je Anweisung (1,04 s) ist es so schnell
  wie die eingebaute Arithmetik. Der Rest ist der Sortierer von `GROUP BY`.
- Die Nachricht ist bewusst nicht in der Tabelle: schon zwei Textspalten (Logger, Thread) kosten +74 %.

### Log-Ansicht und Tail während des Aufbaus

| | ohne Aufbau | während des Aufbaus |
|---|---|---|
| `get_lines` 200 Zeilen, zufällig | 302 µs | 329–334 µs (+10 %, Lesekonkurrenz auf derselben Datei) |
| Level-Filter (Job) über 5,1 Mio. Zeilen | 30–38 ms | 29–37 ms |
| Tail bei 5000 Zeilen/s, Index-Verzug (max.) | | 112–183 ms |
| Tabelle nach dem letzten Schreiben nachgezogen | | 3,6 s (Takt 5 s) |

Der Builder hält die Lesesperre nur zum Kopieren von 16 384 Index-Einträgen (`to_vec`, µs), nie während SQLite arbeitet;
der Status geht unter einer kurzen Schreibsperre höchstens alle 200 ms hinaus. Der Tail wartet nie auf ihn.

`measure_` (tail_integration) vorher/nachher: siehe Abschnitt Messwerte.

## Entscheidungen

| Frage | Optionen | Entscheidung | Grund |
|---|---|---|---|
| Engine | SQLite (`rusqlite` bundled); DuckDB; feste Auswertung ohne SQL | SQLite | +1,8 MiB statt +43 MiB, echtes SQL, Abfragen um 1–2 s auf 5 Mio. Einträge reichen für Minuten-Diagramme |
| Diagramme | uPlot; ECharts; selbst | uPlot (lazy), Kreis selbst | 22 KB gzip statt 169–368 KB; ECharts enthält `new Function` |
| Ablage | im Speicher; Datei je Sitzung | Datei `<app-cache>/reports/<pid>/session-<id>.sqlite` | Text und Index bleiben schlank; Datei verschwindet mit der Sitzung |
| Absturz-Reste | beim Start alles löschen; nach PID; Sperrdatei | Ordner je Prozess mit gesperrter `lock`-Datei (`File::try_lock`), fremde Ordner nur, wenn die Sperre frei ist und nur Berichtsdateien darin liegen | zwei laufende Instanzen stören sich nicht; ohne `libc`-PID-Abfrage, auf allen OS gleich. Setzt Rust 1.89 voraus (`rust-version` angehoben) |
| `ts` | Sekunden (REAL); ms (INTEGER); µs | INTEGER ms seit 1970, UTC | `datetime(ts/1000,'unixepoch','localtime')` geht, uPlot rechnet in s/ms, ganzzahlig und kompakt |
| `line` | Index (0-basiert); Anzeige (1-basiert) | wie angezeigt (1-basiert) | Was im Ergebnis steht, findet man in der Ansicht wieder; der Sprung rechnet `line - 1` |
| `level` | Zahl; Text | Text (`'ERROR'`) | lesbares SQL, 4–5 Byte |
| `source` | Name je Zeile; Index + Tabelle; NULL bei einer Datei | Index (1 Byte, 0 und 1 kosten in SQLite gar nichts) + `sources(source, name)` | Name je Zeile kostete ~10 B × Zeilen; die Vorlage „je Quelle“ holt den Namen nach dem Gruppieren |
| Felder | alle; nur gewählte; nur Zahlen | Vorgabe: alle Zahlen (Zahlenspalten, extrahierte Werte in Basiseinheit über `parse_value`); Text nur angehakt (Schema-Hilfe, je Dashboard gespeichert), auf 1 KB gekürzt | „Felder, die eine Abfrage braucht, oder die der Nutzer angehakt hat“: Zahlen sind billig (8 B), Text teuer (+74 % mit zwei Spalten) |
| Namen der Felder | Spalten-Id in Anführungszeichen; bereinigt | klein, `[a-z0-9_]`, Ziffer vorn → `f_`, Kollision → `_2` | `user.name` ohne Quoting schreibbar |
| Start | beim Öffnen der Datei; beim ersten Dashboard | beim ersten Öffnen eines Dashboards (`open_report`), vorher weder Datei noch Thread | Prompt; belegt durch Test |
| Nachziehen | Tail direkt; Takt | Builder-Thread nur bei offenem Dashboard, alle 5 s; geschlossen (`close_report`) endet der Thread, die Datei bleibt, Wiederöffnen macht ab dem Stand weiter | Prompt; kein Thread ohne Dashboard |
| Neuaufbau | | neue `epoch` (Truncation, Rotation ohne Behalten, Neu sortieren), neue `columnsRevision` (Profil, Regeln), andere Felder; Grund im Status (`reason`), Hinweis im Dashboard | Prompt |
| Freeze | eigener Halt; nichts tun | nichts: im Freeze wächst der Index nicht, also kommt nichts nach | Freeze-Modell aus 002 |
| Provisorische Zeile | aufnehmen; warten | erst wenn sie endgültig ist | sonst stünde ein halber Eintrag in der Tabelle |
| Platz | nur warnen; ablehnen | Schätzung (40 B je Zeile + 10 B je Zahl + 48 B je Text). Unter Schätzung + 256 MB frei: Fehler statt Aufbau; unter 2 × Schätzung + 1 GB: Warnung `lowSpace`; alle 64 Stapel unter 256 MB: Abbruch mit Meldung. `SQLITE_FULL` wird „Laufwerk voll“ im Dashboard | Ein Dashboard soll das Laufwerk nicht bis zum letzten Byte füllen |
| Abfragen absichern | | eigene Verbindung je Abfrage (`SQLITE_OPEN_READ_ONLY`), `PRAGMA query_only`, Authorizer erlaubt nur `SELECT`, `READ`, Funktionen (ohne `load_extension`, `fts3_tokenizer`, `readfile`, `writefile`, `edit`) und `RECURSIVE`, alles andere (auch `PRAGMA`, `ATTACH`, Transaktionen) abgelehnt; `stmt.readonly()`; eine Anweisung (`MultipleStatement`); Limits `ATTACHED 0`, `LENGTH 64 KB`, `LIKE_PATTERN_LENGTH 256`, `SQL_LENGTH 64 KB`, `COLUMN 50`, `EXPR_DEPTH 200`, `COMPOUND_SELECT 50`; Zeitlimit 10 s über den Progress-Handler (alle 32 VM-Schritte); 10 000 Zeilen und 32 MB Werte (nach jedem Wert geprüft); höchstens 6 Abfragen zugleich; `temp_store = MEMORY` unter einem Heap-Limit; Schließen unterbricht laufende Abfragen (siehe Sicherheit); SQLite ohne Extension-Loading gebaut (`.cargo/config.toml`, `SQLITE_OMIT_LOAD_EXTENSION`, dazu `SQLITE_DQS=0`) | Prompt; mehrere Mauern, jede für sich getestet |
| Überholte Abfragen | global; je Panel | je `slot` (Panel-Id): eine neue Abfrage desselben Panels bricht die alte über den Progress-Handler ab | Panels dürfen sich nicht gegenseitig abbrechen |
| Fehlercode | | `invalid_query`, Text der Engine (englisch) hinter „Abfrage nicht ausführbar:“, bekannte Fälle übersetzt | Prompt |
| `bucket()` | | `bucket(ts, '30s' / '1m' / '1h' / '1d' / '500ms')`, ohne Intervall 1 Minute; s/m/h in UTC (feste Länge, beim Sommerzeitwechsel keine Lücke und keine doppelte Stunde), Tage ab lokaler Mitternacht | Prompt; Test über DST-Wechsel EU und US |
| Ort | eigener Tab; Modus je Tab | Modus je Tab (`SessionState.mode`), Umschalter „Dashboard“ in der Toolbar, `⌘/Strg+Shift+D` | Prompt; das Log läuft darunter weiter |
| Laden | im Haupt-Bundle; lazy | Dashboard per `@defer`, uPlot per `import()`; eigener Chunk | Start ändert sich nicht |
| Raster | frei ziehen; feste Stufen | 4-Spalten-Raster, Breite 1–4, Höhe S/M/L per Buttons | tastaturbedienbar, ohne Drag-Bibliothek |
| Diagrammarten | | Linie, Fläche, Säulen, gestapelte Säulen, Kreis (8 + „Sonstige“), Tabelle, Einzelwert; ohne Zeitachse werden Linie/Fläche zu Säulen | Prompt |
| Zeitachse | Name; Werte | erste Spalte heißt `ts`, `t`, `time`, `zeit`, `bucket`, `minute`, `hour`, `day` (oder beginnt mit `bucket`) und hat ganze Zahlen | Prompt: „erste Spalte `ts` oder `bucket`“; Alias `t` in den Vorlagen |
| Zu viele Punkte | ausdünnen; vorschlagen | über 5000 Punkte je Reihe: Hinweis mit größerem Intervall und Knopf „Mit … ausführen“, der `bucket(…)` im SQL ersetzt; gezeichnet wird trotzdem alles | Prompt: nicht still ausdünnen |
| Klick | | Punkt/Balken mit Zeitachse → `SELECT min(line) … WHERE ts >= a AND ts < b` (b = nächster Bucket, sonst +Abstand), bei einer Level-Reihe zusätzlich `level = …`; Sprung wie `E`/`W` (Auswahl bleibt). Ausgefilterte Zeile: Sprung zur nächsten sichtbaren, Hinweis „G zeigt sie im Gesamtlog“, `G` nimmt dann diese Zeile. Tabelle mit Spalte `line`: Zeile klickbar. Säule ohne Zeitachse: Filter auf den Wert (Level → Level-Chips, Quelle → Quellen, Feld → Feld-Bedingung 010) | Prompt; 013 fehlt |
| Tastatur im Diagramm | keine; Pfeile | Diagramm fokussierbar, ←/→ wählt einen Punkt, Enter springt, Werte in der Legende | Barrierefreiheit: jede Funktion per Tastatur |
| Speichern | in `settings.json`; eigene Datei | eigene Store-Datei `dashboards.json` je Profil-Id (Format der Datei, wie Spalten-Layouts), nachsichtiges Zusammenführen | „größer als einige KB: eigene Datei“; Settings bleiben klein |
| Live | nur bei sichtbarem Fenster; immer | „Automatisch“ je Dashboard, alle 5 s, nur wenn die Tabelle neue Zeilen hat und das Dashboard des Tabs offen ist (ein anderer Tab oder der Log-Modus hat gar keins); auch hinter anderen Fenstern, wie das Log (`backgroundThrottling: disabled`). Eine laufende Abfrage wird nicht überholt: der Takt wartet und läuft einmal danach | Prompt „Pause bei unsichtbarem Tab“; ein Live-Viewer bleibt hinter anderen Fenstern aktuell (CLAUDE.md). Der erste e2e-Lauf zeigte: ein übersprungener Takt kam nie nach |
| Farben | Level-Tokens der Zeilen; eigene | Reihen `--chart-1` … `--chart-8`, Level-Reihen `--chart-lv-*` (kräftige Varianten der Level-Farben), Gitter `--chart-grid`, Achsentext `--text-dim`; Canvas liest per `getComputedStyle`, Themewechsel zeichnet neu | Hintergrundfarben der Zeilen sind zu blass für Linien; 3:1 gegen `--bg-panel` geprüft |
| Nur gefilterte Ansicht | | nicht in V1 (Doku) | Prompt |

## Sicherheit (Review nach der Umsetzung)

Ein separater Agent hat die Abfragen geprüft. Befunde und Behebung, jeweils mit Regressionstest in `report_db.rs`:

| Befund | Schwere | Behebung | Test |
|---|---|---|---|
| Ein einzelner Funktionsaufruf (`LIKE`, `GLOB`, `instr`, `replace`) ist ein VM-Schritt; der Progress-Handler greift nicht. `printf('%.*c',1000000,'a') LIKE '%'‖printf('%.*c',20000,'a')‖'b'` = 41 s CPU, in 200 Spalten vervielfacht, 24 Panels eines geteilten Dashboards blockieren 24 Threads; Überholen, Dashboard und Sitzung schließen halten ihn nicht an | mittel | `SQLITE_LIMIT_LENGTH` 64 KB (gespeicherter Text ist ohnehin ≤ 1 KB), `LIKE_PATTERN_LENGTH` 256, `COLUMN` 50 – der schlimmste `LIKE` innerhalb der Grenzen dauert ~58 ms (Debug); Progress-Handler alle 32 statt 4000 Schritte, damit er auch zwischen den Spalten einer Zeile greift; prozessweit höchstens `MAX_QUERIES` = 6 Abfragen zugleich (weitere warten bis 10 s auf einen Platz, die Wartezeit zählt nicht zum Zeitlimit); laufende Abfragen sind mit ihrem `InterruptHandle` je Panel registriert: eine neuere desselben Panels, das Schließen des Dashboards (`pause`) und der Sitzung (`shutdown`) rufen `sqlite3_interrupt`; ein Zähler `stops` erwischt auch Abfragen, die noch auf einen Platz warteten; nach `shutdown` keine neuen | `one_long_function_call_cannot_outlast_the_limits` (die 41-s-Abfrage scheitert in < 1 s mit „too big“, zu langes Muster, 50 Spalten des schlimmsten Falls < 5 s, 51 Spalten abgelehnt), `closing_stops_running_queries_and_refuses_new_ones`, `at_most_a_few_queries_run_at_once`, `a_newer_query_of_the_same_slot_stops_the_older_one` |
| Byte-Limit nur zwischen Zeilen: eine Zeile mit 200 × 1 MB ≈ 200 MB über serde/IPC | niedrig/mittel | nach jedem Wert geprüft, die angefangene Zeile fällt weg | `the_byte_limit_holds_within_one_row` |
| Sortier-Auslagerung großer CTEs nach `$TMPDIR` unbegrenzt | niedrig | `PRAGMA temp_store = MEMORY` (vor dem Authorizer) und `sqlite3_hard_heap_limit64` = 768 MiB. Das Limit ist prozessweit (rusqlite hat keins je Verbindung): Builder (Cache 16 MB) und Abfragen (Cache 8 MB je Verbindung) teilen es; eine Abfrage darüber endet mit „Speichergrenze erreicht“, ein Builder-Stapel, der dabei `SQLITE_NOMEM` bekommt, wird nach 1 s wiederholt (die Transaktion ist zurückgerollt, die Position steht) | `sorts_stay_in_memory_under_a_heap_limit` |
| Feldnamen ungequotet als Bezeichner: `order`, `group`, `from`, `default` brechen Aufbau und Vorlagen | niedrig | `CREATE TABLE` und Vorlagen (`quoteIdent`) setzen `"name"` | `fields_named_like_keywords_work`, Vitest „quotes field names that are SQL keywords“ |
| Fehler beim Öffnen enthielt den absoluten Cache-Pfad | info | `scrub`: Pfad des Ordners im Text durch `…` ersetzt, `path` leer; Ordnerfehler ohne `from_io` | `errors_do_not_show_the_cache_folder` |

## Verträge

- Commands: `open_report(sessionId, fields: string[] | null) -> ReportSchema`, `close_report(sessionId)`,
  `run_report(sessionId, sql, slot) -> ReportResult { columns, rows, truncated, elapsedMs }`,
  `get_report_schema(sessionId) -> ReportSchema { table, columns: SchemaColumn[], sources, status }`; alle über `blocking`.
- `SessionUpdate.report: ReportStatus | null` (`state` building/indexing/ready/error, `progress`, `rows`, `lines`,
  `generation`, `reason`, `message`, `lowSpace`, `size`).
- Fehlercode `invalid_query`.
- `mock-ipc.js`: alle vier (Antworten für die Vorlagen aus den Mock-Zeilen).

## Messwerte

Siehe Spike. `measure_` (tail_integration, ohne Dashboard; Prompt verlangt „ohne geöffnetes Dashboard kein Unterschied“):

| | vorher | nachher |
|---|---|---|
| erste Zeilen | 24,1 ms | 25,7 / 24,1 ms |
| indexiert | 2,17 s | 2,36 / 2,20 s |
| Level-Filter | 30 ms | 38 / 37 ms |
| Suchfilter | 737 ms | 764 / 746 ms |
| `get_lines` 200 zufällig | 292 µs | 295 / 294 µs |
| Tail-Updates in 3 s bei 10k Zeilen/s | 29 | 28 / 29 |

Zwei Läufe nachher, bei Lastmittel 13–15 (Marcs `tauri dev` und Builds liefen mit). Ohne Dashboard ändert sich am
Einlesen nur ein `None` mehr im `SessionUpdate`; der Level-Filter schwankte in den Läufen von `measure_report` ohne
Dashboard zwischen 30 und 38 ms. Kein messbarer Unterschied.

## Fortschritt

- [x] Spike: Binärgrößen, Bundle, Aufbau/Abfrage/Tail auf 500 MB
- [x] `report_db.rs`: Tabelle, Builder (Stapel, Neuaufbau, Nachziehen, Platz), Abfragen mit allen Schutzschichten,
  `bucket()`, Cache-Ordner mit Sperre
- [x] Sitzung/Manager/Commands, `SessionUpdate.report`, `invalid_query`
- [x] Rust-Tests: `bucket` (UTC, DST, Tage), Absicherung (40 Anweisungen), Zeitlimit, Limits, Überholen, Werte,
  Absturz-Reste; Integration (Köpfe gleich Index, Zeiten, Felder, Zahlen in Basiseinheit, Tail, Rotation behalten/neu,
  Truncation, Freeze, Pause/Weiter, Schließen löscht, Abbruch im Aufbau, UTF-16/CRLF/ANSI, leer, Zeile ohne Ende,
  Merge mit `min(line)` und verspäteter Zeile)
- [x] Frontend: Modelle, `LogApi`, `invalid_query`, `report-logic.ts` (Reihen, Zeitachse, Kreis, Bereich, Intervall,
  Vorschlag), `dashboard-model.ts` (Vorlagen, Raster, Merge der Store-Datei), `DashboardStore` (`dashboards.json`),
  `ReportChartComponent` (uPlot lazy, Kreis, Tastatur, Daten-Attribute), `DashboardPanelComponent`,
  `DashboardComponent` (`@defer`), Modus je Tab, Toolbar, `⌘/Strg+Shift+D`, `showLine`/`filterFromDashboard`,
  `G` für ausgefilterte Zeilen; Tokens `--chart-*`
- [x] Vitest: Abbildung auf Reihen (Zeitachse, Serien aus Textspalte, NULL, keine Zeile, Kategorien, Grenzen),
  Kreis, Klick auf Zeitbereich und `min(line)`, Intervall, Vorschlag, Zellen, Fehlertexte; Vorlagen, Merge, Felder,
  Raster; Service: Sprung, ausgefilterte Zeile mit `G`, Filter aus einer Säule
- [x] e2e: keine Datenbank ohne Dashboard, Vorlage „Einträge je Level“ = Köpfe je Level (ERROR 1 statt 8 Zeilen),
  eigene SQL mit Fehlertext der Engine, `DELETE` abgelehnt und nichts gelöscht, Säulen ohne Zeitachse, Log läuft
  weiter und die Tabelle zieht nach (≈ 5 s), Live-Aktualisierung zeigt den neuen Fehler, Tabellenzeile springt,
  Punkt per Tastatur springt; Log darunter `inert`
- [x] `mock-ipc.js` (alle vier Commands), Screenshots `dashboard.png`, `dashboard-light.png`, `dashboard-sql.png`
- [x] Doku: README, CLAUDE.md, architecture (Entscheidung, Grenzen, Abhängigkeiten), roadmap, themes
- [x] `npm run check` grün (Kontrast 30/71 Paare, Vitest 244, Rust 133 + 73 Integration), `npm run e2e` siehe Bericht
- [ ] Sichttest von Hand (`npm run demo:log`, `npm run demo:app`, Dashboard öffnen), hell/dunkel, schmales Fenster
- [ ] Mausklick auf einen Punkt bzw. Balken im echten Fenster (e2e nimmt die Tastatur; die Zuordnung des Balkens bei
  gruppierten und gestapelten Säulen ist nur von Hand prüfbar)
- [ ] Volles Laufwerk im echten Betrieb (nur über die Meldung von `SQLITE_FULL` und die Platzprüfung im Code)
- [ ] Windows/Linux: `free_space`, `File::try_lock` auf dem Cache-Ordner und Löschen offener Dateien nur auf macOS
  geprüft
- [ ] Review durch einen separaten Agenten (Nutzer-SQL), veranlasst vom Koordinator
- [x] Prompt und Design nach `prompts/done/`; letzter Lauf `npm run e2e`: 295 Schritte grün
