# Architektur

Stand: Freeze-Button (Prompt 002) auf Basis des Startauftrags und des Flacker-Fixes (001). Dieses Dokument beschreibt
Entscheidungen, nicht Wünsche. Geplantes steht in `docs/roadmap.md` und in `prompts/`.

## Überblick

```
┌──────────────── WebView (Angular 22, zoneless, Signals) ──────────────┐
│  App ── Tabs, Toolbar, LogView, StatusBar, Dialoge                    │
│   │      LogView: eigener Viewport (Zeile + Pixel-Offset)             │
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
│  filter.rs     gefilterte Liste (inkrementell), Textsuche             │
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
   liest den Text dafür aus der Datei (`LineReader` mit gleitendem Puffer), dekodiert, entfernt ANSI und kürzt auf 128 KB.
5. **Ändern:** `set_filter` und `set_profile` starten Hintergrund-Jobs. Eine neue `viewGeneration` macht gecachte Seiten
   ungültig, eine neue `epoch` die Zeilennummern.

## Entscheidungen

| Thema | Entscheidung | Begründung |
|---|---|---|
| Text im Speicher | Nein. Nur ein Index mit 16 Byte je Zeile, der Text wird bei Bedarf aus der Datei gelesen | Dateien mit vielen GB bleiben offen- und scrollbar. Grenze 2³² Zeilen je Sitzung (Index dann 64 GB). |
| Viewport | Eigene Implementierung, Position = Zeile + Pixel-Offset, die native Scrollleiste bildet nur einen Bruchteil ab (`viewport-logic.ts`, höchstens 8 Mio. px) | CDK und Tabellen machen ein Element so hoch wie alle Zeilen (Browser-Limit etwa 33 Mio. px). Erlaubt variable Höhen beim Umbruch. Abwägung zur GuiExpert Table: `prompts/003-gui-expert-table.md`. |
| Gezeichnet wird, was da ist | `displayedLines` trennt den Stand der Ansicht vom Stand des Backends. Der Tail rückt erst vor, wenn das neue Ende im `PageCache` liegt | Sonst blitzt je Update die Fläche ohne Level-Farbe auf. Prompt 001. |
| Virtuelle Offsets | Jede Datei einer Sitzung (vor und nach Rotation) belegt einen eigenen Offset-Bereich (`Segment`), der Handle bleibt offen, höchstens 32 Dateien | Zeilennummern bleiben bei „alte Zeilen behalten“ gültig, und das Lesen braucht keinen Pfad. |
| Gefilterte Ansicht | `FilteredLines`: bei Identität keine Liste, sonst `Vec<u32>` der Zeilennummern. Im Tail inkrementell, bei Filterwechsel neu per Job | Positionen in der Ansicht sind Indizes in die Liste, Suche und Kopieren arbeiten darauf. |
| Einträge | Fortsetzungszeilen (Einrückung, `at `, `Caused by:`, `Traceback`, `... `) werden vor der Regex geprüft und erben das Level. Ein Treffer in einer Fortsetzung bringt den ganzen Eintrag | `at com.acme.error.Handler` ist keine ERROR-Zeile, ein Stacktrace gehört zu seinem Kopf. |
| Provisorische letzte Zeile | Eine Zeile ohne `\n` wird nach 1 s Pause (oder am Ende des Ladens) angezeigt und beim Weiterschreiben ersetzt (Checkpoint im Filter) | Eine Datei ohne abschließenden Zeilenumbruch verschweigt ihre letzte Zeile nicht. |
| Freeze | Der Worker liest im Freeze nicht weiter, sendet aber Updates (Filter-Jobs melden sich über `tick()`) | Der Index steht, also sind Filter, Suche und Kopieren ohne Zusatzcode konsistent. Wird die Datei im Freeze geleert, warnt die Statusleiste, zurückgesetzt wird erst beim Fortsetzen. Prompt 002. |
| Rotation und Truncation | Datei-Identität je OS (`platform.rs`; Windows `GetFileInformationByHandle`, nicht die Erstellzeit, wegen File Tunneling), Truncation über die kleinere Größe | Erkennt `logrotate` (umbenennen) und `copytruncate`. Grenze: Leeren und Neuschreiben über die alte Größe hinaus zwischen zwei Prüfungen bleibt unbemerkt. |
| Beobachten | `notify` plus Polling (250 ms, bei aktivem Schreiber 100 ms) | `notify` ist auf Netzlaufwerken und in Docker-Volumes unzuverlässig. |
| Jobs | Filter und Neu-Leveln laufen in eigenen Threads, abbrechbar über eine Generation. Die letzten Zeilen werden unter der Sperre nachgezogen | Kein Halt im Tail, keine Zeile fällt zwischen Liste und Ende. |
| Fehler | `AppError { code, message }` mit `snake_case`-Codes (`not_found`, `permission_denied`, `invalid_search`, `too_large`, …), gespiegelt in `app/core/errors/` | Stabile Codes für deutsche UI-Texte, die Originalmeldung bleibt als Detail. |
| Backend-Zugriff | `LogApi` im Frontend, `invoke()` nur in `call.ts` | Ein Ort für die Fehlerabbildung und den Fall „kein Backend“ (Browser, Screenshots). |
| Frontend-Zustand | `SessionState` je Tab (Signals, `linkedSignal`), `LogSessionService` als Root-Service für Tabs und Aktionen | Ein Viewport rendert den aktiven Tab, kein DOM je Tab. |
| Einstellungen | `tauri-plugin-store` (`settings.json`), nachsichtiges Zusammenführen in `mergeSettings` | Kaputte oder alte Werte fallen auf Vorgaben zurück, statt den Start zu verhindern. |
| Farben | Tokens nur in `src/styles.css`, dark und light, WCAG AA geprüft (`npm run contrast`) | Details in `docs/themes.md`. |
| Hintergrund | `backgroundThrottling: disabled` | Ein Live-Viewer muss auch hinter anderen Fenstern aktuell bleiben. |
| CSP | strikte CSP mit `dangerousDisableAssetCspModification: ["style-src"]` | Sonst ergänzt Tauri Nonces, `'unsafe-inline'` gilt nicht mehr und Angulars Komponenten-Styles fehlen. `script-src 'self'` bleibt strikt. |
| Capabilities | Nur für `main`: Events, Pfad-Auflösung, Fenstertitel, Öffnen-Dialog, Store, CLI. Kein `tauri-plugin-fs`, keine Shell | Alle Dateizugriffe laufen über eigene Commands, das Frontend kann keine beliebigen Pfade lesen. |
| Öffnen | Dialog, Menü (`Cmd/Ctrl+O`, für einen Pfad `Cmd/Ctrl+Shift+O`), Datei-Drop, Kommandozeile (`tauri-plugin-cli`), zuletzt geöffnete Dateien | Ein Weg im Service (`tryOpen`), eine schon offene Datei aktiviert ihren Tab. |
| Ende-zu-Ende | Debug-Build mit `e2e.rs`: Das Szenario aus `LC_E2E_SCRIPT` läuft im echten WebView gegen das echte Backend und meldet über stdout. Der Harness ändert die Datei auf Zuruf | Prüft Tail, Rotation und Truncation so, wie Nutzer sie erleben. Release-Builds enthalten das Modul nicht. |
| Screenshots | Gebautes Frontend in Playwright-WebKit mit IPC-Mock (`scripts/e2e/mock-ipc.js`), Daten aus `samples/` | Gleiche Bilder auf jedem OS, ohne Rust-Build und ohne Fensterrechte. |

## Grenzen

- Höchstens 2³² Zeilen und 32 Dateien (Segmente) je Sitzung, danach beginnt sie neu.
- Anzeige 128 KB je Zeile, Suche 1 MB je Zeile. Eine Zeile ohne Ende wird bei 16 MB geteilt.
- `get_lines` liefert höchstens 5000 Zeilen je Aufruf. Kopieren höchstens 1 Mio. Zeilen bzw. 256 MB.
- Mehrere Rotationen während eines Freeze: Zwischenstände fehlen.

## Abhängigkeiten

| Paket | Zweck | Begründung |
|---|---|---|
| `tauri` 2 mit `tauri-plugin-cli`, `-dialog`, `-store`, `-window-state` | Fenster, IPC, Öffnen-Dialog, Einstellungen, Fenstergröße, Kommandozeile | Offizielle Plugins, schmale Capabilities. |
| `notify` 8 | Dateiänderungen | Standard im Rust-Ökosystem, Polling als Rückfall. |
| `regex` 1 | Profile, Level-Erkennung, Suche | Lineare Laufzeit, kein ReDoS durch Nutzermuster. |
| `memchr` 2 | schneller Zeilensplit | War über `regex` schon im Baum. |
| `encoding_rs` 0.8 | Dekodieren (UTF-8, UTF-16 LE/BE, Latin-1) | Bewährt, stammt aus Firefox. |
| `parking_lot` 0.12 | `RwLock` der Sitzungsdaten | Kurze Sperren ohne Poisoning. |
| `serde`, `serde_json`, `thiserror` | DTOs, JSON-Level, Fehler | Standard. |
| `windows-sys` 0.61 (nur Windows) | Datei-Identität | `GetFileInformationByHandle` statt Erstellzeit. |
| Angular 22, `@tauri-apps/api` samt Plugin-Paketen, `rxjs` | Oberfläche | Vorgabe. Kein UI-Framework, kein CDK. |
| Dev: Vitest + jsdom, angular-eslint, Prettier, `playwright` (nur Screenshots), `tempfile` | Tests und Werkzeuge | Kein Laufzeitcode. |

Neue Abhängigkeiten kommen mit Begründung in diese Tabelle (Prompt 000, Phase 5).
