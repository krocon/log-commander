# 006 Log-Dateien zusammenführen – Design und Stand

Status: umgesetzt (Phase 1–3), `npm run check` und `npm run e2e` (202 Schritte) grün, Halt nach Phase 1 nicht nötig (Messwerte unter den Grenzen)
Datum: 2026-11-07
Branch: `feat/merge-log-files`

## Abgleich mit dem Bestand

- Der Prompt nennt noch die alte Ansicht (`log-view.ts`, `.mark`, `.gutter`, `measure` in `log-view.ts:262`). Die gibt es nicht
  mehr: einzige Ansicht ist die GuiExpert Table (`features/log-table/`). Die Herkunft steht deshalb in der **Gutter-Spalte**
  der Tabelle (fixe linke Spalte, gleiche Zeilenhöhe, auch in der Spaltenansicht): kurzer Dateiname plus Farbstreifen
  (`lt-src src-N`). Bei Merges ist die Gutter auch dann sichtbar, wenn Zeilennummern ausgeschaltet sind.
- `timestamp.rs` hatte 008 schon angelegt (alle Formate der Tabelle). Wiederverwendet, nur Tests ergänzt (`2022-13-45`,
  `2022-02-30`). Syslog über den Jahreswechsel und Zeitzonen waren schon abgedeckt.
- Zeilenangaben im Prompt (`tail.rs:282`, `:362`, `session.rs:515/618`, `indexer.rs:213/239`, `filter.rs:100`) waren
  verschoben; die Stellen sind gefunden und angepasst.

## Entscheidungen (statt Rückfrage, Auftrag: autonom)

| Frage | Optionen | Entscheidung | Grund |
|---|---|---|---|
| Einlesen | (a) wie im Prompt: alle Quellen in temporäre Listen, mischen, schreiben; (b) Streaming-Merge | **(b)** Die Quelle, die zeitlich hinten liegt, wird als nächste gelesen; freigegeben wird, was unter dem kleinsten Stand aller unfertigen Quellen liegt. Eine Quelle außer der Reihe (ein Eintrag fiele vor schon Freigegebenes) startet das Laden neu, diese Quelle wird dann ganz gelesen und stabil sortiert | (a) hält Zeilen doppelt (Temp + Index) und wäre über dem 2×-Speicherlimit gelandet. (b) braucht für geordnete Quellen nur den Index; ungeordnete kosten einmal Neulesen und temporären Speicher nur für sich. Gleicher Algorithmus wie live |
| Tailer zerlegen | (a) `Tailer` in Datei-Teil und Ziel aufteilen; (b) Hilfen teilen, eigener Worker | **(b)** `Sample::of`, `suggest`, `text_matches` und die Konstanten aus `tail.rs` sind geteilt, `merge.rs` hat einen eigenen Worker (`SourceFile` + `Runner`) mit einem `wake`-Kanal | Der Einzeldatei-Pfad bleibt Byte für Byte gleich (`tail_integration.rs` unverändert grün, `measure_` gleich), weniger Risiko |
| Profil je Quelle | Detektor/`prev` je Quelle in `SessionData` | Im `Merger` je Quelle (Detektor, `PrevLine`, Zeitparser). `run_relevel` läuft für Merges nie, weil `set_profile` `invalid_merge` liefert | Prompt-Vorgabe 3; Neu-Leveln über gemischte Quellen entfällt |
| `open_merged` | `paths` | `sources: [{ path, profileId? }]` | Der Dialog erlaubt das Profil je Datei zu ändern |
| Dialog-Vorschau | – | Neuer Befehl `inspect_merge_source(path)`: Profilvorschlag, Encoding, erste/letzte Zeit, Größe | Erste und letzte Zeit vor dem Öffnen |
| „Neu sortieren“ | – | Befehl `resort(sessionId)`, setzt `resort_requested`, Worker mischt neu (`epoch + 1`) | |
| Fehlercodes | – | `no_timestamps` (Prompt) und `invalid_merge` (Anzahl, doppelte Datei, `set_profile` auf Merge, `resort` auf Einzeldatei) | Doppelte erkennt das Backend über die Datei-Identität, nicht nur über den Pfad |
| Leere Datei im Merge | ablehnen / zulassen | zulassen | Prompt-Test „leere Datei“; ihre Zeilen kommen live |
| Spalten | je Quelle / eine | Format der ersten Datei; andere Formate fallen auf `message` zurück | Ein `ColumnSet` je Sitzung; Spalten je Quelle in die Roadmap |
| Statistik je Quelle | Zeilen „Alle“ und „Ansicht“ | Nur „Alle“ (`SourceUpdate.lines`), „Ansicht“ `–` | Ansicht je Quelle bräuchte Zähler je Quelle im Filter |
| Messung Spitzenspeicher | `ps`/RSS, eigener Allokator | Zählender `GlobalAlloc` in `tests/merge_integration.rs`, `measure_merge` dort statt in `tail_integration.rs` | Genau und plattformunabhängig, ohne `tail_integration.rs` (und dessen `measure_`) zu verändern |
| `set_filter` | Signatur ändern | `set_filter` bleibt, neu `set_filter_with_sources`; der Command nimmt `sources: Option<u16>` | Vorhandene Tests bleiben unverändert |

## Verträge

- Rust: `open_merged(sources, keepOnRotate, onUpdate) -> SessionInfo`, `inspect_merge_source(path) -> MergeCandidate`,
  `resort(sessionId)`, `set_filter(..., sources?)`.
- DTOs: `SessionInfo.sources: SourceInfo[] { index, path, fileName, profileId, encoding }`, `LogLine.source`,
  `SessionUpdate.sources: SourceUpdate[] { status, fileSize, lines, lateLines }` (leer bei Einzeldateien, `fileSize` = Summe),
  `EntryDetail.source`, `EntryDetail.byteOffset`, `MergeCandidate`.
- Kürzel `Cmd/Ctrl+Shift+M`, Menü „Merge Files…“ (`menu-merge`), Button „Zusammenführen …“ in der Tab-Leiste, Startseite.
- Dialog: `<dialog>` modal mit `aria-labelledby`, Profil-Select je Datei mit `aria-label`, Fehler je Datei `role="alert"`.
- Quellen-Chips: `aria-pressed`, Name immer als Text (nie nur Farbe).

## Messwerte (Apple Silicon, release)

`measure_` (Einzeldatei 500 MB), vorher → nachher:

| | vorher | nachher |
|---|---|---|
| erste Zeilen | 23,9 ms | 24,4 ms |
| indexiert | 2,15 s | 2,15 s |
| Level-Filter | 30 ms | 30 ms |
| Suchfilter | 719 ms | 729 ms |
| `get_lines` 200 | 292 µs | 289 µs |
| `get_lines` 5000 mit Layout | 7,0 ms | 7,0 ms |
| Tail 10k Zeilen/s | 29 Updates in 3 s | 29 Updates in 3 s |

`measure_merge` (2 × 500 MB ineinandergreifend gegen 1 × 1000 MB, gleicher Inhalt):

| | Einzeldatei | Merge | Faktor |
|---|---|---|---|
| Öffnen (10,2 Mio. Zeilen) | 4,29 s | 6,65 s | 1,55 |
| Spitzenspeicher | +259 MB | +264 MB | 1,02 |
| `get_lines` 200 | 280 µs | 283 µs | 1,0 |
| Level-Filter | 45 ms | 45 ms | 1,0 |
| Suchfilter | 1,45 s | 1,47 s | 1,02 |
| Suche rückwärts | 31 ms | 32 ms | 1,0 |

Die Merge-Reihenfolge ist an drei Stellen gegen die Einzeldatei geprüft (identisch). Grenzen des Halts (Filter/Suche
> 2×, Speicher > 2×) nicht erreicht → weiter ohne Halt.

## Fortschritt

- [x] Phase 1: `timestamp.rs` (vorhanden, Tests ergänzt), Quellen im Offset, `LineReader` mit Puffer je Quelle,
      Quellenfilter, `merge.rs` (Merger + Worker), Commands und DTOs, `measure_merge`
- [x] Phase 2: Dialog, Einstieg (Tabs, Menü, Kürzel, Startseite), Service (`openMerged`, Dedupe, keine Recent-Liste),
      Gutter mit Name und Farbe, Chips, Baum- und Statistikzeilen je Quelle, Statusleiste (Summe, „gemischt“, Zustände,
      „N verspätet · Neu sortieren“), Detail-Panel (Datei, Byte-Offset), Kopieren roh
- [x] Phase 3: Haltepuffer, verspätete Zeilen, Fortsetzung nach Freigabe, Rotation, Truncation, `keep_on_rotate = false`,
      `MAX_SEGMENTS`, fehlende Datei, Freeze, stille Quelle – alles mit Tests in `merge_integration.rs`
- [x] e2e: Dialog mit offenen Tabs, Datei ohne Zeitstempel abgelehnt, Reihenfolge, Gutter, Quellenfilter, zwei
      Generatoren (5000/s mit Rotation alle 20 000 Zeilen, 20/s), Reihenfolge der letzten 5000 Zeilen
- [x] Doku, Screenshots (`merge.png`, `merge-dialog.png`)

## Offen / nur von Hand

- Nativer Dateidialog im Merge-Dialog, Menüpunkt, Sichttest mit zwei `demo:log`-Generatoren im Fenster (hell/dunkel).
- Eine Rate von 1 Zeile/min neben 5000/s ist im e2e durch 20/s ersetzt (gen-log schreibt mindestens eine Zeile je Tick);
  das Verhalten der stillen Quelle prüft `a_silent_source_holds_up_the_others_at_most_hold_back`.
