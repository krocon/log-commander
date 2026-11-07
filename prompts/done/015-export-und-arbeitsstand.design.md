# 015 Export, Arbeitsstand und Teilen – Design und Stand

Status: umgesetzt (Phase 1–6), `npm run check` und `npm run e2e` (351 Schritte) grün, autonom entschieden (Freigabe durch den Koordinator: offene Fragen selbst entscheiden und
hier festhalten). Datum: 2026-11-07. Branch `feat/export-arbeitsstand`.

## Abweichungen vom Prompt-Text (Stand des Codes)

- Der alte Viewport mit `.mark` gibt es nicht mehr. „Symbol in `.mark`“ = Klasse `note` an der Gutter-Zelle der
  GuiExpert Table (`log-area-model.ts`, `log-table-marks.css`, Zeichen `✎` neben dem Lesezeichen `⚑`).
- `copy_lines` hat die 256-MB-Grenze weiter in `session.rs` (`MAX_COPY_BYTES`), `writeClipboard` steht am Ende von
  `log-session.service.ts` (nicht Zeile 220).
- Quellen aus 016–019 gibt es noch nicht; der Arbeitsstand kennt Dateien und Merges. Das Format ist versioniert und kann
  sie später aufnehmen.
- `line_anchor`/`resolve_anchor` sind als Batch-Commands `line_anchors(lines)`/`resolve_anchors(anchors)` umgesetzt
  (ein Aufruf je Datei statt je Lesezeichen). Der Anker hat zusätzlich `source` (Merge) und `len` (Zeilenlänge).
- Menüeinträge heißen wie die vorhandenen auf Englisch („Export…“, „Open Workspace…“, „Save Workspace…“), die Oberfläche
  sonst deutsch.

## Entscheidungen

| Frage | Optionen | Entscheidung | Grund |
|---|---|---|---|
| Fortschritt des Exports | `SessionUpdate` erweitern / eigener Channel | Eigener `Channel<ExportProgress>` je Job, `cancel_export(jobId)` | Ein Export gehört nicht zum Zustand der Ansicht; mehrere Jobs parallel; keine Felder in jedem Update. |
| Ende beim Tail | Liste kopieren / Endzeile merken | Endzeile beim Start (`ExportCursor.end_line`), Schritte zu 16 K Zeilen unter kurzer Lesesperre | Kein Kopieren der Filterliste (bis 4 B/Zeile), der Tail wartet nie. Ein neuer Filter unterwegs: weiter ab der nächsten Zeilennummer in der neuen Liste. Neue Epoche (Truncation): Abbruch mit `file_changed`, keine Datei. |
| Zieldatei | direkt / temporär + Umbenennen | `.<name>.<pid>-<job>.part` daneben, `create_new`, am Ende `sync_all` + `rename`; Abbruch/Fehler löscht | Nichts Halbes bleibt liegen, kein Folgen untergeschobener Links. |
| Zielprüfung | nur Pfad / Pfad + Identität | absolut, ohne `.`/`..`, Endung des Formats (`txt`/`log`, `csv`, `jsonl`/`ndjson`/`json`), Ordner existiert, kein Ordner; nicht die offene Datei: kanonischer Pfad (auch gelöschte Datei, auf die der Tail wartet) **und** Datei-Identität aller Segmente (Hardlink, Symlink, rotierte Datei) | Der Command darf nicht zum Schreiben beliebiger Dateien taugen; Ziel = Quelle würde das Log zerstören. |
| CSV | RFC 4180 | Alle Felder in Anführungszeichen, `""`, `\r\n`, UTF-8 **mit BOM** (Excel liest Umlaute), Kopf mit Spalten-**IDs** (`line`, `file` beim Merge, `level`, Spalten bzw. `text`) | IDs wie in JSON Lines und im Dashboard-SQL, stabil gegenüber Übersetzungen. |
| CSV-Injection | nichts / `'` voran / Tab voran | `'` vor Zellen, die mit `= + - @`, Tab oder CR beginnen, außer reinen Zahlen (`-12.5`) | OWASP-Empfehlung; Zahlen bleiben rechenbar. JSON Lines bleibt unverändert. |
| JSON Lines | | `{"line", ("file"), "level", <Spalten-IDs> | "text"}`; Spalte namens `line`/`level`/`file`/`text` → `<id>_field` | Keine doppelten Schlüssel (JSON-Logs haben oft `level`). |
| Spalten | | Spannen aus `FieldParser` (UTF-16 → Byte), Fortsetzungszeilen ganz in `message` | wie die Ansicht (008/009). |
| Anker | | `{line, source, offset, len, hash}`, Hash FNV-1a 64 über die ersten 256 Rohbytes als 16 Hex-Zeichen | Hex statt Zahl: JS verliert Bits über 2⁵³. |
| Anker suchen | je Anker ±10 000 Zeilen lesen / gemeinsam | Erst gleiche Zeilennummer; sonst Fenster ±10 000 um Nummer und alte Byte-Position (Binärsuche im Index, nur Einzeldatei) zusammengelegt, gelesen werden nur Zeilen mit passender Länge und Quelle; nächster Treffer gewinnt | Tausend Lesezeichen kosten so kaum mehr als eines. |
| Lesezeichen/Notizen | je Tab / je Datei | je Datei (geteilt wie in 013), Notizen im Speicher, neue Epoche leert sie; nicht gefundene Marken eines Arbeitsstands (`lostMarks`) bleiben über Epochen und werden beim Speichern mitgeschrieben | Prompt: „gehören zur Datei“, „bleiben im Arbeitsstand“. |
| Arbeitsstand-Inhalt | | Dateien/Merges (Pfad absolut + relativ, Profil, Profile der Quellen), je Tab Filter (Levels, Suche, Modus, Quellen, Baum), Eltern-Tab, Log/Dashboard, Folgen, oberste Zeile und Auswahl als Anker; je Datei Lesezeichen und Notizen; aktiver Tab; Spaltenmodus, Detail-Panel (sichtbar, Höhe, Umbruch), Seitenleiste (sichtbar, Breite), Zeitstrahl und Ruler an/aus; Spalten-Layouts der verwendeten Formate | Was „nach Neustart wieder da“ braucht. |
| Nicht im Arbeitsstand | | Dashboards (bleiben in `dashboards.json` je Format, referenziert über den Modus des Tabs), Zoom des Zeitstrahls, Filter geschlossener Eltern-Tabs (das Frontend kennt nur ihre Beschriftung; der Tab hängt dann unter dem Datei-Tab mit eigenem Filter), Extraktionsregeln und eigene Profile (Settings) | Fremdes SQL soll nicht über eine geteilte Datei kommen; der Rest ist Ansichtssache oder global. |
| Spalten-Layouts | übernehmen / nur fehlende | übernehmen (überschreibt das Layout dieses Formats in den Settings) | Der Arbeitsstand soll so aussehen wie gespeichert; bewusst geöffnet. |
| Version | | `format: "log-commander-workspace"`, `version: 2`; Version 1 = Entwurf (Dateien mit Levels, Suche, Lesezeichen als Zeilennummern) wird migriert, Lesezeichen ohne Hash werden über die Nummer gesetzt; neuere Version → Fehlermeldung | Migration ist getestet, bevor sie gebraucht wird. |
| Fremder Arbeitsstand | | `.lcw` liest/schreibt nur das Backend (`read_workspace`/`write_workspace`, nur Endung `.lcw`, absolut, ohne `..`, ≤ 8 MB, UTF-8, Schreiben über Temp + Rename). `parseWorkspace` prüft jedes Feld: Typen, Ganzzahlen und Bereiche, Hash-Format, Pfade absolut und ohne NUL (normalisiert), Profil-IDs `[\w.:-]`, höchstens 32 Dateien, 16 Quellen, 8 Tabs, 10 000 Marken je Datei, 2000 Zeichen je Notiz; Filterbaum über `sanitizeTree` (64 Bedingungen, 16 Ebenen); Ungültiges fällt weg und wird gezählt | Nichts wird ausgeführt; Regexe kompiliert das Backend (linear). Geöffnet wird nur lesend. |
| Fehlende Dateien | | Absolut, sonst relativ zur `.lcw` (`probe_paths`); sonst Dialog je Datei „Suchen …“/„Überspringen“, „Öffnen“ erst wenn alles entschieden, „Abbrechen“ bricht nur das Öffnen ab; Merge mit übersprungener Quelle öffnet mit dem Rest (Quellenmasken zurückgesetzt), unter 2 Quellen wird er übersprungen | Prompt: nicht abbrechen. |
| Native Dialoge im e2e | | `core/dialog/native-dialog.ts`: liegt in `window.__lcDialogPaths` eine Antwort, nimmt der Dialog sie | Wie `window.__lcTable`; nur Code der Seite kann es setzen, der könnte das Backend ohnehin direkt rufen. |
| Teilen | | Kontextmenü „Als Markdown/Jira kopieren“ (Eintrag unter der Maus bzw. Auswahl): Kopf (Datei, Zeilen, Zeit aus der Zeitstempel-Spalte, Filter als Kette), Codeblock (Fence länger als jede Backtick-Folge; Jira `{code}`, mit `{code` im Text `{noformat}`, mit beidem ein unsichtbares Leerzeichen nach `{`), Notizen als Liste; höchstens 64 KB an Zeilengrenze mit Hinweis, höchstens 20 000 Zeilen werden geholt | Ohne API-Zugriff auf Ticketsysteme (Prompt). |
| Kürzel | | `Cmd/Ctrl+Shift+E` Export (auch Menü), `Shift+M` Notiz (`M` bleibt Lesezeichen) | Gegen README-Tabelle, `app.ts`, `log-table-view.ts` geprüft: frei. |
| Farbe | | ein Token `--note` (dark `#4cc38a`, light `#0f7a4a`) für Stift, Ruler-Raute, Symbol im Detail-Panel | `npm run contrast` prüft gegen Gutter, Auswahl, Ruler, Band, App-Hintergrund. |

## Nachträge aus dem Sicherheits-Review (unabhängiger Agent)

| Befund | Behebung | Test |
|---|---|---|
| MEDIUM: Ein Arbeitsstand prüfte und öffnete beliebige Pfade ohne Rückfrage (UNC → SMB/NTLM, `/net` → Automount-Hänger, `~/.ssh/…` als Tab) | Bestätigung **vor** jedem Zugriff: Liste der Dateien mit Häkchen, nur angehakte werden geprüft (`probe_paths`) und geöffnet. Netzwerkpfade (`\\host`, `\\?\UNC\`, `//host`, `/net/`, `/Network/`) sind ausgegraut, „nicht geöffnet (Netzwerkpfad)“, auch nicht als relativer Kandidat; das Backend prüft sie in `probe_paths` und `read_workspace` ebenfalls nicht. `/Volumes/` bleibt erlaubt (lokale Laufwerke), steht aber sichtbar in der Liste. „Suchen …“ (eigene Wahl im Dialog) bleibt frei | `workspace-paths.spec`, `workspace-model.spec`, `workspace.rs` (Netzwerkpfade), e2e (Liste vor dem Öffnen, Netzwerkpfad ausgegraut und im Bericht) |
| Beim Nachtest gefunden: `normalizePath` machte aus `//host/x` den lokalen Pfad `/host/x` (Netzwerkpfad nicht mehr erkennbar) | Netzwerkpfade bleiben beim Einlesen unverändert | `workspace-model.spec` |
| MEDIUM: Jira-Kopie ließ `!` stehen (`!url!` lädt ein Bild) | `escapeJira` maskiert `\ * _ { } [ ] \| ^ ~ + ? ! -`, `escapeMarkdown` zusätzlich `!` | `share-format.spec` |
| LOW: FIFO als `.lcw` blockierte `open` | erst `metadata().is_file()`, dann unter Unix mit `O_NONBLOCK` öffnen; `busy` wird in `finally` zurückgesetzt | `workspace.rs` (mkfifo, < 1 s) |
| LOW: Spalten-Layouts unbegrenzt und still überschrieben | `mergeColumnLayouts` (Settings und Arbeitsstand): höchstens 256 Profile, je Liste 256 Einträge, IDs ≤ 128 Zeichen; Übernahme nur mit Häkchen „Spaltenlayouts übernehmen“ in der Bestätigung (Vorgabe aus) | `settings.models.spec`, e2e (Häkchen aus) |
| LOW: `window.__lcDialogPaths` auch im Release | nur wenn `scripted_dialogs` true liefert: Debug-Build **und** `LC_E2E_SCRIPT` gesetzt; Release immer false | `native-dialog.spec` (`takeScripted`) |
| LOW: parallele Exporte unbegrenzt, `.part` nach Beenden | höchstens 2 zugleich (`too_large`), beim Beenden (`RunEvent::Exit`) werden alle Jobs abgebrochen und ihre Temp-Dateien gelöscht. Ein Absturz kann eine versteckte `.part` hinterlassen (Ordner beliebig, kein Scan beim Start) | `export.rs` (`exports_are_limited_and_cleaned_up_on_quit`) |
| Prüfen: ANSI im Export | Export nutzt `display_text` wie die Ansicht: keine Escape-Sequenzen in TXT, CSV, JSONL | `ansi_colours_are_not_exported` |

## Messwerte (Release, Apple Silicon, `cargo test --release --test export_integration -- --ignored --nocapture measure_`)

500 MB, 5,1 Mio. Zeilen, unter Last (Marc lässt teils `demo:log` laufen):

| Export | Zeit | geschrieben | `get_lines` daneben (max.) |
|---|---|---|---|
| TXT | 0,55 s | 500 MB (≈ 910 MB/s) | 0,4 ms |
| CSV ohne Spalten | 2,1 s (vor Optimierung des Quotings) | 598 MB | 0,4 ms |
| CSV mit 5 Spalten | 9,8 s | 618 MB | 0,6 ms |
| JSON Lines mit 5 Spalten | 10,0 s | 949 MB | 0,6 ms |

Speicher: ein Schritt zu 16 K Index-Einträgen, Lesepuffer 1 MiB, Schreibpuffer 1 MiB; keine Kopie der Liste. Mit Spalten
bestimmt das Zerlegen je Zeile (Regex des Formats) die Zeit. Einlesen, Filter und Suche sind nicht verändert (nur neue
Methoden in `session.rs`), daher keine `measure_`-Vorher/Nachher-Messung von `tail_integration`.

## Fortschritt

- [x] Rust: `export.rs`, `anchor.rs`, `workspace.rs`, Commands, Fehlercodes `invalid_export`, `file_changed`, `invalid_workspace`, Menü
- [x] Rust-Tests: `tests/export_integration.rs` (Formate, Umlaute/Emoji, UTF-16, Zeile > 128 KB, CRLF, CSV-Sonderzeichen und Formeln, Spalten, Ansicht/Auswahl mit Filter, Tail während des Exports, Abbruch ohne Reste, Ziel = Quelle auch per Hardlink, Truncation während des Exports, Anker: Neustart, eingefügte Zeilen, Rotation, Leeren, doppelte Zeilen), Unit-Tests in den Modulen
- [x] Frontend: Export-Dialog, Status mit Abbrechen, Notizen (Dialog, Gutter, Ruler, Detail-Panel), Teilen, Arbeitsstand (Speichern, Öffnen, fehlende Dateien, Bericht, zuletzt geöffnet mit ❖)
- [x] Vitest: `workspace-model.spec.ts`, `workspace-paths.spec.ts`, `share-format.spec.ts`, `export-logic.spec.ts`, Row-Menü
- [x] e2e: Export per Command und per Dialog (skriptierter Pfad), Ziel = Log abgelehnt, Notiz und Lesezeichen, Filter-Tab, Arbeitsstand speichern, alles schließen, aus „Zuletzt geöffnet“ wieder öffnen; fremder Arbeitsstand mit fehlender Datei, relativ gefundener Datei, nicht gefundener Notiz und ungültigem Eintrag
- [x] Doku, Screenshots

## e2e-Verlauf

Erster Lauf mit Build, danach nur das Szenario korrigiert (`--no-build`, kein Rebuild nötig): Spaltenmodus war aus dem
vorigen Szenario-Teil schon „raw“ (T schaltete zurück), der „Öffnen“-Knopf des noch offenen Pfad-Dialogs wurde statt dem
des Arbeitsstand-Dialogs getroffen. Keine Produktfehler. Hinweis: Ein über den Pfad-Dialog geöffneter Arbeitsstand lässt
diesen Dialog offen, bis das Wiederherstellen fertig ist (der Fehlende-Dateien-Dialog liegt darüber).

## Nur von Hand prüfbar

Native Speichern-/Öffnen-Dialoge, Menüeinträge, Zwischenablage (Teilen), Windows-Pfade/Netzlaufwerke (nur per Unit-Test der
Pfadlogik), Sichttest hell/dunkel des Notiz-Stifts und der Ruler-Raute mit `demo:log`.
