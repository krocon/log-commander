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
| E2E im echten WebView | `npm run e2e` (Debug-Build, echtes Backend, echte Datei; `-- --no-build` zum Wiederholen) |
| Messung 500 MB | `cd src-tauri && cargo test --release --test tail_integration -- --ignored --nocapture measure_` |
| Messung Merge 2 × 500 MB | `cd src-tauri && cargo test --release --test merge_integration -- --ignored --nocapture measure_merge` |
| Kontrast WCAG AA | `npm run contrast` (prüft `src/styles.css`) |
| Screenshots für die Doku | `npm run build`, dann `node scripts/screenshots.mjs` (WebKit + IPC-Mock) |
| Log-Generator | `node scripts/gen-log.mjs /tmp/app.log --rate 5000 [--format …] [--rotate-every N] [--truncate-every N]` |
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
                             format-logic (Spalten, Formattext), navigation-logic (Lesezeichen, Sprung, Gesamtlog)
  app/features/log-table/    LogTableViewComponent (GuiExpert Table), LogAreaModel, viewport-logic (reines
                             Scroll-Modell), table-logic, highlight (Inline-Tokens, cellSegments), columns-logic
                             (Spaltenansicht: Layout, Breiten, Spannen), column-menu (Spaltenmenü),
                             overview-ruler + ruler-logic (Overview Ruler, Canvas)
  app/features/merge/        MergeDialog (Prompt 006), merge-logic (Quellenmaske, Namen, Farben, Dialogregeln)
  app/features/detail/       DetailPanel (Prompt 004), detail-format (JSON/XML-Tokenizer), detail-logic (Layout, Neuladen)
  app/shared/splitter.ts     wiederverwendbarer Splitter (Pointer Events, Tastatur), Rechnung in splitter-logic.ts
  app/features/sidebar/      Seitenleiste: Baum (tree-model, log-tree), Statistik (stats-panel), Layout (sidebar-logic/-state)
  app/shared/                splitter (wiederverwendbar), session-marks (Tabs und Baum), format
  app/features/toolbar|statusbar|tabs|start|settings/   UI
src-tauri/src/               Rust; alles außer commands.rs und lib.rs ist frei von Tauri
  session.rs                 LogSession, Abfragen, Hintergrund-Jobs (Filter, Level neu), SessionManager
  tail.rs                    Worker je Datei: Blöcke lesen, notify + Polling, Teilzeile, Truncation, Rotation, Updates
  indexer.rs                 LineIndex (16 Byte je Zeile), LineSplitter, LineReader, Segmente
  level.rs, profile.rs       Level-Erkennung, eingebaute und eigene Profile (samt Layouts), Vorschlag
  fields.rs                  Formaterkennung, Felder je Zeile (Spannen in UTF-16), JSON/logfmt/FIX/W3C-Scanner, Inferenz
  timestamp.rs               Zeitstempel erkennen und nach µs UTC wandeln (auch für den Merge, Prompt 006)
  filter.rs                  gefilterte Zeilenliste (inkrementell), Textsuche, Quellenmaske
  overview.rs                LevelSummary: Level-Bits je Abschnitt für Overview Ruler und find_level (max. 64 KB)
  merge.rs                   mehrere Dateien als eine Sitzung: Merger (rein), Worker (Folgen, Rotation, Haltepuffer)
  encoding.rs, platform.rs   Encodings, ANSI; Share-Flags und Datei-Identität je OS
  e2e.rs                     nur Debug-Build: Szenario im WebView, siehe scripts/e2e/
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
  Filter seine eigene in `FilteredLines`). Positionen der **Ansicht**, höchstens 2 Abfragen/s, Antwort mit fremder
  `epoch`/`viewGeneration` wird nicht gezeichnet. Ein ODER lässt sich nicht zurückrechnen: Rückzug der provisorischen Zeile
  kann ein Bit stehen lassen, Neu-Leveln baut eine neue Zusammenfassung und tauscht sie. `find_level` prüft nur Köpfe
  (`E`/`W`), Lesezeichen (`M`/`N`) nur im Speicher des Frontends, neue `epoch` leert sie. Navigation ändert nie die Auswahl.
  `G` hebt den Filter auf (Filtersuche wird Hervorhebung), merkt ihn und scrollt erst mit der neuen `viewGeneration`
  (`pendingReveal`).
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
- **Datei-Identität unter Windows** über `GetFileInformationByHandle`, nicht Erstellzeit (File Tunneling).
- **CSP:** `dangerousDisableAssetCspModification: ["style-src"]` ist nötig. Sonst ergänzt Tauri Nonces, `'unsafe-inline'`
  gilt nicht mehr und Angulars Komponenten-Styles fehlen.
- **`backgroundThrottling: disabled`:** Ein Live-Viewer muss auch hinter anderen Fenstern aktuell bleiben.
- **Grenzen Merge:** höchstens 16 Quellen, verspätete Zeilen stehen am Ende, bis „Neu sortieren“; keine Zeilennummer der
  Quelldatei (nur Byte-Offset); ohne Zeitzone gilt die lokale Zone; ohne Zeitstempel in den ersten 200 Zeilen
  `no_timestamps`. Truncation einer Quelle, Rotation ohne Behalten oder mehr als 32 Segmente einer Quelle mischen alles neu.
- **Grenzen:** höchstens 2³² Zeilen je Sitzung (Index dann 64 GB), Anzeige 128 KB je Zeile, Suche 1 MB je Zeile, Zeile ohne
  Ende wird bei 16 MB geteilt, Detail-Panel 1 MiB je Eintrag (Formatieren bis 256 KB). Felder: höchstens 12 Spalten aus JSON-/logfmt-Schlüsseln bzw. FIX-Tags, zerlegt werden 16 KB. Truncation wird über die kleinere Größe erkannt; wird eine Datei geleert und zwischen zwei
  Prüfungen über die alte Größe hinaus neu beschrieben, bleibt das unbemerkt.

## Arbeitsweise

Nicht ausführbare Prüfungen im Bericht nennen. Native Dialoge, Menü, Datei-Drop aus dem Finder und die Zwischenablage
deckt `npm run e2e` nicht ab (nur von Hand prüfbar). Backlog: `docs/roadmap.md`.
