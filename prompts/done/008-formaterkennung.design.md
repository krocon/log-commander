# 008 Formaterkennung: Design und Entscheidungen

Status: umgesetzt · Datum: 2026-11-07 · Branch `feat/formaterkennung`

Der Prompt verlangt keinen Haltepunkt. Offene Punkte wurden ohne Rückfrage entschieden (Auftrag: autonom arbeiten), hier
mit Optionen, Entscheidung und Grund.

## Verträge

- `LogLine.fields: [u32; 2][]` (UTF-16, je Spalte, leer `[0, 0]`), `SessionUpdate.columnsRevision`.
- `get_columns(sessionId) -> ColumnSet { revision, confidence, profileId, inferredLayout, columns: [{ id, label, kind }] }`,
  `kind` = `timestamp | level | text | number`.
- `preview_fields(profile, line) -> FieldPreview { columns, fields, matched }` für das Testfeld der Einstellungen.
- `Profile.layouts: string[]`, `Profile.structure: regex | json | logfmt | fix | w3c` (beide `#[serde(default)]`).
- Keine neuen Fehlercodes: kaputte Layouts melden sich wie kaputte Level-Regexes über `invalid_profile`.

## Entscheidungen

| Frage | Optionen | Entscheidung | Grund |
|---|---|---|---|
| Wie markiert ein Profil JSON/logfmt/FIX/W3C? | Sonderwerte in `layouts`; eigenes Feld | `structure` als Enum, Vorgabe `regex` | Ein Layout bleibt immer eine Regex; kein zweites Konzept, nur ein Feld am `Profile`. |
| Trenner aus der Inferenz | eigene Struktur `delimited`; Regex | Regex `^\s*(?P<a>[^|]*?)\s*\|…(?P<message>.*?)\s*$` | Der Prompt verlangt „gewöhnliche Regex oder Trenner“; die Regex lässt sich unverändert in ein eigenes Profil übernehmen. |
| W3C | Regex aus dem Kopf bauen; eigener Scanner | Scanner, Namen aus `#Fields:` als Label, Ids bereinigt (`cs(User-Agent)` → `cs_user_agent_`) | Gruppennamen einer Regex können keine `-` oder `()` enthalten, die Originalnamen sollen sichtbar bleiben. |
| Spalten eines Profils mit mehreren Layouts | Vereinigung aller Layouts; nur genutzte | nur Layouts, die in der Stichprobe passen (sonst alle) | Eine Logback-Datei bekommt sonst die `pid`-Spalte von Spring Boot. |
| Optionale Gruppen, die die Stichprobe nie füllt | als leere Spalte behalten; weglassen | weglassen (außer `message`) | Spring Boot vor 3.2 hätte sonst eine immer leere Spalte `application`. |
| Schwelle | 80 % hart | eingebaut ab 80 %, sonst das Bessere aus Inferenz und eingebautem ab 50 %, darunter nur `message` | Die Statusleiste soll „nur teilweise erkannt“ auch zeigen können; unter 50 % ist eine Zerlegung eher irreführend. |
| Fortsetzungszeilen in der Quote | `looks_like_continuation`; `classify` des Kandidaten | `classify` des jeweiligen Profils | Auch `ValueError: …` nach einem Python-Traceback zählt so als Fortsetzung. Zusätzlich mindestens 2 Eintragsköpfe. |
| Level-Vorschlag | `suggest_profile` allein; Format zuerst | eingebautes Format ab 80 % bestimmt den Vorschlag, sonst `suggest_profile` | Profil in der Toolbar und Spalten passen dann zusammen; `suggest_profile` und seine Tests bleiben. |
| Profil ohne Layout (Generic, alte eigene Profile) | nur `message`; Inferenz | Inferenz | Generic heißt „erkenne selbst“; alte eigene Profile verlieren nichts. |
| Neue `viewGeneration` beim Formatwechsel | Job-Generation hochzählen; eigener Zähler | eigener Zähler `view_counter` in `Shared` | Die Job-Generation bricht laufende Jobs ab; eine erste Erkennung (leere Datei, die später Zeilen bekommt) darf das nicht. Die Werte bleiben eindeutig und steigend. |
| Wann wirkt ein Profilwechsel auf die Spalten | sofort; mit dem Job | mit dem Ende des Neu-Level-Jobs (`requested_format`), zusammen mit der `viewGeneration` | So passen gecachte Seiten nie zu fremden Spalten. |
| SOH bei FIX | nur in den Spannen; in `display_text` | `display_text` zeigt `\x01` als `|` | Eine UTF-16-Einheit gegen eine, Spannen bleiben gleich; Suche, Kopieren und Anzeige sehen dasselbe. |
| Access-Log-Level | keine; Status als Level | 4xx = WARN, 5xx = ERROR, sonst Eintrag ohne Level | Ein Access-Log ohne Farbe ist wenig hilfreich; über `mapping` ohne neuen Code. |
| FIX-Level | keine; Reject | `35=3` und `35=j` (Reject) als ERROR | Gleiches Mittel (`mapping`). |
| Anzeige der Quote | Statusleiste dauerhaft; Tooltip | Tooltip am Profil in der Toolbar („Format-Profil: Log4j … · 97 %“), Statusleiste nur unter 80 % mit „Format nur teilweise erkannt“ | Die Statusleiste bleibt für gut erkannte Dateien unverändert. |
| `timestamp.rs` | Regex je Format; Scanner | Scanner ohne Regex, Format je Quelle aus der Stichprobe, `chrono` für die lokale Zone | Vorgabe aus 006 Phase 1. 008 nutzt `recognise` (Inferenz) und die Regex-Fragmente; `TimestampParser` ist für 006 fertig und getestet. |

## Messwerte

`cd src-tauri && cargo test --release --test tail_integration -- --ignored --nocapture measure_` (500 MB, 5,1 Mio. Zeilen, Apple Silicon):

| | vorher | nachher |
|---|---|---|
| erste Zeilen | 10 ms | 24 ms (Formaterkennung über 200 Zeilen und 13 Profile im ersten Block) |
| indexiert | 2,15 s | 2,17 s |
| Level-Filter | 25 ms | 25 ms |
| Suchfilter | 702 ms | 717 ms |
| `get_lines` 200 Zeilen, zufällig | 44 µs | 291 µs |
| `get_lines` 5000 Zeilen mit Layout | – | 7,1 ms |
| `get_lines` 5000 Zeilen ohne Layout | – | 1,2 ms |
| Tail-Updates in 3 s bei 10k Zeilen/s | 29 | 29 |

Einlesen, Filter und Suche unverändert (Rauschen). Das Zerlegen kostet etwa 1,2 µs je Zeile (Regex mit Captures); eine Seite
zu 200 Zeilen bleibt unter 0,3 ms.

Erkennung der Dateien in `samples/` (Test `samples_matrix`): alle zwölf zu 100 % als ihr Format, kein anderes Profil erreicht 80 %.

## Fortschritt

- [x] `timestamp.rs` mit Tests (ISO, Slash, CLF, Syslog ohne Jahr, ctime, nur Uhrzeit mit Tageswechsel, JSON)
- [x] `fields.rs`: Regex-Layouts, JSON-, logfmt-, FIX-, W3C-Scanner, Inferenz, Bewertung, Vorschau
- [x] Layouts für alle eingebauten Profile, neue Profile `access`, `w3c`, `nlog`, `gc`, `fix`, `logfmt` mit Beispieldateien
- [x] Sitzung: Format beim ersten Block, `get_columns`, `fields` in `get_lines`, Profilwechsel mit Revision
- [x] Frontend: Modelle, `SessionState.columns`, Tooltip, Hinweis in der Statusleiste, Layouts und Vorschau in den Einstellungen
- [x] e2e: Spalten der Spring-Boot-Datei über `get_columns`, Felder der ersten Zeile
- [x] Doku

Prüfläufe: `npm run check` grün, `npm run e2e` grün mit 110 Schritten (neu: Format über `get_columns`, Felder der ersten
Zeile, Layout-Vorschau im Einstellungsdialog). Ein Lauf davor scheiterte einmal an „badge click follows again“ (Zeitverhalten
im Debug-Build, im nächsten Lauf grün); das Zerlegen macht `get_lines` im Debug-Build langsamer, das ist im Auge zu behalten.

Nicht automatisch geprüft (nur von Hand): Einstellungsdialog (Testfeld, „Erkanntes Format als eigenes Profil übernehmen“),
Tooltip und Hinweis in hell und dunkel.
