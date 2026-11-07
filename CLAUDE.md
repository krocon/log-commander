# CLAUDE.md – Log Commander

> Leitfaden für Claude (und Menschen). Plattformübergreifender Live-Log-Viewer: Tauri 2 + Angular 22 (zoneless, Signals)
> + Rust. Architektur analog zu **files-and-folders-tauri** und **editlicious** (gleicher Autor, MIT).
> Autor: Marc Kronberg · Repo: https://github.com/krocon/log-commander

## Befehle (Root, npm, Node ≥ 22, Rust stable)

| Zweck | Befehl |
|---|---|
| App starten (Dev) | `npm run tauri:dev` (Dev-Server Port 1450 + Fenster); auch `cargo tauri dev` nach `cargo install tauri-cli` |
| Datei per CLI im Dev | `npm run tauri:dev -- -- -- /pfad/app.log` (npm schluckt das erste `--`, mit zweien landen Cargo-Argumente in der App und die Datei wird ignoriert) |
| Live-Demo | `npm run demo:log` (schreibt `/tmp/app.log`), `npm run demo:app` (öffnet sie), `npm run demo:clean` |
| Frontend-Tests | `npm test` (Vitest + jsdom über `ng test`) |
| Lint / Format | `npm run lint`, `npm run format`, `npm run format:check` |
| Rust | `npm run rust:fmt`, `npm run rust:lint` (clippy `-D warnings`), `npm run rust:test` |
| Alles außer E2E | `npm run check` |
| E2E im echten WebView | `npm run e2e` (Debug-Build, echtes Backend, echte Datei; `-- --no-build` zum Wiederholen). Das Fenster öffnet ohne Fokus hinter den anderen |
| Spike-Messung (Frames) | `node scripts/e2e/run.mjs --scenario scripts/e2e/spike-003.js --foreground` (`--foreground`: Fenster vorn und mit Fokus wie beim normalen Start, sonst misst es verdeckt) |
| Messung 500 MB | `cd src-tauri && cargo test --release --test tail_integration -- --ignored --nocapture measure_` |
| Messung Export 500 MB | `cd src-tauri && cargo test --release --test export_integration -- --ignored --nocapture measure_` |
| Messung Dashboard | `cd src-tauri && cargo test --release --test report_integration -- --ignored --nocapture measure_` |
| Messung Feld-Regeln | `cd src-tauri && cargo test --release --test extract_integration -- --ignored --nocapture measure_` |
| Messung Merge 2 × 500 MB | `cd src-tauri && cargo test --release --test merge_integration -- --ignored --nocapture measure_merge` |
| Kontrast WCAG AA | `npm run contrast` (prüft `src/styles.css`) |
| Screenshots für die Doku | `npm run build`, dann `node scripts/screenshots.mjs` (WebKit + IPC-Mock) |
| Log-Generator | `node scripts/gen-log.mjs /tmp/app.log --rate 5000 [--format …] [--rotate-every N] [--truncate-every N] [--metrics]` (`--metrics`: `cpu= mem= took` für Prompt 011); Lücken (014): `--start ISO --pause-after N --pause MIN` |
| Icons neu | `npx tauri icon src-tauri/icons/source/app-icon.svg -o src-tauri/icons` (danach `android/`, `ios/` löschen) |

## Layout

```
src/                         Angular 22 (zoneless, Signals, OnPush, Standalone)
  styles.css                 Design-Tokens dark/light (einzige Stelle für Farben), Blöcke @theme … @end prüft check-contrast
  app/app.ts                 Root: Layout, Öffnen (Dialog, Menü, D&D, CLI), globale Kürzel
  app/core/backend/call.ts   einzige Stelle mit invoke()
  app/core/errors/           AppError (Codes = Rust error.rs), Texte
  app/core/log/              LogApi, DTOs (= Rust model.rs)
  app/core/settings/         SettingsService (tauri-plugin-store, wendet Theme/Farben an), reine Merge-Logik
  app/features/sessions/     LogSessionService (Tabs, alle Aktionen), SessionState (je Tab), PageCache, filter-logic,
                             filter-tree (Filterbaum: Knoten, Verschieben, zu FilterExpr kompilieren),
                             format-logic (Spalten, Formattext), navigation-logic (Lesezeichen, Sprung, Gesamtlog),
                             view-chain (Filter-Tabs: Namen der Kette, Grenze 8, Schließen)
  app/features/log-table/    LogTableViewComponent (GuiExpert Table), LogAreaModel, viewport-logic (reines
                             Scroll-Modell), table-logic, highlight (Inline-Tokens, cellSegments), columns-logic
                             (Spaltenansicht: Layout, Breiten, Spannen), column-menu (Spaltenmenü),
                             overview-ruler + ruler-logic (Overview Ruler, Canvas)
  app/features/fields/       FieldsDialog „Felder“ (Prompt 011), fields-logic (Prüfen, Vorschläge), rule-from-selection
  app/features/merge/        MergeDialog (Prompt 006), merge-logic (Quellenmaske, Namen, Farben, Dialogregeln)
  app/features/detail/       DetailPanel (Prompt 004), detail-format (JSON/XML-Tokenizer), detail-logic (Layout, Neuladen)
  app/shared/splitter.ts     wiederverwendbarer Splitter (Pointer Events, Tastatur), Rechnung in splitter-logic.ts
  app/features/sidebar/      Seitenleiste: Baum (tree-model, log-tree), Statistik (stats-panel), Layout (sidebar-logic/-state)
  app/shared/                splitter (wiederverwendbar), session-marks (Tabs und Baum), format
  app/features/timeline/     Zeitstrahl über dem Log (014): timeline.ts zeichnet, timeline-logic.ts rein (Säulen, Lücken, Ticks)
  app/features/toolbar|statusbar|tabs|start|settings/   UI
  app/features/export|workspace|share|notes/   Export-Dialog und Jobs, Arbeitsstand (.lcw), Teilen, Notizen (Prompt 015)
  app/core/dialog/native-dialog.ts   nativer Öffnen/Speichern-Dialog; e2e legt Antworten in window.__lcDialogPaths
src-tauri/src/               Rust; alles außer commands.rs und lib.rs ist frei von Tauri
  session.rs                 LogSession, Ansichten (ViewState), Abfragen, Hintergrund-Jobs (Filter, Level neu), SessionManager
  views.rs                   Filter-Tabs (013): ViewFilter, Kette zu einem Filter zusammensetzen, MAX_VIEWS
  tail.rs                    Worker je Datei: Blöcke lesen, notify + Polling, Teilzeile, Truncation, Rotation, Updates
  indexer.rs                 LineIndex (16 Byte je Zeile), LineSplitter, LineReader, Segmente
  level.rs, profile.rs       Level-Erkennung, eingebaute und eigene Profile (samt Layouts), Vorschlag
  fields.rs                  Formaterkennung, Felder je Zeile (Spannen in UTF-16), JSON/logfmt/FIX/W3C-Scanner, Inferenz
  extract.rs                 extrahierte Felder (Prompt 011): ExtractRule, RuleBook je Profil, Extractors, parse_value, suggest
  timestamp.rs               Zeitstempel erkennen und nach µs UTC wandeln (auch für den Merge, Prompt 006)
  filter.rs                  gefilterte Zeilenliste (inkrementell), Textsuche
  timeline.rs                TimeSummary (014): Zeiten und Einträge je 256 Zeilen, Zeit-Eimer, Achse, Lücken, Ausdruck je Eintrag
  filter_expr.rs             Filterbaum: FilterExpr (UND/ODER/NICHT, Text, Level, Feld, Zeit, Abschnitt, Zeilen) kompiliert, Quellenmaske
  overview.rs                LevelSummary: Level-Bits je Abschnitt für Overview Ruler und find_level (max. 64 KB)
  merge.rs                   mehrere Dateien als eine Sitzung: Merger (rein), Worker (Folgen, Rotation, Haltepuffer)
  encoding.rs, platform.rs   Encodings, ANSI; Share-Flags und Datei-Identität je OS
  report_db.rs               Dashboard (012): SQLite je Sitzung, Builder-Thread, abgesicherte Abfragen, bucket()
  export.rs, anchor.rs       Export als Job (Temp-Datei, Umbenennen, CSV/JSONL), Anker für Lesezeichen/Notizen
  workspace.rs               .lcw lesen/schreiben (nur diese Endung, ≤ 8 MB), Pfade prüfen
  e2e.rs                     nur Debug-Build: Szenario im WebView (Fenster im Hintergrund), siehe scripts/e2e/
scripts/e2e/                 run.mjs (Harness), scenario.js (läuft im WebView), mock-ipc.js (nur für Screenshots)
samples/                     Beispiel-Logs
```

## Entscheidungen

- **GuiExpert Table als einzige Ansicht, eigenes Scroll-Modell** (Prompt 003, ab `@guiexpert/table` 1.1.107). Das CDK
  macht ein Element so hoch wie alle Zeilen und endet am Browser-Limit (~33 Mio. px). Die Tabelle kappt die Scrollhöhe bei
  8 Mio. px; die Position bleibt trotzdem Zeile + Pixel-Offset (`viewport-logic.ts`), die Tabelle zeichnet sie nur:
  `repaintHard({ px, py })` bei neuer Zeilenzahl (ein Render), sonst `scrollToPixel`. So wandert die Ansicht beim
  Anhängen nicht. Das Rad läuft über das eigene Modell; Ziehen an der Scrollleiste rechnet `onTableScroll` auf eine Zeile um.
  Feste Zeilenhöhe, kein Zeilenumbruch. `getValueAt` ist synchron: Nicht geladene Zeilen sind Platzhalter (`loading`).
  Messwerte und Abwägung: `prompts/done/003-gui-expert-table.design.md`.
  **Spaltenansicht (Prompt 009) auf derselben Tabelle**, nicht auf einem eigenen Viewport: je Feld eine Tabellenspalte, Kopfzeile
  der Tabelle (Breite ziehen, Titel ziehen, `role="columnheader"`), Rohansicht = die zwei Spalten von 003 (`T`, Schalter
  in der Toolbar, `columnMode`). Die Tabelle wird nur bei anderem Modus, anderen Spalten oder anderer Kopfhöhe neu gebaut;
  Menü-Aktionen laufen über `applyState`, Ziehen in der Kopfzeile liest die Tabelle danach aus. Layout je Profil in
  `columnLayouts`. Die letzte sichtbare Spalte füllt den Rest. Fortsetzungs- und nicht zerlegte Zeilen spannen per
  `getColspanAt` ab der ersten **sichtbaren** Datenspalte (`spanFrom`), ihr Text rückt um deren x nach links: Die Tabelle
  zeichnet einen Colspan nur aus einer Zelle, die sie zeichnet, und `getMaxColspan` > 0 hieße alle Zeilen scannen.
  Kein Sortieren. Details: `prompts/done/009-tabellen-header.design.md`.
  Editlicious ist als Editor mit Rope nicht passend: Der Text liegt hier bewusst nicht im Speicher.
- **Virtuelle Offsets und Segmente:** Jede Datei einer Sitzung (vor/nach Rotation) belegt einen eigenen Offset-Bereich, der
  Handle bleibt offen. So bleiben Zeilennummern bei „alte Zeilen behalten“ gültig, höchstens 32 Dateien, dann Neubeginn.
- **Provisorische letzte Zeile:** Eine Zeile ohne `\n` bleibt laut Vorgabe im Puffer, damit eine Datei ohne abschließenden
  Zeilenumbruch aber nicht ihre letzte Zeile verschweigt, wird sie nach 1 s Pause (oder am Ende des Ladens) angezeigt und
  beim Weiterschreiben ersetzt.
- **Gezeichnet wird nur, was da ist:** `SessionState.displayedLines` trennt den Zeilenstand der Ansicht vom Stand des Backends
  (`filteredLines`). Der Live-Tail rückt erst vor, wenn das neue Ende im `PageCache` liegt (`displayed-lines.ts`), sonst blitzt
  je Update die Fläche ohne Level-Farbe auf. Maßgeblich ist, was angekommen ist, damit überholte Ladevorgänge nicht aushungern.
  Filterwechsel und Sprünge an ungeladene Stellen zeigen weiter kurz Platzhalter.
- **Freeze im Backend:** Der Worker liest im Freeze nicht weiter (`SessionData.frozen`), sendet aber weiter Updates, denn
  Filter-Jobs melden sich über `tick()`. Der Index bleibt stehen, daher sind Filter, Suche und Kopieren ohne Zusatzcode
  konsistent. Anzeigen allein anzuhalten hieße, jede Abfrage auf einen Zeilenstand zu begrenzen. Eine Rotation im Freeze
  verliert nichts (Handle bleibt offen), bei mehreren fehlen die Zwischenstände. Der Text liegt nicht im Speicher: Wird die
  Datei geleert, kann die eingefrorene Anzeige lückenhaft oder falsch sein. Das meldet die Statusleiste, zurückgesetzt
  wird erst beim Fortsetzen.
- **Detail-Panel (Prompt 004):** zeigt `selection().anchor` (kein eigenes Auswahl-Signal), Text per `get_entry` direkt
  aus dem Index (ohne Filter, bis 1 MiB, Schnitt an Zeichengrenze), Kopieren per `copy_lines` mit `view: all`.
  Formatieren mit eigenem Tokenizer (`detail-format.ts`), **kein `JSON.parse`** (rundet 64-Bit-IDs) und **kein
  `DOMParser`** (scheitert an Fragmenten); er ändert nur Einrückung und Farbe, über 256 KB bleibt der Text roh. Neu
  geladen wird nur bei anderer Zeile/Tab/`epoch`/`viewGeneration` oder wenn der Eintrag am Dateiende liegt, höchstens
  ein Aufruf zugleich. Sichtbarkeit, Höhe und Umbruch global in den Settings, gespeichert am Ende des Ziehens.
  `onKey` der Tabelle nimmt `.detail` und `[role=separator]` aus (außer `D`).
- **Seitenleiste (Prompt 005):** Der Baum ist eine zweite Sicht auf `SessionState`, keine eigene Quelle; Knoten rechnet
  `tree-model.ts`. Die Spalte „Ansicht“ kommt als `view_counts` aus `FilteredLines` (Zähler je Level, für Einträge mit
  Treffer im Stacktrace ein Zwischenzähler seit `entry_start`, beides im `FilterCheckpoint`). `applyPreset` setzt
  Level, Suche und Modus und startet **einen** Filter-Job; `presetRevision` verwirft eine noch laufende Eingabe in der
  Suche. Unter 900 px blendet sich die Leiste aus, ohne die Einstellung zu ändern (`sidebar-logic.ts`).
- **Merge (Prompt 006):** eine `LogSession` mit einem Index für alle Quellen. Adressraum je Quelle: `offset >> 56` ist die
  Quelle (`indexer.rs`), 16 Byte je Zeile bleiben, Einzeldateien sind Quelle 0. Segmente bleiben nach `base` sortiert
  (`insert_segment`), `LineReader` hat einen Puffer je Quelle. Sortiert werden Einträge nach (Zeit, Quelle, Position).
  Laden streamt: gelesen wird die Quelle, die zeitlich hinten liegt, freigegeben, was keine unfertige Quelle mehr
  unterbieten kann; eine ungeordnete Quelle löst einen Neustart aus und wird dann ganz gelesen und sortiert. Live wird
  **nur angehängt**: Haltepuffer `HOLD_BACK = 1 s` bis zum Wasserstand der aktiven Quellen, Verspätetes ans Ende und
  gezählt (`lateLines`), „Neu sortieren“ = neue Epoche. Keine provisorische Zeile (eine Zeile ohne `\n` wird nach 1 s
  endgültig, ihr Rest eine eigene Zeile). Profil je Datei im Dialog, `set_profile` auf einem Merge ist `invalid_merge`.
  Spalten kommen aus dem Format der ersten Datei. Der Tailer für Einzeldateien ist unverändert.
- **Overview Ruler (007):** rechts neben der Tabelle (deren Scrollleiste bleibt), ein `<canvas>`, Daten aus
  `get_overview` (Level-Bits je Pixel aus `LevelSummary`, nie ein Index-Scan; die Identität nutzt die des `LineIndex`, ein
  Filter seine eigene in `FilteredLines`). Gezeichnet wird **Dichte, nicht „schwerstes Level gewinnt“**: je Pixel und
  FATAL/ERROR/WARN der Anteil der Zeilen in Abschnitten mit dem Level (0–255, `density`), als Balkenlänge in zwei Spuren
  (FATAL+ERROR links, kürzerer Balken oben; WARN rechts), Mindestlänge für eine einzelne Zeile. Ab 64 K Zeilen sind
  Abschnitte mehrere Zeilen lang, die Dichte wird dann überschätzt (bei 5 Mio. Zeilen und häufigen Fehlern wieder voll). Positionen der **Ansicht**, höchstens 2 Abfragen/s, Antwort mit fremder
  `epoch`/`viewGeneration` wird nicht gezeichnet. Ein ODER lässt sich nicht zurückrechnen: Rückzug der provisorischen Zeile
  kann ein Bit stehen lassen, Neu-Leveln baut eine neue Zusammenfassung und tauscht sie. `find_level` prüft nur Köpfe
  (`E`/`W`), Lesezeichen (`M`/`N`) nur im Speicher des Frontends, neue `epoch` leert sie. Navigation ändert nie die Auswahl.
  `G` hebt den Filter auf (Filtersuche wird Hervorhebung), merkt ihn und scrollt erst mit der neuen `viewGeneration`
  (`pendingReveal`).
- **Verkettete Filter (Prompt 010):** Der Baum der Seitenleiste wird zu **einem** Ausdruck kompiliert
  (`filter_expr.rs`), der eine gefilterte Liste ergibt, kein Listen-Stapel je Knoten. Bedingungen gelten für den Eintrag:
  ein Blatt ist gesetzt, sobald eine Zeile des Eintrags es erfüllt (Bitmaske, höchstens 64 Blätter), der Baum wird auf der
  Maske ausgewertet. Level-Chips und Suche bleiben ein UND darüber. Mit NICHT kann ein schon gezeigter Eintrag durch eine
  späte Fortsetzungszeile wieder herausfallen: Er liegt am Ende der Liste und wird abgeschnitten, `filteredLines` sinkt,
  `retractedFrom` im Update lässt das Frontend ab dort neu laden. Abschnitte (Start-/Endmuster) sind Zustand über die
  Zeilenfolge und werden immer fortgeschrieben, auch wo ein ODER schon entschieden ist. Text-Blätter laufen gemeinsam
  (eine Alternation als Vorfilter, `RegexSet` nur bei einem Treffer). Feld- und Zeit-Blätter lesen nur den Kopf. Ohne
  Baum bleibt der alte Weg unverändert (`append` verzweigt nur bei `spec.expr`).
- **Fortsetzungszeilen:** Einrücken, `at `, `Caused by:`, `Traceback`, `... ` wird vor der Regex geprüft
  (`at com.acme.error.Handler` ist keine ERROR-Zeile). Zeilen mit Zeitstempel ohne Level beginnen einen neuen Eintrag.
- **Felder beim Ausliefern, nicht beim Indexieren (Prompt 008):** `get_lines` zerlegt jede Zeile mit dem `FieldParser`
  der Sitzung in Spannen `[start, end)` in UTF-16 (`LogLine.fields`, eine je Spalte aus `get_columns`). Der Index bleibt bei
  16 Byte, Filter, Suche und Tail laufen ohne Layout. Format aus einer Stichprobe von 200 Zeilen beim ersten Block
  (`detect_format`): bestes eingebautes Layout ab 80 % der Eintragsköpfe (Fortsetzungszeilen zählen nicht), sonst
  `infer_layout`, ab 50 % angezeigt, sonst nur `message`. Ein gefundenes Layout bestimmt auch den Profilvorschlag. Spalten
  bleiben je Sitzung fest (Rotation behält sie, fremde Zeilen landen in `message`); ein Profilwechsel tauscht sie erst mit
  der neuen `viewGeneration` (`columnsRevision` steigt mit). Fortsetzungszeilen sind ganz `message`. Nur die ersten 16 KB
  werden zerlegt, der Rest gehört zum letzten Feld. SOH (`\x01`, FIX) zeigt `display_text` als `|`.
- **Zeitstrahl (014):** `TimeSummary` im `LineIndex` neben der `LevelSummary`: je Abschnitt (256 Zeilen, verdichtet
  bis 64 K Abschnitte) erste/letzte Zeit, größter Sprung, Einträge je Level, höchstens 4 MB; der Index bleibt bei
  16 Byte. Geparst werden beim Einlesen nur wenige Köpfe je Abschnitt (`TimeCursor`: erster mit Zeit, jeder 32., der
  letzte; endet ein Abschnitt in einem Stacktrace, wird der Kopf vor der Sperre nachgelesen), ohne Zeiten im Sample
  gar keiner. Ein Merge gibt seine Zeiten mit. Zeigt immer die ganze Datei, auch im Filter-Tab; „Als Filter“ legt eine
  Zeit-Bedingung im Baum des Tabs an. Abfragen nur unter der Lesesperre, `position_at_time` liest die Köpfe eines
  Abschnitts (`blocking`).
- **Datei-Identität unter Windows** über `GetFileInformationByHandle`, nicht Erstellzeit (File Tunneling).
- **CSP:** `dangerousDisableAssetCspModification: ["style-src"]` ist nötig. Sonst ergänzt Tauri Nonces, `'unsafe-inline'`
  gilt nicht mehr und Angulars Komponenten-Styles fehlen.
- **`backgroundThrottling: disabled`:** Ein Live-Viewer muss auch hinter anderen Fenstern aktuell bleiben.
- **Extrahierte Felder (Prompt 011):** Regeln (Regex mit genau einer Gruppe über die Spanne einer Quellspalte, erster
  Treffer) je Profil im `RuleBook`, das alle Sitzungen teilen (`OpenOptions.rules`); `FieldParser::with_rules` hängt ihre
  Spalten hinter die des Formats, `SessionData::set_format` wendet sie immer an, `refresh_rules` gibt neue Revision und
  `viewGeneration`. Ausgewertet bei `get_lines` und in Feld-Bedingungen (`FieldParser::field`), nichts im Index;
  Fortsetzungszeilen ohne Extraktion, ab 5 Regeln einer Quelle `RegexSet` als Vorfilter. Zahlen nur über `parse_value`
  (Basiseinheit s bzw. Byte, KB = 1024, `1,234` ist kein Wert). Name = Spalten-Id, darf keine Spalte des Formats sein
  (`invalid_rule` mit `nodeId` = Regel-Id, keine Umbenennung). Vorschläge (`suggest_fields`) beim ersten Laden, nur ohne
  Regeln und einmal je Profil (`fieldHints`), als Hinweis in der Statusleiste. Auswertung (012) soll auf
  `FieldParser::field` + `parse_value` im Hintergrund-Job aufsetzen.
- **Filter-Tabs (Prompt 013):** mehrere Ansichten (`ViewState`) in **einer** `LogSession`, Ansicht 0 gibt es immer (wie
  früher). Je Ansicht eigener Filter, Liste, `viewGeneration`, Job (eigener Zähler), Checkpoint der provisorischen Zeile und
  eigener Channel (`open_view`/`close_view`, alle Abfragen mit optionalem `viewId`, Vorgabe 0). Kind = Kette der Eltern UND
  eigener Filter, in `views.rs` zu einem Filter zusammengesetzt (Level und Quellen geschnitten, Bäume und filternde Suchen
  der Eltern als ein UND vor dem eigenen Baum); `set_filter` kompiliert zuerst alles darunter und startet dann die Jobs
  aller Nachfahren. Schließen gibt den Filter an die Kinder weiter (`inherited`), kein Job; Ansicht 0 wird dabei zur
  versteckten Identität ohne Channel. `ingest` liest den Text einer Zeile höchstens einmal für alle Ansichten (`Fresh`,
  `TextTest::probe_many`). Updates: nur geänderte Ansichten, eine nur gewachsene Datei höchstens 1×/s je weiterer Ansicht.
  Neu-Leveln läuft einmal und startet dann alle Ansichten. Freeze, Profil, Spalten, Dashboard und Lesezeichen gelten je
  Datei. Frontend: `SessionState.id` ist der Tab, `sessionId`/`viewId` gehen ans Backend. Details:
  `prompts/done/013-filter-tabs-drilldown.design.md`.
- **Grenzen Filter-Tabs:** höchstens 8 Tabs (Ansichten) je Datei (`too_many_views`), je Ansicht bis 4 Byte je Zeile
  (500 MB: 7 Ansichten zusammen 32 MB); die Kette zusammen höchstens 64 Bedingungen und 16 Ebenen (+1 für die Kette).
  Weitere Ansichten eines Merges lesen den Text beim Schreiben unter der Sperre.
- **Grenzen Merge:** höchstens 16 Quellen, verspätete Zeilen stehen am Ende, bis „Neu sortieren“; keine Zeilennummer der
  Quelldatei (nur Byte-Offset); ohne Zeitzone gilt die lokale Zone; ohne Zeitstempel in den ersten 200 Zeilen
  `no_timestamps`. Truncation einer Quelle, Rotation ohne Behalten oder mehr als 32 Segmente einer Quelle mischen alles neu.
- **Grenzen Filterbaum:** höchstens 64 Bedingungen (Blätter), 16 Ebenen, 4096 Zeichen je Text/Muster/Wert, Regex-
  Größenlimit 32 MB; Fehler kommen als `invalid_search` mit `nodeId`. Feldbedingungen gelten mit dem Format beim Setzen
  (bei neuen Spalten setzt das Frontend den Filter neu), Zeilen-Bedingungen meinen Zeilennummern der aktuellen `epoch`.
- **Grenzen Felder:** höchstens 32 Regeln je Profil, 40 Zeichen je Name, 4096 je Muster, ausgewertet in den ersten 16 KB
  der Quellspalte; Vorschläge aus höchstens 2000 Köpfen, höchstens 10, ab 5 % Anteil.
- **Grenzen Dashboard:** 10 000 Zeilen/32 MB je Ergebnis, 10 s je Abfrage, 64 KB SQL, 64 KB je Wert, 50 Spalten, Text-Felder auf
  1 KB gekürzt, 24 Panels, 24 Reihen je Diagramm, über 5000 Punkte wird ein größeres `bucket` vorgeschlagen. Nur die
  ganze Datei, nicht die gefilterte Ansicht.
- **Grenzen:** höchstens 2³² Zeilen je Sitzung (Index dann 64 GB), Anzeige 128 KB je Zeile, Suche 1 MB je Zeile, Zeile ohne
  Ende wird bei 16 MB geteilt, Detail-Panel 1 MiB je Eintrag (Formatieren bis 256 KB). Felder: höchstens 12 Spalten aus JSON-/logfmt-Schlüsseln bzw. FIX-Tags, zerlegt werden 16 KB. Zeitstrahl: Zahlen je Eimer
  angenähert (gleichverteilt im Abschnitt), Ausfälle innerhalb eines Abschnitts nur auf eine Probe genau.
  Truncation wird über die kleinere Größe erkannt; wird eine Datei geleert und zwischen zwei
  Prüfungen über die alte Größe hinaus neu beschrieben, bleibt das unbemerkt.

- **Dashboard (012):** SQLite (`rusqlite` bundled, +1,8 MiB; DuckDB wäre +43 MiB) in
  `<app-cache>/reports/<pid>/session-<id>.sqlite`, Ordner per gesperrter `lock`-Datei je Prozess (Reste nach Absturz
  löscht der Start). Erst beim ersten Öffnen eines Dashboards, vorher weder Datei noch Thread. Tabelle
  `log(line 1-basiert, ts ms UTC, level, source, Zahlen/angehakte Felder)`, nur Köpfe, nie die Nachricht. Builder auf
  eigenem Thread mit eigener Verbindung, Sperre nur zum Kopieren eines Stapels; Nachziehen alle 5 s nur bei offenem
  Dashboard; neue `epoch`/`columnsRevision`/Felder bauen neu. Abfragen: eigene Read-only-Verbindung je Abfrage,
  `query_only`, `temp_store = MEMORY`, Authorizer (nur Lesen), `readonly()`, eine Anweisung, Limits (64 KB je Wert, 256 Zeichen
  `LIKE`-Muster, 50 Spalten), 10 s über Progress-Handler, 10 000 Zeilen, höchstens 6 Abfragen zugleich, Schließen
  unterbricht laufende (`sqlite3_interrupt`), Heap-Limit 768 MiB prozessweit,
  Extension-Loading per `.cargo/config.toml` nicht gebaut. Neuer Fehlercode `invalid_query`. Rust ≥ 1.89
  (`File::try_lock`). Details: `prompts/done/012-dashboard-sql-timeline.design.md`.

- **Export und Arbeitsstand (Prompt 015):** Das Backend schreibt Exporte selbst (nie durch IPC), in Schritten unter kurzer
  Lesesperre, Ende fest beim Start, Temp-Datei + Umbenennen, Ziel ≠ offene Datei (Pfad und Datei-Identität), Endung passend
  zum Format. CSV mit `'` vor Formel-Zellen. Ein `.lcw` ist fremde Eingabe: `parseWorkspace` prüft alles, Backend liest
  und schreibt nur `.lcw`. Lesezeichen/Notizen gehören zur Datei, Anker = Zeile + Offset + Länge + Hash der ersten 256 Byte.
  Details und Grenzen: `prompts/done/015-export-und-arbeitsstand.design.md`.

## Arbeitsweise

Nicht ausführbare Prüfungen im Bericht nennen. Native Dialoge, Menü, Datei-Drop aus dem Finder und die Zwischenablage
deckt `npm run e2e` nicht ab (nur von Hand prüfbar). Backlog: `docs/roadmap.md`.
