# Architektur

Stand: Export und Arbeitsstand (Prompt 015), Zeitstrahl (Prompt 014), Filter als eigener Tab (Prompt 013), Dashboard und SQL-Timeline (Prompt 012), Felder aus der Nachricht (Prompt 011), Verkettete Filter (Prompt 010), Overview Ruler und Navigation (Prompt 007), Dateien zusammenführen (Prompt 006), Seitenleiste (Prompt 005), Detail-Panel (Prompt 004), Spaltenansicht (Prompt 009) und Formaterkennung (Prompt 008) auf Basis des Startauftrags, des Flacker-Fixes (001), des Freeze-Buttons (002) und
der GuiExpert Table (003). Dieses Dokument beschreibt
Entscheidungen, nicht Wünsche. Geplantes steht in `docs/roadmap.md` und in `prompts/`.

## Überblick

```
┌──────────────── WebView (Angular 22, zoneless, Signals) ──────────────┐
│  App ── Tabs, Toolbar, Sidebar, LogTableView, Splitter, DetailPanel   │
│   │      LogTableView: GuiExpert Table, Zeile + Pixel-Offset          │
│  LogSessionService (Root) ── Tabs, Aktionen, Fehleranzeige            │
│   └ SessionState je Tab ── update, Filter, Scroll, Auswahl,           │
│       displayedLines, PageCache (Seiten zu 200 Zeilen, max. 64)       │
│  SettingsService ── tauri-plugin-store, Theme und Farben              │
│  LogApi ── call.ts: einzige Stelle mit invoke()                       │
└──────┼───────────────────────────────────────────▲────────────────────┘
       │ Commands (get_lines, set_filter, find_*, …)│ Channel<SessionUpdate>
┌──────┼───────────────────────── Rust (Tauri 2) ───┼───────────────────┐
│  commands.rs   Argumente abbilden, Datei-Arbeit per spawn_blocking    │
│  session.rs    SessionManager, LogSession, Abfragen, Hintergrund-Jobs │
│  tail.rs       ein Worker-Thread je Datei: lesen, Rotation, Updates   │
│  indexer.rs    LineIndex (16 Byte/Zeile), LineSplitter, LineReader    │
│  level.rs / profile.rs   Level-Erkennung, Profile, Vorschlag          │
│  fields.rs / timestamp.rs   Format, Felder je Zeile, Zeitstempel      │
│  extract.rs    extrahierte Felder: Regeln je Profil, Werte, Vorschläge│
│  merge.rs      mehrere Dateien als eine Sitzung (Merger, Worker)      │
│  filter.rs     gefilterte Liste (inkrementell), Textsuche             │
│  filter_expr.rs  Filterbaum als ein Ausdruck: Blätter als Bitmaske    │
│  overview.rs   LevelSummary: Level-Bits je Abschnitt (Ruler, Sprünge) │
│  timeline.rs   TimeSummary: Zeiten/Einträge je 256 Zeilen (Zeitstrahl)│
│  report_db.rs  Dashboard: SQLite je Sitzung, Builder, sichere Abfragen │
│  export.rs / anchor.rs / workspace.rs   Export-Jobs, Anker, .lcw      │
│  encoding.rs / platform.rs   Encodings, ANSI; Share-Flags, Datei-ID   │
│  model.rs / error.rs   DTOs (camelCase), AppError { code, message }   │
│  e2e.rs        nur Debug-Build: Szenario im WebView                   │
└───────────────────────────────────────────────────────────────────────┘
        │ read_at (positionell), notify + Polling
        ▼
      Logdatei(en) – der Text bleibt dort, nicht im Speicher
```

## Datenfluss

1. **Öffnen:** `open_log(path, keepOnRotate, onUpdate)` öffnet die Datei mit Share-Flags (`platform.rs`), legt eine
   `LogSession` an und startet ihren Worker. Der erste Block wird gleich gelesen (Encoding, BOM, Profilvorschlag), damit
   `SessionInfo` schon etwas zu zeigen hat.
2. **Indexieren:** Der Worker liest in Blöcken zu 1 MiB, `LineSplitter` zerlegt in Zeilen, `LevelDetector` bestimmt Level
   und Fortsetzung. Je Zeile entsteht ein `LineEntry` (Offset, Länge, Level, Flag), der Filter wird im selben Schritt
   fortgeschrieben. Text für eine Filtersuche wird vor der Schreibsperre gelesen.
3. **Updates:** Höchstens etwa 10 `SessionUpdate` je Sekunde über einen Tauri-`Channel` (Zähler, Status, Größe, `epoch`,
   `viewGeneration`, Freeze-Zustand). Sie enthalten keine Zeilen.
4. **Anzeigen:** Das Frontend fragt sichtbare Bereiche per `get_lines(view, start, count)` ab, in Seiten zu 200 Zeilen. Rust
   liest den Text dafür aus der Datei (`LineReader` mit gleitendem Puffer), dekodiert, entfernt ANSI, kürzt auf 128 KB und
   zerlegt ihn mit dem `FieldParser` der Sitzung in Feldspannen (`fields`, Spalten über `get_columns`).
5. **Ändern:** `set_filter` und `set_profile` starten Hintergrund-Jobs. Eine neue `viewGeneration` macht gecachte Seiten
   ungültig, eine neue `epoch` die Zeilennummern.

## Entscheidungen

| Thema | Entscheidung | Begründung |
|---|---|---|
| Text im Speicher | Nein. Nur ein Index mit 16 Byte je Zeile, der Text wird bei Bedarf aus der Datei gelesen | Dateien mit vielen GB bleiben offen- und scrollbar. Grenze 2³² Zeilen je Sitzung (Index dann 64 GB). |
| Ansicht | GuiExpert Table (`log-table-view.ts`, `LogAreaModel`), eigenes Scroll-Modell: Position = Zeile + Pixel-Offset (`viewport-logic.ts`), die Tabelle zeichnet sie mit `repaintHard({ px, py })` bzw. `scrollToPixel`. Feste Zeilenhöhe, kein Umbruch, Ziehen an der Scrollleiste wird auf eine Zeile umgerechnet | Die Tabelle kappt die Scrollhöhe bei 8 Mio. px; mit dem eigenen Modell wandert die Ansicht beim Anhängen nicht. Messwerte: `prompts/done/003-gui-expert-table.design.md`. |
| Spaltenansicht | Dieselbe Tabelle mit ihrer Kopfzeile: je Feld aus `get_columns` eine Spalte, Zellen aus den Spannen (`cellSegments` schneidet die Segmente der Zeile, Treffer und Tokens bleiben). Fortsetzungs- und nicht zerlegte Zeilen spannen per Colspan ab der ersten sichtbaren Spalte. Layout (Reihenfolge, Breiten, ausgeblendet) je Profil in den Settings, Rohansicht per `T` | Kein zweiter Viewport; Breite und Reihenfolge zieht die Tabelle selbst. Kein Sortieren: die Ansicht ist nach Datei und Zeit geordnet und wächst live. Prompt 009. |
| Detail-Panel | Unter der Ansicht, per Splitter (`shared/splitter.ts`, wiederverwendbar) in der Höhe verstellbar. Zeigt den Eintrag von `selection().anchor`: `get_entry` liest Kopf und Fortsetzungen direkt aus dem Index (ohne Filter), höchstens 1 MiB, Schnitt an einer Zeichengrenze. Kopieren über `copy_lines` mit `view: all` liefert alles. JSON/XML formatiert ein eigener Tokenizer (`detail-format.ts`), der nur Einrückung und Farbe ändert. Neu geladen wird bei anderer Zeile, Tab, `epoch` oder `viewGeneration`, sonst nur ein Eintrag am Dateiende, höchstens ein Aufruf zugleich | Lange Zeilen und eingebettete Blöcke lesbar machen, ohne den Text im Frontend zusammenzusetzen (der `PageCache` hält nur gefilterte, gekürzte Zeilen). `JSON.parse` rundet 64-Bit-IDs, `DOMParser` scheitert an Fragmenten. Prompt 004. |
| Seitenleiste | Links neben Log und Detail-Panel, Breite per vertikalem Splitter (min. 180 px, Log min. 360 px), darin Baum und Statistik per horizontalem Splitter (`sidebarTreeShare`). Baum = reine Funktion (`tree-model.ts`) aus Sitzungen und `savedFilters`, WAI-ARIA-Tree mit rovingem `tabindex`; Statistik „Alle“ = `counts`, „Ansicht“ = `viewCounts` aus `FilteredLines` (Zähler in `append`, Zwischenzähler je Eintrag, beides im Checkpoint). Gespeicherte Filter in den Settings, `applyPreset` = ein Filter-Job | Zweite Sicht auf denselben Zustand statt zweiter Quelle. Zähler im Backend, weil das Frontend die Level der gefilterten Zeilen nicht kennt; Mehrkosten im Filter ~0,35 ns je Zeile. Prompt 005. |
| Merge | Eine Sitzung, ein Index für alle Quellen. Die Quelle steckt im virtuellen Offset (`offset >> 56`), die 16 Byte je Zeile bleiben; Filter, Suche, `entry_range`, Kopieren laufen unverändert, der Quellenfilter (`FilterSpec.sources`, `u16`) entscheidet am Kopf des Eintrags. `Merger` (rein) ordnet Einträge nach (Zeit, Quelle, Position); Laden streamt (die zeitlich hinterste Quelle wird gelesen, freigegeben wird unter dem kleinsten Stand aller unfertigen Quellen), eine ungeordnete Quelle startet das Laden neu und wird dann ganz gelesen und sortiert. Live nur Anhängen: Haltepuffer 1 s bis zum Wasserstand der aktiven Quellen, Verspätetes am Ende und gezählt, „Neu sortieren“ als neue Epoche. Truncation, Rotation ohne Behalten oder zu viele Segmente einer Quelle mischen alles neu. Spalten aus dem Format der ersten Datei | Einfügen in der Mitte würde Zeilennummern, gefilterte Liste und `PageCache` bei jedem Update ungültig machen. Eine Liste `(Sitzung, Zeile)` über offenen Sitzungen bräuchte eigene Wege für Filter und Suche. Messung 2 × 500 MB gegen 1 × 1000 MB: Spitzenspeicher +264 zu +259 MB, Filter und Suche gleich schnell, Öffnen 6,7 zu 4,3 s. Prompt 006. |
| Overview Ruler | Rechts neben der Tabelle, deren Scrollleiste bleibt (Ziehen daran ist schon auf Zeilen abgebildet). Ein `<canvas>` mit 14 px Breite: Level-Balken in zwei Spuren (FATAL+ERROR links, WARN rechts), Länge nach Dichte des Levels im Pixel, mindestens 3 px hoch und eine Mindestlänge für eine einzelne Zeile, Band des sichtbaren Bereichs, Lesezeichen als Fähnchen, Auswahl als Dreieck, darunter ein Button „Ans Ende“. Daten aus `get_overview(buckets, lines)`: Level-Bits und Dichte (0–255 je FATAL/ERROR/WARN: Anteil der Positionen in Abschnitten mit dem Level) je Pixel aus einer `LevelSummary` (`overview.rs`: ein Byte je Abschnitt, höchstens 64 K Abschnitte, bei Überlauf je zwei per ODER zusammengelegt). Eine im `LineIndex` für die Identität, eine in `FilteredLines` für jede Liste; Rückzug der provisorischen Zeile über den Checkpoint, Neu-Leveln baut eine neue und tauscht sie. `find_level` überspringt Abschnitte ohne passendes Bit und prüft im Rest Köpfe im Index, ohne Text zu lesen. Höchstens 2 Abfragen je Sekunde, nur bei geänderter Zahl, Ansicht, Epoche, Auswahl, Lesezeichen oder Höhe | Bei 10 Updates/s und Millionen Zeilen darf keine Abfrage den Index durchlaufen (500 MB: `get_overview` 0,2–0,3 ms, `find_level` ohne Treffer 0,13 ms, Einlesen unverändert). Positionen der Ansicht, nicht der Datei: Mit Filter passen Marken sonst nicht zum Balken. Prompt 007. |
| Navigation | `E`/`W` (Fehler, Warnungen und schwerer) über `find_level`, `N` über Lesezeichen (Zeilennummern im `SessionState`, nur im Speicher, neue `epoch` leert sie), Klick im Ruler. Alle setzen nur die Scrollposition, nie die Auswahl; der nächste Sprung geht vom letzten aus, solange nicht gescrollt wurde (`jumpMark`). `G` hebt Levels, Quellen und Filtersuche in einem `set_filter` auf (die Suche wird Hervorhebung), merkt den Filter und zeigt die gewählte Zeile erst mit der neuen `viewGeneration` (`pendingReveal`); nochmal `G` stellt ihn her, ein Filter von Hand verwirft ihn | Man springt zum Nachsehen weg und findet zurück. Bis zum Tausch der Ansicht liefert `get_position` die alte Position. Prompt 007. |
| Verkettete Filter | Der Filterbaum der Seitenleiste (`filter-tree.ts`, Knoten mit stabiler `id`, an/aus, Gruppen UND/ODER, NICHT) geht als `FilterExpr` mit `set_filter` an das Backend, kompiliert zu **einem** Ausdruck (`filter_expr.rs`): höchstens 64 Blätter als Bitmaske. Ausgewertet je Eintrag in `FilteredLines::append`: jede Zeile setzt ihre Blätter (ODER), der Baum entscheidet auf der Maske; Level-Chips und Suche bleiben ein UND darüber. Wird ein Eintrag durch NICHT und eine späte Fortsetzung falsch, wird er vom Ende der Liste abgeschnitten (`retractedFrom` im Update, das Frontend lädt ab dort neu). Abschnitte sind Zustand in Zeilenfolge, immer fortgeschrieben. Text vor der Sperre: `TextTest` (Suche plus Ausdruck) liefert je Zeile eine `Probe`, verglichen per Zeiger wie früher der Matcher. Text-Blätter über eine Alternation als Vorfilter und `RegexSet`; Feld- und Zeit-Blätter nur am Kopf; Level und Zeilen ohne Text. Schnellwege: markierten Text filtern (`I`, Rechtsklick), Zellwert, Abschnitt ab/bis zur Auswahl. Änderungen am Baum werden 150 ms gebündelt | Ein Ausdruck statt Listen je Knoten: Speicher bleibt `Vec<u32>`, Tail und Hintergrund-Job bleiben, die Ansicht hat ein Positionsmodell. Gemessen auf 500 MB: 1/5/20 Text-Blätter 0,8/0,8/1,0 s gegen 0,77 s für die Suche, Level- und Suchfilter unverändert. Inkrementell gleich Job ist durch Tests mit erzeugten Ausdrücken belegt. Prompt 010. |
| Filter-Tabs | Mehrere Ansichten (`ViewState`) in einer `LogSession` statt einer zweiten Sitzung: Index, Worker, Handles, Encoding, Format, Freeze und Dashboard gibt es je Datei einmal. Je Ansicht Filter, `FilteredLines`, `viewGeneration`, Job-Zähler, Checkpoint der provisorischen Zeile und ein eigener Channel (`open_view`, `close_view`, `viewId` an allen Abfragen). Kind = Eltern UND eigener Filter: `views.rs` setzt die Kette zu einem Filter zusammen (Level/Quellen geschnitten, Bäume und filternde Suchen der Eltern als ein UND vor dem eigenen Baum); ändert sich ein Elternteil, starten die Jobs aller Nachfahren, nachdem alles kompiliert ist. Schließen reicht den Filter an die Kinder weiter (`inherited`), Ansicht 0 wird dabei versteckte Identität. `ingest` bereitet die Proben aller Ansichten vor der Sperre vor und dekodiert den Text dabei einmal; unter der Sperre liest `Fresh` nur für geänderte Filter nach. Updates nur für geänderte Ansichten, eine nur gewachsene Datei höchstens 1×/s je weiterer Ansicht. Frontend: Tab-Id ≠ Sitzungs-Id, Lesezeichen je Datei, Name aus der Kette (`view-chain.ts`) | Eine zweite Sitzung würde die Datei doppelt indexieren und tailen. 500 MB: mit 1 Ansicht Einlesen 2,2 s wie vorher, mit 4/8 Ansichten (Jobs parallel zum Einlesen) 3,6/4,6 s, Listen 9/32 MB; Tail mit 10 000 Zeilen/s holt in allen Fällen ohne Rückstand auf. Prompt 013. |
| Dashboard | Eigener Modus je Tab über Tabelle, Ruler und Detail-Panel (`@defer`, die Tabelle bleibt montiert und live, `inert`). Je Sitzung eine SQLite-Datei im Cache-Ordner der App (`report_db.rs`), erst beim ersten Öffnen: Tabelle `log(line, ts, level, source, Felder)` mit einer Zeile je Eintragskopf; Zahlen in Basiseinheit (`parse_value`), Text nur angehakt. Builder-Thread mit eigener Verbindung, Stapel zu 16 384 Zeilen je Transaktion, Lesesperre nur zum Kopieren, Status in `SessionUpdate.report`; Zeitindex nach dem ersten Durchlauf; danach alle 5 s nachziehen, nur bei offenem Dashboard; neue Epoche, Spalten oder Felder bauen neu. Abfragen über `run_report` auf eigener Read-only-Verbindung mit Authorizer, `query_only`, `readonly()`, Limits, Zeitlimit (Progress-Handler), überholte Abfragen je Panel abgebrochen. Diagramme mit uPlot (lazy), Kreis selbst gezeichnet; Dashboards je Profil in `dashboards.json` (Store-Plugin) | Text und Index bleiben schlank, wer kein Dashboard öffnet, zahlt nichts. 500 MB: Aufbau 12,8 s, 226 MB, Fehler je Minute 1,0 s, `get_lines` +10 % während des Aufbaus, Filter und Tail unverändert. Prompt 012. |
| Zeitstrahl | Streifen über Tabelle und Ruler (`features/timeline/`, 56 px, `Z`, Setting `showTimeline`), Canvas mit gestapelten Säulen je Eimer (neutral, WARN, ERROR, FATAL), schraffierten Ausfällen, Band des sichtbaren Bereichs (Zeit der obersten/untersten Zeile im `PageCache` über Anker Zeile → Zeit), Achse in lokaler Zeit (UTC gerechnet). Daten aus `get_timeline(from, to, buckets)`: eine `TimeSummary` im `LineIndex` (`timeline.rs`) mit je Abschnitt zu 256 Zeilen erster/letzter Zeit, größtem Sprung und Einträgen (Köpfe) gesamt/WARN/ERROR/FATAL, verdichtet wie die `LevelSummary` (höchstens 64 K Abschnitte zu 64 Byte). Beim Einlesen entscheidet ein `TimeCursor` vor der Sperre, welche Köpfe geparst werden (erster mit Zeit, jeder 32., letzter; endet ein Abschnitt in Fortsetzungen, wird der letzte Kopf nachgelesen, ebenso am Ende jedes Blocks für das Live-Ende). Ohne Zeit im Sample wird nichts geparst. Der Merge reicht die Zeit seiner Köpfe durch. Abfrage: Abschnitte anteilig auf Eimer, am größten Sprung geteilt, wenn er ein Ausfall ist (zehnmal länger als die Zeilen dazwischen bei der Rate des Rests brauchten); ungeordnete Abschnitte als Punkt an ihrer ersten Zeit, Ausreißer-Abschnitte an ihrem Ende auf der Achse. Ganze Datei: Achse vom 1. bis 99. Perzentil, um das Dreifache erweitert bis zur äußersten Zeit darin. `position_at_time` sucht den Abschnitt in der Zusammenfassung und darin den ersten Kopf ≥ Zeit (Text lesen, `blocking`). Klick springt (Auswahl bleibt), Ziehen → „Als Filter“ (Zeit-Bedingung im Baum des Tabs, Prompt 010/013) oder Zoom; Laden höchstens 2×/s und nur bei geänderter Zeilenzahl, Epoche, Zoom oder Breite | Ein Scan je Abfrage oder die Datenbank aus 012 wären zu teuer bzw. nur bei offenem Dashboard da. 500 MB: Einlesen 2,27 → 2,38 s (unter Last gemessen; ein Parse kostet 235 ns, ~10 je 256 Zeilen ≈ 50 ms), `get_timeline` 0,6 ms, `position_at_time` 0,13 ms. Prompt 014. |
| Export | `export_view` startet einen Job (eigener Thread, `ExportJobs` mit Abbruch-Flag) und antwortet sofort mit der Id; Fortschritt über einen eigenen `Channel<ExportProgress>` höchstens alle 100 ms. `LogSession::export_cursor` legt das Ende beim Start fest, `export_batch` gibt Schritte zu 16 K Zeilen unter der Lesesperre heraus (neue Filterliste: weiter ab der nächsten Zeilennummer; neue Epoche: `file_changed`). Text ganz über `LineReader` + `display_text` (keine 128-KB-Grenze), in `.<name>.<pid>-<job>.part` daneben (`create_new`), am Ende `sync_all` und `rename`; Abbruch oder Fehler löscht. Ziel geprüft: absolut, ohne `..`, Endung des Formats, nicht die offene Datei (Pfad und Datei-Identität aller Segmente). CSV nach RFC 4180 mit BOM und `'` vor Formel-Zellen, JSON Lines mit Spalten-IDs | Gigabytes nie durch IPC; der Tail wartet nie. 500 MB: TXT 0,55 s, CSV mit 5 Spalten 9,8 s, `get_lines` daneben ≤ 0,6 ms. Prompt 015. |
| Anker und Arbeitsstand | Lesezeichen und Notizen (je Datei, im Frontend) werden beim Speichern zu Ankern `{line, source, offset, len, hash}` (`line_anchors`, FNV-1a über 256 Byte) und beim Öffnen gesucht (`resolve_anchors`: gleiche Nummer, sonst ±10 000 Zeilen um Nummer und alte Byte-Position, nur Zeilen gleicher Länge werden gelesen). Ein `.lcw` ist JSON mit `format`/`version` (Migration aus Version 1), Pfade absolut und relativ; das Backend liest und schreibt nur `.lcw` (≤ 8 MB, Temp + Rename), `parseWorkspace` prüft jedes Feld. Fehlende Dateien: `probe_paths`, Dialog „Suchen …“/„Überspringen“. Native Dialoge über `core/dialog/native-dialog.ts` (e2e: `window.__lcDialogPaths`) | Zeilennummern ändern sich beim Neuschreiben; der Hash macht „nicht gefunden“ ehrlich. Ein geteilter Arbeitsstand ist fremde Eingabe und bringt kein SQL mit (Dashboards bleiben je Format). Prompt 015. |
| Gezeichnet wird, was da ist | `displayedLines` trennt den Stand der Ansicht vom Stand des Backends. Der Tail rückt erst vor, wenn das neue Ende im `PageCache` liegt | Sonst blitzt je Update die Fläche ohne Level-Farbe auf. Prompt 001. |
| Virtuelle Offsets | Jede Datei einer Sitzung (vor und nach Rotation) belegt einen eigenen Offset-Bereich (`Segment`), der Handle bleibt offen, höchstens 32 Dateien | Zeilennummern bleiben bei „alte Zeilen behalten“ gültig, und das Lesen braucht keinen Pfad. |
| Gefilterte Ansicht | `FilteredLines`: bei Identität keine Liste, sonst `Vec<u32>` der Zeilennummern. Im Tail inkrementell, bei Filterwechsel neu per Job | Positionen in der Ansicht sind Indizes in die Liste, Suche und Kopieren arbeiten darauf. |
| Einträge | Fortsetzungszeilen (Einrückung, `at `, `Caused by:`, `Traceback`, `... `) werden vor der Regex geprüft und erben das Level. Ein Treffer in einer Fortsetzung bringt den ganzen Eintrag | `at com.acme.error.Handler` ist keine ERROR-Zeile, ein Stacktrace gehört zu seinem Kopf. |
| Provisorische letzte Zeile | Eine Zeile ohne `\n` wird nach 1 s Pause (oder am Ende des Ladens) angezeigt und beim Weiterschreiben ersetzt (Checkpoint im Filter) | Eine Datei ohne abschließenden Zeilenumbruch verschweigt ihre letzte Zeile nicht. |
| Freeze | Der Worker liest im Freeze nicht weiter, sendet aber Updates (Filter-Jobs melden sich über `tick()`) | Der Index steht, also sind Filter, Suche und Kopieren ohne Zusatzcode konsistent. Wird die Datei im Freeze geleert, warnt die Statusleiste, zurückgesetzt wird erst beim Fortsetzen. Prompt 002. |
| Rotation und Truncation | Datei-Identität je OS (`platform.rs`; Windows `GetFileInformationByHandle`, nicht die Erstellzeit, wegen File Tunneling), Truncation über die kleinere Größe | Erkennt `logrotate` (umbenennen) und `copytruncate`. Grenze: Leeren und Neuschreiben über die alte Größe hinaus zwischen zwei Prüfungen bleibt unbemerkt. |
| Beobachten | `notify` plus Polling (250 ms, bei aktivem Schreiber 100 ms) | `notify` ist auf Netzlaufwerken und in Docker-Volumes unzuverlässig. |
| Felder | Beim Ausliefern in `get_lines`, nicht beim Indexieren: Spannen `[start, end)` in UTF-16 je Spalte. Format aus 200 Zeilen beim ersten Block (`detect_format`): bestes eingebautes Layout ab 80 % der Eintragsköpfe, sonst Inferenz (Trenner oder Zeitstempel/Level/Thread/Logger), sonst nur `message`. Layouts sind Teil der `Profile` (`layouts`, `structure` für JSON, logfmt, FIX, W3C) | Der Index bleibt bei 16 Byte, Filter, Suche und Tail werden nicht langsamer. Spalten bleiben je Sitzung fest, ein Profilwechsel tauscht sie mit der neuen `viewGeneration`. Prompt 008. |
| Extrahierte Felder | Regeln `{ id, name, column, pattern, kind, unit }` je Profil in den Settings, im Backend im `RuleBook` (geteilt von allen Sitzungen, `set_extract_rules` wirkt sofort auf alle Tabs des Profils, `load_extract_rules` beim Start). `FieldParser::with_rules` hängt die Spalten (`kind` `percent`/`duration`/`size`/`number`/`text`, `unit`, `rule`) hinter die des Formats; neue `columnsRevision` und `viewGeneration`, die Datei wird nicht neu gelesen. Regel = Regex mit genau einer Gruppe, erster Treffer in der Spanne der Quellspalte (erste 16 KB), Spannen dürfen die Nachricht überlappen. Fortsetzungszeilen ohne Extraktion. Ab 5 Regeln einer Quelle entscheidet ein `RegexSet`, welche laufen. Werte für Vergleiche über `parse_value` in Basiseinheit (s, Byte mit 1024er-Stufen, Prozent); unklare Zahlen (`1,234`) fehlen. Vorschläge (`suggest_fields`, blocking): bis 2000 Köpfe gleichmäßig über die Datei, `name=wert`, `name: wert`, `wort wert einheit`; weg fallen Namen von Spalten, IDs (Name oder fast eindeutige Ganzzahlen), Zeiten, Konstanten und Felder unter 5 %; höchstens 10. Im Frontend Hinweis in der Statusleiste (einmal je Profil), Dialog „Felder“, „Spalte aus Auswahl“ (`rule-from-selection.ts`) mit Vorschau über das Backend | Ein Index je Feld kostete Speicher je Zeile; eine Regex je sichtbare Zeile ist billig (5000 Zeilen: 7,8 → 11,8 ms mit 4, 12,8 ms mit 16 Regeln). Vorschlagen statt still anlegen: Spalten bleiben fest (008). Prompt 011. |
| Jobs | Filter und Neu-Leveln laufen in eigenen Threads, abbrechbar über eine Generation. Die letzten Zeilen werden unter der Sperre nachgezogen | Kein Halt im Tail, keine Zeile fällt zwischen Liste und Ende. |
| Fehler | `AppError { code, message }` mit `snake_case`-Codes (`not_found`, `permission_denied`, `invalid_search`, `too_large`, …), gespiegelt in `app/core/errors/` | Stabile Codes für deutsche UI-Texte, die Originalmeldung bleibt als Detail. |
| Backend-Zugriff | `LogApi` im Frontend, `invoke()` nur in `call.ts` | Ein Ort für die Fehlerabbildung und den Fall „kein Backend“ (Browser, Screenshots). |
| Frontend-Zustand | `SessionState` je Tab (Signals, `linkedSignal`), `LogSessionService` als Root-Service für Tabs und Aktionen | Ein Viewport rendert den aktiven Tab, kein DOM je Tab. |
| Einstellungen | `tauri-plugin-store` (`settings.json`), nachsichtiges Zusammenführen in `mergeSettings` | Kaputte oder alte Werte fallen auf Vorgaben zurück, statt den Start zu verhindern. |
| Farben | Tokens nur in `src/styles.css`, dark und light, WCAG AA geprüft (`npm run contrast`) | Details in `docs/themes.md`. |
| Hintergrund | `backgroundThrottling: disabled` | Ein Live-Viewer muss auch hinter anderen Fenstern aktuell bleiben. |
| CSP | strikte CSP mit `dangerousDisableAssetCspModification: ["style-src"]` | Sonst ergänzt Tauri Nonces, `'unsafe-inline'` gilt nicht mehr und Angulars Komponenten-Styles fehlen. `script-src 'self'` bleibt strikt. |
| Capabilities | Nur für `main`: Events, Pfad-Auflösung, Fenstertitel, Öffnen-Dialog, Store, CLI. Kein `tauri-plugin-fs`, keine Shell | Alle Dateizugriffe laufen über eigene Commands, das Frontend kann keine beliebigen Pfade lesen. |
| Öffnen | Dialog, Menü (`Cmd/Ctrl+O`, für einen Pfad `Cmd/Ctrl+Shift+O`), Datei-Drop, Kommandozeile (`tauri-plugin-cli`), zuletzt geöffnete Dateien; Zusammenführen per Dialog (`Cmd/Ctrl+Shift+M`, Menü `menu-merge`, Tab-Leiste, Startseite) | Ein Weg im Service (`tryOpen`, für Merges `openMerged`), eine schon offene Datei aktiviert ihren Tab; ein Merge wird über seine sortierten Pfade erkannt und landet nicht in „zuletzt geöffnet“. |
| Ende-zu-Ende | Debug-Build mit `e2e.rs`: Das Szenario aus `LC_E2E_SCRIPT` läuft im echten WebView gegen das echte Backend und meldet über stdout. Der Harness ändert die Datei auf Zuruf | Prüft Tail, Rotation und Truncation so, wie Nutzer sie erleben. Release-Builds enthalten das Modul nicht. |
| Screenshots | Gebautes Frontend in Playwright-WebKit mit IPC-Mock (`scripts/e2e/mock-ipc.js`), Daten aus `samples/` | Gleiche Bilder auf jedem OS, ohne Rust-Build und ohne Fensterrechte. |

## Grenzen

- Höchstens 2³² Zeilen und 32 Dateien (Segmente) je Sitzung, danach beginnt sie neu.
- Filter-Tabs: höchstens 8 Ansichten je Datei, je Ansicht bis 4 Byte je Zeile; die Kette zusammen höchstens 64
  Bedingungen. Weitere Ansichten eines Merges lesen den Text beim Schreiben unter der Sperre (Ansicht 0 wie bisher davor).
  Ein Dashboard gilt für die Datei: schließt es ein Tab, pausiert der Aufbau auch für die anderen Tabs der Datei.
- Dashboard: Abfragen nur lesend, eine Anweisung, 10 000 Zeilen bzw. 32 MB, 10 s, 64 KB SQL, 64 KB je Wert, `LIKE`-Muster
  256 Zeichen, 50 Spalten, höchstens 6 Abfragen zugleich, SQLite-Heap prozessweit 768 MiB (Sortieren nur im Speicher); Text-Felder
  auf 1 KB gekürzt; immer die ganze Datei (nicht die gefilterte Ansicht); Einträge ohne Zeit haben `ts` NULL. Unter
  256 MB freiem Speicher baut es nicht weiter. `bucket` mit s/m/h in UTC, Tage ab lokaler Mitternacht.
- Filterbaum: höchstens 64 Bedingungen, 16 Ebenen, 4096 Zeichen je Muster oder Wert. Feld- und Zeitbedingungen lesen den
  Kopf eines Eintrags (bei einem Merge mit dem Format und der Zeitstempel-Erkennung der ersten Datei); Zeilenbedingungen
  meinen Zeilennummern und gelten nach einem Neubeginn (Truncation) für die neuen Zeilen.
- Zeitstrahl: zeigt immer die ganze Datei (nicht die gefilterte Ansicht); Zahlen je Eimer angenähert, Ausfälle in
  einem Abschnitt auf eine Probe (32 Zeilen) genau; Uhrzeit-Logs ohne Datum: der Zeitstrahl zählt Tageswechsel
  fortlaufend, die Zeit-Bedingung des Filters nicht (wie in 010); beim Merge liest `position_at_time` die Zeit mit dem
  Format der ersten Datei (sonst Anfang des Abschnitts).
- Export: Ende fest beim Start; eine Truncation während des Exports bricht ihn ab. Mit Spalten zählen die ersten 16 KB
  einer Zeile für die Felder. Arbeitsstand: höchstens 32 Dateien, 8 Tabs je Datei, 10 000 Lesezeichen bzw. Notizen je
  Datei, 2000 Zeichen je Notiz, 8 MB; Filter geschlossener Eltern-Tabs gehen nicht mit. Teilen: 64 KB, 20 000 Zeilen.
- Anzeige 128 KB je Zeile, Suche 1 MB je Zeile. Eine Zeile ohne Ende wird bei 16 MB geteilt.
- Felder: zerlegt werden die ersten 16 KB einer Zeile, höchstens 12 Spalten aus JSON-/logfmt-Schlüsseln bzw. FIX-Tags.
  Nach einer Rotation mit anderem Format fallen die neuen Zeilen auf `message` zurück.
- Extrahierte Felder: höchstens 32 Regeln je Profil, ein Treffer je Zeile, keine Felder aus Fortsetzungszeilen. Eine Regel,
  die in einer anderen Datei desselben Profils mit einer Spalte kollidiert (JSON-Schlüssel), fehlt dort.
- Detail-Panel: höchstens 1 MiB Text je Eintrag (Kopieren ohne diese Grenze), formatiert wird bis 256 KB.
- `get_lines` liefert höchstens 5000 Zeilen je Aufruf. Kopieren höchstens 1 Mio. Zeilen bzw. 256 MB.
- Mehrere Rotationen während eines Freeze: Zwischenstände fehlen.
- Merge: höchstens 16 Dateien; verspätete Zeilen stehen am Ende bis „Neu sortieren“; keine Zeilennummer der Quelldatei
  (das Detail-Panel zeigt Datei und Byte-Offset); ohne Zeitzone gilt die lokale Zone; eine Zeile ohne Ende wird nach 1 s
  endgültig, ihr Rest eine eigene Zeile; Spalten nur nach dem Format der ersten Datei. Eine ungeordnete Quelle braucht
  beim Laden zusätzlichen Speicher (sie wird ganz gelesen und sortiert).

## Abhängigkeiten

| Paket | Zweck | Begründung |
|---|---|---|
| `tauri` 2 mit `tauri-plugin-cli`, `-dialog`, `-store`, `-window-state` | Fenster, IPC, Öffnen- und Speichern-Dialog (`dialog:allow-save` für Export und Arbeitsstand), Einstellungen, Fenstergröße, Kommandozeile | Offizielle Plugins, schmale Capabilities. |
| `notify` 8 | Dateiänderungen | Standard im Rust-Ökosystem, Polling als Rückfall. |
| `rusqlite` 0.41 (`bundled`, `functions`, `hooks`, `limits`) | Dashboard-Datenbank und Nutzer-SQL (Prompt 012) | Echtes SQL ohne Dienst, +1,8 MiB (DuckDB: +43 MiB, Minuten Bauzeit). Gebaut ohne Extension-Loading (`.cargo/config.toml`: `SQLITE_OMIT_LOAD_EXTENSION`, `SQLITE_DQS=0`); Authorizer, Progress-Handler und Limits brauchen `hooks`/`limits`. |
| `libc` 0.2 (nur Unix) | `statvfs` für den freien Speicher vor dem Aufbau | War schon im Baum; Windows nutzt `GetDiskFreeSpaceExW` aus `windows-sys`. |
| `uplot` 1.6 (npm) | Diagramme im Dashboard | 22 KB gzip, eigener Lazy-Chunk, Canvas, kein `eval` (ECharts: 169–368 KB, enthält `new Function`); CSS 1,9 KB global (`angular.json`). |
| `chrono` 0.4 (nur `clock`, `std`) | Zeitstempel ohne Zone in lokaler Zeit, Datum aus der Änderungszeit (`timestamp.rs`, auch für den Merge aus Prompt 006) | Zeitzonen und Kalender von Hand sind fehleranfällig; ohne Standard-Features klein. |
| `regex` 1 | Profile, Level-Erkennung, Layouts, Suche | Lineare Laufzeit, kein ReDoS durch Nutzermuster. |
| `memchr` 2 | schneller Zeilensplit | War über `regex` schon im Baum. |
| `encoding_rs` 0.8 | Dekodieren (UTF-8, UTF-16 LE/BE, Latin-1) | Bewährt, stammt aus Firefox. |
| `parking_lot` 0.12 | `RwLock` der Sitzungsdaten | Kurze Sperren ohne Poisoning. |
| `serde`, `serde_json`, `thiserror` | DTOs, JSON-Level, Fehler | Standard. |
| `windows-sys` 0.61 (nur Windows) | Datei-Identität | `GetFileInformationByHandle` statt Erstellzeit. |
| Angular 22, `@tauri-apps/api` samt Plugin-Paketen, `rxjs` | Oberfläche | Vorgabe. Kein UI-Framework, kein CDK. |
| Dev: Vitest + jsdom, angular-eslint, Prettier, `playwright` (nur Screenshots), `tempfile` | Tests und Werkzeuge | Kein Laufzeitcode. |

Neue Abhängigkeiten kommen mit Begründung in diese Tabelle (Prompt 000, Phase 5).
