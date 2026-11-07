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
  app/features/sessions/     LogSessionService (Tabs, alle Aktionen), SessionState (je Tab), PageCache, filter-logic
  app/features/log-view/     LogViewComponent, viewport-logic (reines Scroll-Modell), highlight (Inline-Tokens)
  app/features/toolbar|statusbar|tabs|start|settings/   UI
src-tauri/src/               Rust; alles außer commands.rs und lib.rs ist frei von Tauri
  session.rs                 LogSession, Abfragen, Hintergrund-Jobs (Filter, Level neu), SessionManager
  tail.rs                    Worker je Datei: Blöcke lesen, notify + Polling, Teilzeile, Truncation, Rotation, Updates
  indexer.rs                 LineIndex (16 Byte je Zeile), LineSplitter, LineReader, Segmente
  level.rs, profile.rs       Level-Erkennung, eingebaute und eigene Profile, Vorschlag
  filter.rs                  gefilterte Zeilenliste (inkrementell), Textsuche
  encoding.rs, platform.rs   Encodings, ANSI; Share-Flags und Datei-Identität je OS
  e2e.rs                     nur Debug-Build: Szenario im WebView, siehe scripts/e2e/
scripts/e2e/                 run.mjs (Harness), scenario.js (läuft im WebView), mock-ipc.js (nur für Screenshots)
samples/                     Beispiel-Logs
```

## Entscheidungen

- **Eigener Viewport statt CDK oder GuiExpert Table.** Beide machen ein Element so hoch wie alle Zeilen; am Browser-Limit
  (~33 Mio. px) ist bei rund 1,5 Mio. Zeilen Schluss, und die Daten müssten synchron vorliegen. Hier ist die Position
  Zeile + Pixel-Offset, die native Scrollleiste bildet nur einen Bruchteil ab (`viewport-logic.ts`). Das erlaubt auch
  variable Höhen beim Zeilenumbruch. Die GuiExpert Table bleibt eine Option für künftige Tabellen (Spaltenansicht).
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
- **Fortsetzungszeilen:** Einrücken, `at `, `Caused by:`, `Traceback`, `... ` wird vor der Regex geprüft
  (`at com.acme.error.Handler` ist keine ERROR-Zeile). Zeilen mit Zeitstempel ohne Level beginnen einen neuen Eintrag.
- **Datei-Identität unter Windows** über `GetFileInformationByHandle`, nicht Erstellzeit (File Tunneling).
- **CSP:** `dangerousDisableAssetCspModification: ["style-src"]` ist nötig. Sonst ergänzt Tauri Nonces, `'unsafe-inline'`
  gilt nicht mehr und Angulars Komponenten-Styles fehlen.
- **`backgroundThrottling: disabled`:** Ein Live-Viewer muss auch hinter anderen Fenstern aktuell bleiben.
- **Grenzen:** höchstens 2³² Zeilen je Sitzung (Index dann 64 GB), Anzeige 128 KB je Zeile, Suche 1 MB je Zeile, Zeile ohne
  Ende wird bei 16 MB geteilt. Truncation wird über die kleinere Größe erkannt; wird eine Datei geleert und zwischen zwei
  Prüfungen über die alte Größe hinaus neu beschrieben, bleibt das unbemerkt.

## Arbeitsweise

Nicht ausführbare Prüfungen im Bericht nennen. Native Dialoge, Menü, Datei-Drop aus dem Finder und die Zwischenablage
deckt `npm run e2e` nicht ab (nur von Hand prüfbar). Backlog: `docs/roadmap.md`.
