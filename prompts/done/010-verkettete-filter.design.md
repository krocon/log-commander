# 010 Verkettete Filter – Design und Stand

Status: umgesetzt, nicht committet · Datum: 2026-11-07 · Branch `feat/verkettete-filter`

Marc hat die Prompts zur selbständigen Abarbeitung freigegeben; wo 000 oder der Prompt „anhalten und fragen“ sagt, ist
hier die Entscheidung mit Optionen und Grund festgehalten.

## Abweichungen vom Stand des Prompts

- Die Zeilenangaben stimmen nicht mehr: `FilterSpec` ~`filter.rs:113`, `append` ~`:300`, `FilterCheckpoint` ~`:170`,
  `ingest` `tail.rs:305`, `same_matcher` entfiel, `run_filter`/`feed` `session.rs:1057/1152`, `applyFilter`
  `log-session.service.ts:221`. Die alte eigene Ansicht (`log-view.ts`, `.row`) gibt es nicht mehr: Kontextmenü und
  Kürzel hängen an der GuiExpert Table (`log-table-view.ts`, neu `row-menu.ts`).
- Alle Voraussetzungen (005, 007, 008, `timestamp.rs`) sind da: Feld- und Zeitbedingungen sind umgesetzt.

## Entscheidungen

| Frage | Optionen | Entscheidung | Grund |
|---|---|---|---|
| IPC-Form | eigener Command / `set_filter` erweitern | `set_filter` mit optionalem `expr` | „in einem Aufruf“ (Prompt), alte Aufrufer bleiben gültig |
| Fehler am Knoten | eigener Code / `invalid_search` + Feld | `AppError.nodeId` (optional), Code bleibt `invalid_search` | Vorgabe des Prompts; das Frontend trennt Suche (ohne `nodeId`) und Baum |
| Text vor der Sperre | `matched: bool` + zweite Maske / ein Typ | `TextTest` (Matcher + Ausdruck) liefert `Probe { matched, leaves }`, Vergleich per Zeiger | ein Weg für Tail, Merge (`MergedLine.probe`) und Job; der Fall „Filter wechselt im Stapel“ bleibt wie bisher |
| Verneinung im Tail | Liste neu bauen / Ende abschneiden | Eintrag liegt am Ende → `truncate` auf die Länge vor dem Kopf, Zähler und Ruler-Zusammenfassung aus dem Eintrags-Schnappschuss | O(Eintrag), kein Job |
| Frontend nach Rücknahme | Cache leeren / ab Stelle neu laden | `SessionUpdate.retractedFrom` (kleinste Länge seit dem letzten Update), `invalidateTail` ab dort | gleiche Zahl kann andere Zeilen bedeuten; leeren würde flackern |
| Rücknahme + provisorische Zeile | – | Checkpoint enthält den Ausdrucks-Zustand; `restore` setzt eine abgeschnittene Liste wieder an (zusammenhängend bis zur Zeile davor) | sonst fehlt der Eintrag nach dem Rückzug |
| Mehrere Text-Blätter | `RegexSet` allein / Alternation | Alternation aller Muster als Vorfilter (`is_match`, Literal-Vorfilter), `RegexSet::matches` nur bei Treffer; ein Blatt: einzelne Regex | `RegexSet` allein kostete bei 5 Blättern 1,8 s statt 0,8 s |
| Faulheit | dreiwertige Auswertung / einfache Regeln | Text nur, wenn Blätter offen sind und der Eintrag nicht schon (monoton) drin ist; Level/Zeilen ohne Text; Abschnitte immer | dreiwertig wäre falsch: spätere Zeilen ändern die Maske |
| Feld/Zeit | jede Zeile / Kopf | nur der Kopf (`!continuation`), Fortsetzungen erben | Prompt; Probes des Merge rechnen sie für jede Zeile, der Filter maskiert sie |
| Zeit-Parser | Zustand fortschreiben / je Kopf klonen | Vorlage aus der Stichprobe, je Kopf geklont | Ergebnis hängt nicht von vorher Gelesenem ab, Tail = Job; Tageswechsel bei reinen Uhrzeit-Logs zählt dadurch nicht |
| Zeit-Eingabe | Datumswähler / Text | Text wie im Log, auch ohne Sekunden oder nur Datum, mit `timestamp.rs` gelesen | keine zweite Zeitlogik |
| Spaltenwechsel | Backend kompiliert neu / Frontend setzt neu | Frontend setzt den Filter neu, wenn `columnsRevision` wechselt und Feldbedingungen da sind | Ausdruck bleibt unveränderlich |
| Form-Prüfung | erst beim OK / live | Jede Änderung geht (150 ms gebündelt) in den Baum, Unvollständiges wartet; Abbrechen stellt her | „Sofortprüfung über Debounce“ |
| Wurzel im Baum | unsichtbar / Knoten | Knoten „Bedingungen“ unter „Aktiver Filter“ mit UND/ODER, `+`, `+( )`, `×` | Ort für die Verknüpfung der obersten Ebene |
| Erste Bedingung | „Aktiver Filter“ immer zeigen / Knopf an der Datei | `+` an der aktiven Datei (und `A`), dazu die Schnellwege | Baum aus 005 bleibt unverändert, solange nichts gefiltert ist |
| Kürzel | – | `I`/`Shift+I` (markierten Text filtern/ausschließen), `>`/`<` (Abschnitt ab/bis Auswahl); im Baum `A`, `Shift+A`, `Space`, `N`, `Enter`, `Entf`, `Alt+↑/↓` | gegen README, `log-table-view.ts`, `app.ts`, `toolbar.ts` geprüft; der Baum ist im globalen `onKey` ausgenommen |
| Spaltenkopf | Kopfmenü / Zelle | „Filtern nach … = …“ im Kontextmenü der Zelle | Prompt sagt „Zelle oder Spaltenkopf“; Kopf braucht eine gewählte Zeile, steht in der Roadmap |
| Gespeicherte Filter | – | `version: 2`, `tree`; Einträge aus 005 bekommen beim Laden einen leeren Baum, Levels/Suche bleiben | „kein Verlust“ |
| `G` | – | hebt den Baum mit auf (`KeptFilter.tree`), stellt ihn wieder her | Prompt 007 zusammengeführt |
| Farben | neue Tokens / vorhandene | `--accent` (Verknüpfung), `--danger` (Fehler, NICHT), `--text-dim` (aus) | keine neuen Tokens, `npm run contrast` unverändert |

## Messwerte (500 MB, 5,1 Mio. Zeilen, Release, `measure_`)

| | vorher | nachher |
|---|---|---|
| indexiert | 2,16 s | 2,2–2,5 s (Streuung zwischen Läufen) |
| Level-Filter | 35 ms | 24–35 ms |
| Suchfilter | 0,75 s | 0,77–0,83 s |
| Baum, 1 / 5 / 20 Text-Blätter (ODER) | – | 0,82 / 0,84 / 0,98 s |
| `get_lines` 200 / 5000 mit Layout / ohne | 298 µs / 7,5 / 1,2 ms | 299–334 µs / 7,4 / 1,2 ms |
| Tail 10k Zeilen/s | 29 Updates in 3 s | 29–30 |
| Merge 1000 MB: Suche / Level | 1,47 s / 48 ms | 1,54 s / 49 ms |

## Fortschritt

- [x] Rust: `filter_expr.rs`, `FilterSpec.expr`, Auswertung je Eintrag, Rücknahme, Checkpoint, Abschnitte,
  `TextTest`/`Probe` in Tail, Merge und Job, Highlight der Text-Bedingungen, `AppError.nodeId`, `retractedFrom`
- [x] Rust-Tests: Tabelle UND/ODER/NICHT, Kopf/Stacktrace, späte Rücknahme, Abschnitte (offen, zu, wieder, ohne Ende,
  im ODER), provisorische Zeile für jede Art, 64/65 Blätter; Integration (`tests/expr_integration.rs`): 40 erzeugte
  Ausdrücke inkrementell = Job, Rücknahme im Tail, Filterwechsel während `ingest`, Rotation/Truncation/Freeze, Merge
- [x] Frontend: `filter-tree.ts`, Form (`condition-form.ts`, `condition-dialog.ts`), Baum in der Seitenleiste,
  Kontextmenü (`row-menu.ts`), Kürzel, Statusleiste, gespeicherte Filter, `G`
- [x] Vitest, e2e (Request-ID per Markierung, UND/ODER, Häkchen, Abschnitt, Fehler am Knoten), Doku, Screenshots
- [ ] Sichttest mit `npm run demo:log`/`demo:app`, hell und dunkel, schmales Fenster: von Hand offen
- [ ] Ziehen im Baum (HTML5 Drag & Drop) nur im Code, nicht in e2e; unter Windows mit `dragDropEnabled` offen
