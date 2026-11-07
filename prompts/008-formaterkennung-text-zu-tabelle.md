# Prompt 008: Automatische Formaterkennung, Text zu Feldern

> Start in neuer Sitzung: „Führe `prompts/008-formaterkennung-text-zu-tabelle.md` aus.“
> Grundlage für 009 (Tabellen-Header), 010 (Feldfilter), 011 (Extraktion) und 012 (Dashboard). Dieser Prompt liefert nur Daten.
> Die Spalten zeichnet 009, bis dahin sieht die Log-Ansicht aus wie heute.
> Teilt `timestamp.rs` mit 006: Wer zuerst dran ist, legt es nach der Formatliste in 006, Phase 1, an.
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

Beim Öffnen erkennt die App das Format der Datei und zerlegt jede Zeile in Felder wie Zeit, Thread, Level, Logger und
Nachricht, ohne dass jemand ein Format definieren muss. Eine Datei, die nicht passt, bleibt eine Spalte „Nachricht“ und damit
so nutzbar wie heute.

## Entscheidungen

| Thema | Entscheidung | Warum |
|---|---|---|
| Wann zerlegt wird | Beim Ausliefern in `get_lines`, nicht beim Indexieren | Der Index bleibt bei 16 Byte je Zeile, der Text liegt bewusst nicht im Speicher. Eine Seite hat höchstens 5000 Zeilen (`session.rs:33`). |
| Form der Felder | Spannen `[start, end)` in UTF-16 über `LogLine.text`, keine Textkopien | Dieselbe Einheit wie `matches` (`model.rs:97`). IPC bleibt klein, und Treffer und Tokens aus `highlight.ts` lassen sich über Feldgrenzen hinweg schneiden. |
| Spalten | Je Sitzung fest aus der Stichprobe, neuer Stand nur bei Formatwechsel | Spalten, die im Tail auftauchen und verschwinden, würden das Layout zerreißen. Spätere JSON-Schlüssel bleiben im Detail-Panel lesbar. |
| Format-Definition | `Profile` erweitern, kein zweites Konzept | Eigene Profile, Vorschlag und Auswahl in der Toolbar gibt es schon. Eine eigene Regex mit benannten Gruppen ergibt von selbst Spalten. |

## Backend

1. **`fields.rs`**, frei von Tauri: `FieldParser` aus einem `Profile` und der Stichprobe. `parse(text) -> Vec<[u32; 2]>`, gleiche
   Reihenfolge wie die Spalten, leeres Feld als `[0, 0]`. Umrechnung Byte nach UTF-16 wie in `match_ranges` (`filter.rs:57`).
2. **`Profile`** (`profile.rs:20`) bekommt `layouts: Vec<String>`: Regexes über die ganze Zeile mit benannten Gruppen. Bekannte
   Namen: `timestamp`, `date`, `time`, `thread`, `level`, `logger`, `message`. Jeder andere Name wird eine eigene Spalte. `#[serde(default)]`,
   damit gespeicherte eigene Profile weiter laden. Die bisherigen `patterns` bleiben für die Level-Erkennung (`profile.rs:51`), sie
   laufen beim Indexieren und dürfen nicht langsamer werden.
3. **Eingebaute Layouts** für alle Profile in `builtin_profiles` (`profile.rs:91`): Log4j/Logback/Spring Boot, Python, Serilog, Syslog,
   nginx/Apache-Fehlerlog, JSON Lines. Neu aus der Roadmap: Common und Combined Log, W3C mit `#Fields:`-Kopf (deckt IIS ab).
   Neu außerdem: NLog (Standard-Layout `${longdate}|${level}|${logger}|${message}`), Java GC mit Unified Logging
   (`[…][info][gc] GC(12) Pause Young … 12.345ms`, Dauer als Zahl) und FIX (`tag=wert`, getrennt durch SOH `\x01`, in der Anzeige als
   `|`, bekannte Tags wie 35 = MsgType als Spaltennamen). Jedes neue Format braucht eine Datei in `samples/`.
4. **Eigene Parser ohne Regex** für zwei Fälle:
   - **JSON Lines:** Die obersten Schlüssel der Stichprobe werden Spalten, geordnet nach Häufigkeit, mit `timestamp`, `level` und `message`
     vorn (Aliasse wie in `detect_json`, `level.rs:236`). Höchstens 12 Spalten. Spanne über den Rohwert: Strings ohne Anführungszeichen,
     geschachtelte Werte als Roh-JSON. Escapes bleiben sichtbar, das Detail-Panel zeigt den Rest. Eigener Scanner, kein `serde_json` je
     Zeile, denn der kennt keine Spannen.
   - **logfmt und `key=value`:** gleiche Regeln.
5. **Unbekanntes Format (Inferenz):** Passt kein Layout zu mindestens 80 % der Stichprobe, ein reines `infer_layout` versuchen:
   Trennzeichen (Tab, `|`, `;`) mit gleicher Feldzahl auf 95 % der Zeilen, sonst von links Zeitstempel (`timestamp.rs`), Level-Wort,
   `[…]` als Thread, dann `name -` oder `name:` als Logger, Rest ist Nachricht. Das Ergebnis ist eine gewöhnliche Regex oder ein Trenner,
   prüfbar und in einen eigenen Profilvorschlag übernehmbar. Reicht es nicht: nur Spalte `message`.
6. **Bewertung:** `suggest_profile` (`profile.rs:146`) zählt heute Level-Treffer. Neu: `detect_format(sample) -> FormatGuess { profile_id, layout, confidence }`
   mit dem Anteil vollständig passender Zeilen. Fortsetzungszeilen zählen nicht mit, sonst drückt ein Stacktrace die Quote. Einzeln
   an eine Stichprobe von 200 Zeilen (`tail.rs:256`). Das Ergebnis wandert in die `SessionData`, gefunden in `start_file`
   (`tail.rs:249`), und `suggest_profile` bleibt für den Level-Vorschlag, sofern seine Tests das verlangen.
7. **DTOs und Befehl:** `LogLine.fields: Vec<[u32; 2]>`. Neuer Befehl `get_columns(session_id) -> ColumnSet { revision, confidence, columns: [{ id, label, kind }] }`, `kind` ist
   `timestamp | level | text | number`. `SessionUpdate.columns_revision`: ändert sich bei Formatwechsel, dann erhöht sich auch die
   `view_generation`, damit `PageCache` und damit alte Spannen verfallen. `mock-ipc.js` nachziehen.

## Fallen

- **Fortsetzungszeilen** bekommen keine Felder, nur `message` über die ganze Zeile, kein Layout-Versuch. `is_continuation` ist da.
- **`set_profile`** (`session.rs:336`) und das automatische Anwenden des Vorschlags (`apply_suggestion`) setzen auch das Layout.
  Hat der Nutzer ein Profil gewählt, gewinnt das (`profile_auto`), auch für das Layout.
- **Gekürzte Zeilen:** `text` endet bei 128 KB. Die letzte Spanne endet dann dort, kein Fehler und kein Absturz an einer Zeichengrenze.
- **Rotation:** Ein neues Segment kann ein anderes Format haben. V1 behält das Layout der Sitzung, die Zeilen fallen dann auf `message` zurück.
  Mit 006: Layout **je Quelle**, Spalten als Vereinigung über gleiche Namen. Ein gemeinsames `level` bleibt eine Spalte.
- **Geschwindigkeit:** `Regex::captures` ist teurer als der Level-Test. Je Seite messen, bei langer Zeile nur die ersten 16 KB zerlegen
  und den Rest ins letzte Feld legen. Das Layout läuft nicht bei Filter, Suche und Tail.
- **Bytes und Text:** Das Layout läuft über den dekodierten Text ohne ANSI (`display_text`, `encoding.rs:110`), nicht über Rohbytes. Sonst
  stimmen die Spannen bei UTF-16 und Farbcodes nicht.
- **Regex-Grenze:** Layouts eigener Profile sind Nutzereingaben. Prüfung in `Profile::detector` (`profile.rs:51`) um die Layouts ergänzen, Fehler wie bisher über `invalid`.

## Frontend

1. `LogLine.fields`, `ColumnSet`, `LogApi.getColumns`, `SessionState.columns` als Signal, neu geladen bei geänderter `columnsRevision`.
2. Statusleiste: „Log4j · 97 %“ als Tooltip am bestehenden Profil. Unter 80 %: Hinweis „Format nur teilweise erkannt“.
3. Einstellungen, Dialog der eigenen Profile (`settings-dialog.ts`): Feld für Layouts, Testfeld mit Beispielzeile und Vorschau der Felder.
   Zeigt die Fehlermeldung des Backends. „Als eigenes Profil übernehmen“ für eine Inferenz.

## Tests

- **Rust, rein:** Layouts je eingebautem Format mit `samples/` und Beispielzeilen. Umlaute und Emoji für UTF-16-Spannen. JSON mit Escapes,
  verschachtelt, Schlüsseln mit `"`, 20 Schlüsseln. logfmt mit Anführungszeichen. Inferenz: TSV, Pipe, Freitext, nichts Erkennbares.
  Bewertung: Datei mit vielen Stacktraces bleibt sicher. Kein Format täuscht ein anderes vor (Matrix über `samples/`).
- **Integration:** `get_lines` liefert Felder bei UTF-16, Rotation und Profilwechsel (Revision, Generation). Messung: `get_lines` über 5000 Zeilen mit
  und ohne Layout, Einlesen bei 500 MB nicht langsamer (`measure_`).
- **Vitest:** Laden der Spalten bei Revisionswechsel. **e2e:** Spalten für eine Datei aus `samples/` über `get_columns` geprüft.

## Nicht in diesem Prompt

Zeichnen der Spalten (009), eigene Felder aus der Nachricht (011), Filter auf Felder (010), Kopfzeile aus CSV als Spaltennamen.

## Fertig, wenn

- [ ] Tests oben grün, `npm run check` und `npm run e2e` grün
- [ ] Alle Dateien aus `samples/` richtig erkannt, Quote im Bericht
- [ ] Log-Ansicht unverändert, gekürzte, binäre und leere Dateien ohne Fehler
- [ ] `README.md`, `CLAUDE.md` (Entscheidungen, Layout `fields.rs`) und `docs/roadmap.md` ergänzt

Kein Commit ohne Rückfrage.
