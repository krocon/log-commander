# Prompt 006: Log-Dateien zusammenführen

> Start in neuer Sitzung: „Führe `prompts/006-merge-log-files.md` aus.“
> Technisch unabhängig von 004 und 005. Sind sie umgesetzt, zeigt das Panel auch die Quelle und der Baum die Quelldateien.
> `timestamp.rs` wird auch von 008 gebraucht: Ist 008 zuerst dran, dort anlegen und hier wiederverwenden.
> Umfangreicher Prompt: in Phasen arbeiten, Halt nach Phase 1 beachten.
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

Mehrere Logdateien öffnen sich als ein Tab, ihre Einträge sind nach Zeitstempel sortiert und lesen sich wie das Log eines
einzigen Prozesses. Die Herkunft jeder Zeile ist sichtbar, nach Quelle lässt sich filtern, und neue Zeilen laufen live ein.

## Entscheidungen

### Eine Sitzung mit einem Index, keine Ansicht über mehrere Sitzungen

Der Merge ist eine `LogSession`, deren `LineIndex` Zeilen aller Quellen in Zeitfolge enthält. Das Schema aus `indexer.rs`
ist dafür gedacht: Eine `LineEntry` trägt einen virtuellen Offset, `LineReader` findet darüber Segment und Encoding
(`indexer.rs:239`). `get_lines`, Filter, Suche, `entry_range` und `copy_lines` arbeiten damit weitgehend unverändert. Ein Tab
für den Merge öffnet eigene Handles; bereits offene Tabs der Dateien bleiben unberührt.

Verworfen: Liste von `(Sitzung, Zeile)` über den vorhandenen Sitzungen. Sie bräuchte eigene Wege für Filter und Suche und
hielte zusätzlich jeden Einzelindex im Speicher.

### Adressraum je Quelle

Heute wächst nur das letzte Segment, das Schema setzt das voraus. Bei N gleichzeitig wachsenden Dateien würden sich die
Bereiche überschneiden. Deshalb: `base = (source as u64) << 56`, Rotation innerhalb der Quelle bleibt `base + read_pos`.

- Die Quelle einer Zeile ist `offset >> 56`. Das kostet keinen Speicher, die 16 Byte je Zeile bleiben.
- Einzeldateien sind Quelle 0 und verhalten sich exakt wie bisher.
- `segments` muss nach `base` sortiert bleiben (`segment_of` nutzt `partition_point`). `switch_file` pusht heute ans Ende
  (`tail.rs:362`), das wird zum sortierten Einfügen.
- Höchstens 16 Quellen (Maske `u16` im Filter). Der Dialog meldet das, statt still abzuschneiden.

### Sortierung

Sortiert werden **Einträge**, nicht Zeilen: Kopf und Fortsetzungszeilen bleiben zusammen, sonst würde `entry_range`
(`session.rs:515`) fremde Zeilen als Stacktrace zeigen. Schlüssel: `(Zeit, Quelle, Reihenfolge in der Datei)`, damit stabil
und reproduzierbar.

- K-Wege-Merge über die Quellen. Eine Quelle, deren Einträge nicht aufsteigend sind (mehrere Threads schreiben versetzt),
  wird vorher stabil sortiert. Prüfung beim Einlesen.
- Eintrag ohne erkennbare Zeit bleibt bei seinem Vorgänger aus derselben Datei. Vor dem ersten Zeitstempel einer Datei:
  an den Anfang dieser Datei.
- Findet sich in den ersten 200 Zeilen einer Datei keine Zeit: Merge verweigern mit klarem Text und Dateinamen. Neuer Code
  `no_timestamps` in `error.rs` und `AppError`. Nicht heimlich ans Ende hängen.

### Live: Anhängen statt Einfügen

Neue Zeilen werden **nur angehängt**. Einfügen in der Mitte würde Zeilennummern, die gefilterte Liste und den `PageCache` bei
jedem Update ungültig machen, und die Ansicht beim Lesen wandern lassen.

- **Haltepuffer:** Neue Einträge warten je Quelle bis `HOLD_BACK = 1 s`. Freigegeben wird in Zeitfolge bis zum Wasserstand
  (kleinste zuletzt gesehene Zeit der aktiven Quellen). Eine Quelle ohne neue Daten seit `HOLD_BACK` zählt nicht mehr mit, und
  kein Eintrag wartet länger als `HOLD_BACK`. Eine stille Datei darf den Merge nicht anhalten.
- **Zu spät:** Ein Eintrag, der älter ist als der zuletzt freigegebene, wird am Ende angehängt und gezählt (`late_lines`). Die
  Statusleiste zeigt das samt „Neu sortieren“, das vollständig neu mischt (`epoch + 1`). So bleibt die Abweichung sichtbar,
  statt dass die Reihenfolge still falsch ist.
- **Fortsetzung nach Freigabe:** Kommt eine Fortsetzungszeile, nachdem ihr Eintrag schon freigegeben ist und andere Quellen
  folgten, darf sie nicht als `continuation` angehängt werden, sonst hängt sie an einem fremden Kopf. Sie wird eine eigene
  Zeile und zählt als verspätet.
- **Keine provisorische Zeile:** Sie lässt sich nur am Ende ersetzen. Eine Zeile ohne `\n` bleibt im Puffer und wird nach der
  Pause von `PARTIAL_COMMIT_AFTER` endgültig. Wächst sie danach, kommt der Rest als eigene Zeile. In die Doku als Grenze.

## Phase 1: Backend, ohne Live

1. **`timestamp.rs`**, frei von Tauri: `parse(line) -> Option<i64>` in Mikrosekunden UTC, ohne Regex je Zeile. Das Format wird
   je Quelle aus einer Stichprobe bestimmt und dann zuerst versucht, sonst fällt die 500-MB-Messung ab. Formate:

   | Beispiel | Hinweis |
   |---|---|
   | `2022-01-12 10:36:43,544`, `…T10:36:43.544Z`, `…+01:00` | Log4j, Logback, ISO 8601, Mikrosekunden, Komma und Punkt |
   | `[2022-01-12 10:36:43]`, `2022/01/12 10:36:43` | Serilog-Varianten, nginx error |
   | `12/Jan/2022:10:36:43 +0000` | Apache und nginx access, steht nicht am Zeilenanfang |
   | `Jan 12 10:36:43` | Syslog ohne Jahr: Jahr aus der Änderungszeit der Datei, Monat danach zählt als Vorjahr |
   | `10:36:43.544` | Nur Uhrzeit: Datum aus der Änderungszeit, starker Rücksprung zählt als neuer Tag |
   | JSON `timestamp`, `@timestamp`, `time`, `ts` | Als String oder als Epoch in s/ms, vorhandene JSON-Erkennung aus `level.rs` nutzen |

   Ohne Zeitzone gilt die lokale Zone des Rechners. Dafür ist `chrono` als Abhängigkeit in Ordnung, in den Bericht aufnehmen.

2. **Quellen in `SessionData`:** Encoding, `detector` und `prev` gibt es heute je Sitzung. Beim Merge gehören sie je Quelle:
   Das betrifft `ingest` (`tail.rs:282`, liest `data.encoding`) und `run_relevel` (`session.rs:618`, läuft mit einem Detektor und
   einem `prev` linear durch den Index). Log4j und JSON Lines im selben Merge müssen beide richtig erkannt werden.

3. **Profilwechsel:** Das Profil wird je Datei vor dem Einlesen bestimmt (`suggest_profile`), Überschreiben geht nur im
   Dialog. `set_profile` auf einem Merge liefert einen Fehler, die Toolbar zeigt die Auswahl deaktiviert. Das vermeidet das
   Neu-Leveln über gemischte Quellen.

4. **`LineReader` mit Puffer je Quelle.** Der eine gleitende Puffer (`indexer.rs:213`) lädt bei jedem Fehlgriff bis zu 1 MB. Beim
   Merge wechselt die Quelle fast je Zeile, also liefe ein Filter oder eine Suche mit einem Megabyte Lesen je Zeile. Ein
   Puffer je `offset >> 56` löst das. Vorher und nachher messen. `.backward()` für die Suche rückwärts mitdenken.

5. **Tailer zerlegen:** Der Dateiteil von `Tailer` (Blöcke, Splitter, Rotation, Truncation, fehlende Datei) wird von der Frage
   getrennt, wohin Zeilen gehen. Einzeldatei schreibt weiter direkt in den Index, und alle vorhandenen Tests bleiben unverändert
   grün. Der Merge nutzt einen Worker mit N Quellen. Einen einzigen `wake`-Kanal behalten.

6. **Einlesen:** Alle Quellen lesen, je Eintrag Zeit und Position in temporäre Listen, mischen, dann in Stapeln (`JOB_BATCH`) in
   `index` und `filter.append` schreiben, damit die Schreibsperre kurz bleibt. Text für Filter wie in `ingest` vor der Sperre
   lesen. Temporäre Listen danach freigeben. `Status::Loading` über die Summe der Bytes, Mischen als letztes Stück.

7. **Befehl und DTOs:** `open_merged(paths, keep_on_rotate, on_update) -> SessionInfo`. `SessionInfo.sources`:
   `{ index, path, fileName, profileId, encoding }`. `LogLine.source: u8`. `SessionUpdate.sources`:
   `{ status, fileSize, lateLines }` je Quelle (leer bei Einzeldateien), `file_size` ist die Summe. `mock-ipc.js` nachziehen.

8. **Quellenfilter:** `FilterSpec.sources: u16` (`filter.rs:100`), `is_identity` und `append` berücksichtigen, `set_filter` um
   `sources` ergänzen. Entschieden wird am Kopf, der Eintrag bleibt ganz.

### Halt nach Phase 1 🛑

Messung als `measure_merge` in `tail_integration.rs` (`--ignored`), 2 × 500 MB ineinandergreifend: Dauer und Spitzenspeicher
beim Öffnen, `get_lines`, Filter und Suche gegenüber einer Einzeldatei gleicher Gesamtgröße. Ergebnis kurz im Bericht. **Nur
anhalten und nachfragen, wenn** Filter oder Suche mehr als doppelt so lange dauern, der Spitzenspeicher mehr als das Doppelte
der Einzeldatei braucht oder eine Annahme oben nicht hält. Sonst weiter mit Phase 2.

## Phase 2: Oberfläche

1. **Dialog** `features/merge/merge-dialog.ts`: offene Tabs zum Ankreuzen, weitere Dateien über den Dateidialog (mehrfach),
   Vorschlag für Profil je Datei mit Änderungsmöglichkeit, Vorschau „Erste Zeit, letzte Zeit“. Doppelte Pfade ablehnen. Zwei
   bis 16 Dateien. Fehlermeldungen je Datei, nicht pauschal.
2. **Einstieg:** Button neben „Öffnen“ in den Tabs, Menüpunkt über `MenuItem` und `menu-merge` in `lib.rs` (wie `menu-open`),
   Kürzel `Cmd/Ctrl+Shift+M` in `app.ts`. Der Startbildschirm bietet es an.
3. **Service:** `LogSessionService.openMerged`. `tryOpen` entprellt über `s.path` (`log-session.service.ts:45`), ein Merge hat
   keinen Pfad: über die sortierten Quellen vergleichen. `addRecentFile` nicht für Merges. Titel „Merge (3 Dateien)“, Titel des
   Tabs mit den Namen.
4. **Herkunft in der Zeile:** Farbstreifen neben `.mark` plus kurzer Dateiname in einer festen Spalte, nur bei Merge-Tabs. Die
   Spalte gehört wie `.gutter` in das Zeilenraster, `measure` (`log-view.ts:262`) rechnet über `.text` und stimmt dann weiter.
   Acht Farben `--src-1` … `--src-8` in `styles.css`, dunkel und hell, danach `npm run contrast`, ab der neunten Quelle wieder von
   vorn mit dem Namen als Unterscheidung. Keine Information nur über Farbe.
5. **Quellenfilter:** Chips in der Toolbar, nur bei Merge-Tabs. Falls 005 da ist, zusätzlich Quelldateien als Knoten im Baum mit
   Status und in der Statistik je eine Zeile.
6. **Statusleiste:** Summe der Größe, „gemischt“ statt Encoding, Zustand je Quelle (eine fehlende Datei stoppt nicht den Rest), „N
   verspätet · Neu sortieren“.
7. **Detail-Panel** (falls 004 da ist): Quelldatei und Byte-Offset im Kopf. Die Zeilennummer in der Quelldatei gibt es nicht, sie
   wäre eine weitere Spalte im Index. In die Doku als Grenze.
8. **Kopieren:** Text bleibt roh, ohne Präfix.

## Phase 3: Live

Haltepuffer und Regeln von oben, dann die Sonderfälle:

| Fall | Verhalten | Test |
|---|---|---|
| Rotation einer Quelle | Neues Segment im Bereich der Quelle, sortiert einfügen, Rest läuft weiter | ja |
| Truncation einer Quelle oder `keep_on_rotate = false` | Vollständig neu mischen, `epoch + 1`, Status `Truncated` bzw. `Rotated` | ja |
| Mehr als `MAX_SEGMENTS` bei einer Quelle | Neu mischen ohne die alten Segmente dieser Quelle | ja |
| Datei fehlt | Zustand nur für diese Quelle, ihre bisherigen Zeilen bleiben | ja |
| Freeze | Gilt für alle Quellen, `pending_bytes` ist die Summe, `frozen_stale` wenn eine geschrumpft ist. Puffer bleibt stehen | ja |
| Stille Quelle | Hält den Rest höchstens `HOLD_BACK` auf | ja |
| Sehr ungleiche Raten | 5000 Zeilen/s neben 1 Zeile/min bleibt ruhig | e2e |

`displayedLines` aus `displayed-lines.ts` funktioniert unverändert, weil nur angehängt wird. Die 1 s Verzögerung nennt das
Handbuch.

## Tests

- **Rust, rein:** Zeitstempel als Tabelle je Format, Zeitzone, Komma und Punkt, Syslog am Jahreswechsel, kaputte Daten
  (`2022-13-45`). Mischen: gleichstand stabil, Eintrag bleibt zusammen, ungeordnete Quelle, Kopf ohne Zeit, Datei beginnt ohne Zeit.
- **Rust, Integration:** zwei und 16 Quellen, UTF-8 neben UTF-16, Log4j neben JSON Lines, CRLF, leere Datei. Filter und Suche
  (vor- und rückwärts) über Quellen. `entry_range` und `copy_lines`. Live, verspätet, Fortsetzung nach Freigabe, Neu sortieren
  und alles aus der Tabelle oben. Für Einzeldateien bleibt `tail_integration.rs` unverändert grün.
- **Vitest:** Dedupe in `openMerged`, Chips, Zuordnung der Farben, Fehlertext.
- **e2e:** zwei Dateien aus `samples/` mergen, Reihenfolge prüfen, Quellenfilter, zwei laufende Generatoren
  (`scripts/gen-log.mjs`), Rotation (`--rotate-every`) einer Quelle. Dateidialog im Dialog ist nicht abgedeckt, Pfade über den Befehl
  einspeisen und das im Bericht nennen.

## Nicht in diesem Prompt

Zeitversatz je Datei für Hosts mit abweichender Uhr, Zeitzone je Datei, Archive (`.gz`, `.zip`), Ordner und Glob, Merge speichern
oder exportieren, Merge in die „zuletzt geöffnet“-Liste, Zeitfenster-Filter. Die ersten beiden sind die wahrscheinlichsten
Nachfragen, in `docs/roadmap.md` aufnehmen.

## Fertig, wenn

- [ ] Tests oben grün, `npm run check`, `npm run contrast` und `npm run e2e` grün
- [ ] Vorhandene Tests für Einzeldateien unverändert grün, `measure_`-Werte der Einzeldatei nicht schlechter
- [ ] `measure_merge` läuft, Werte stehen im Bericht
- [ ] Zwei laufende Dateien mit 5000 Zeilen/s lesen sich ruhig und in Zeitfolge
- [ ] `README.md`, Screenshot, `docs/roadmap.md` (Merge-View raus, Nachfragen rein)
- [ ] `CLAUDE.md`: Entscheidungen (Adressraum, Anhängen, Haltepuffer), Grenzen (16 Quellen, verspätete Zeilen, keine Zeilennummer der
      Quelldatei, lokale Zone), Layout (`timestamp.rs`, `features/merge`)
- [ ] Sichttest mit zwei `npm run demo:log`-artigen Generatoren, sonst im Bericht als offen genannt

Kein Commit ohne Rückfrage.
