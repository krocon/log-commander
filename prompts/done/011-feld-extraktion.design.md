# 011 Feld-Extraktion: Design und Stand

Status: umgesetzt, nicht committet · Datum: 2026-11-07 · Branch `feat/feld-extraktion`

Marc hat die Prompts zur selbständigen Abarbeitung freigegeben; wo 000 oder der Prompt „anhalten und fragen“ sagt, ist
hier die Entscheidung mit Optionen und Grund festgehalten.

## Abweichungen vom Stand des Prompts

- Die alte eigene Ansicht (`log-view.ts`, `.row`) gibt es nicht mehr: „Spalte aus Auswahl“ hängt am Kontextmenü der
  GuiExpert Table (`row-menu.ts`, `log-table-view.ts`), die Ausrichtung an `LogAreaModel` (Klasse `lt-num`).
- 012 (Dashboard) ist noch nicht umgesetzt: „Auswertung auf 012“ fehlt. Anknüpfung: `FieldParser::field` liefert den
  Wert eines extrahierten Felds, `extract::parse_value` die Zahl; ein Berichts-Job kann beides wie `run_filter` nutzen.
- Prompt 021 (Aktionskatalog) ist nicht umgesetzt; es gibt kein neues Kürzel (Dialog über Toolbar, Statusleiste,
  Kontextmenü).

## Verträge

- `ExtractRule { id, name, column, pattern, kind: text|number|percent|duration|size, unit }` (`extract.rs`,
  `log.models.ts`). Name = Spalten-Id.
- Commands: `set_extract_rules(sessionId, rules) -> ColumnSet` (prüft, speichert für das Profil des Formats, wirkt auf
  alle offenen Sitzungen des Profils), `load_extract_rules(rules: Record<profileId, ExtractRule[]>)` beim Start,
  `suggest_fields(sessionId) -> FieldSuggestion[]` (`{ rule, examples, share, distinct }`, blocking),
  `preview_extract_rule(rule, lines) -> { spans, values }` (Prüfung und Vorschau im Dialog, höchstens 5000 Zeilen).
- `Column` bekommt `unit?`, `rule?`; `ColumnKind` zusätzlich `percent | duration | size`.
- Fehlercode `invalid_rule` mit `nodeId` = Regel-Id (wie 010 am Knoten).
- Settings: `extractRules: Record<profileId, ExtractRule[]>`, `fieldHints: string[]` (Profile, für die der Hinweis
  schon kam); `mergeExtractRules` repariert.
- `mock-ipc.js`: alle vier Commands (vereinfacht, JS-Regex).

## Entscheidungen

| Frage | Optionen | Entscheidung | Grund |
|---|---|---|---|
| Ablage der Regeln im Backend | im `Profile`; getrennt | getrennt: `RuleBook` (Profil-Id → Regeln), geteilt über `OpenOptions.rules` | Gilt auch für eingebaute Profile und `generic` (inferierte Layouts); kein Umbau von `ProfileRegistry` |
| Wo wirken Regeln | eigene Spalten-Schicht; im `FieldParser` | `FieldParser::with_rules`: Spalten hinter denen des Formats, `parse`/`field` liefern sie | Ein Weg für `get_lines`, Feld-Bedingungen (010) und künftige Jobs (012); `cellSegments` und `get_columns` unverändert |
| Wann anwenden | an jeder Stelle, die ein Format setzt; zentral | `SessionData::set_format` und `with_rules` für `requested_format` und Merge | Tail, Profilwechsel und Merge vergessen die Regeln nicht |
| Wirkung auf andere Tabs | nur diese Sitzung; alle des Profils | alle Sitzungen mit gleichem `format.profile_id` (`refresh_rules`, neue Revision und View-Generation) | Prompt: „schon gültig für andere Sitzungen desselben Profils“ |
| Kollision mit Spalten | umbenennen; Fehler | Fehler `invalid_rule` an der Regel; in einer anderen Datei desselben Profils (andere JSON-Schlüssel) fehlt die Regel still | Prompt verbietet stilles Umbenennen; Fehler bei Dateien, die man gerade nicht bearbeitet, wäre nicht zuordenbar |
| Quellspalte fehlt im Format | Fehler; leer | leer | Andere Dateien des Profils können sie haben |
| Prefilter | immer `RegexSet`; ab N Regeln | ab 5 Regeln je Quellspalte | Bei wenigen Regeln ist ein Set teurer als die Regexe; gemessen siehe unten |
| `,`/`.` | raten; nur eindeutig | `.` allein ist Dezimal, `,` allein nur ohne genau drei Ziffern dahinter, beide: der letzte ist Dezimal, Leerzeichen/`'` als Tausender nur in Dreiergruppen | „nur eindeutig“; `1.234s` ist in Logs fast immer eine Sekunde |
| KB | 1000; 1024 | 1024 für KB und KiB | JVM, Linux-Werkzeuge; SI-Unterscheidung wäre Scheinpräzision |
| Prozent | 0–1; Wert | Wert (`72.3`) | `CPU > 70` wie im Prompt |
| Dauer ohne Einheit | Sekunden annehmen; fehlt | fehlt, außer die Regel hat `unit` | eindeutig |
| Einheit im Wert | nur Zahl in der Gruppe; Zahl + Einheit | Vorschläge nehmen die Einheit in die Gruppe (alle Einheiten der Art), `unit` = häufigste für Werte ohne | `340ms` und `1.2s` in einer Spalte vergleichbar |
| Feld-Bedingungen | alte `parse_number`; `parse_value` | `parse_value` mit Art und Einheit der Spalte, auch die Eingabe (`500 ms`) | Prompt; Folge: `1,234` in einer Zahlenspalte ist kein Wert mehr |
| Vorschläge: IDs | nur Namen; Verteilung | Namen (`id`, `pid`, `port`, `…Id`, Zeitwörter) und Ganzzahlen ohne Einheit, die zu ≥ 95 % verschieden sind oder ≥ 9 Stellen haben | Test „verwirft IDs“ |
| Vorlagen | Nachricht normalisieren und je Vorlage zählen; je Name | Schlüssel = Name + Schreibweise (`name=`/`wort wert einheit`) | Gleiche Namen aus verschiedenen Vorlagen fallen damit zusammen; eine eigene Vorlagen-Tabelle brachte im Test nichts |
| Stichprobe | Anfang; verteilt | `SUGGEST_SAMPLE` Positionen gleichmäßig, je nächster Kopf | Prompt; Test mit Messwerten nur in der zweiten Hälfte |
| Hinweis | einmal je Profil beim Laufen; beim Zeigen | Profil wird gemerkt, wenn ein Hinweis gezeigt wurde | Ein Format ohne Fundstellen soll später (andere Datei) noch Vorschläge bekommen |
| Speichern im Dialog | sammeln + Speichern; sofort | Übernehmen, Anlegen und Löschen speichern sofort; Bearbeiten über „Änderungen speichern“ | Jede Aktion wirkt sichtbar; Fehler bleiben an der Regel |
| „Spalte aus Auswahl“ | eigenes Menü; Dialog | Kontextmenü öffnet den Dialog mit Zeile und Markierung, Vorschau, „Als Spalte anlegen“ = Bestätigung | Prompt „vor dem Anlegen bestätigen“; derselbe Weg geht per Formular (e2e) |
| Quellspalte aus Markierung | immer `message`; Spalte der Markierung | Zelle unter dem Zeiger, sonst `message`, sonst die Spalte, in der die Markierung liegt | Werte im Thread oder Logger gehen auch |
| Ausrichtung | nur extrahierte; alle Zahlen | alle Zahlenspalten rechtsbündig mit `tabular-nums`, außer der letzten (Füllspalte), sonst würde der Wert am Rand abgeschnitten | „Zahlen rechtsbündig, kein eigener Code in der Zeile“ |
| Farben | neue Tokens | keine (`--danger`, `--accent`, `--text-dim`) | `npm run contrast` unverändert |

## Messwerte

`measure_` (Release, Apple Silicon, 500 MB, 5,1 Mio. Zeilen):

| | vorher | nachher |
|---|---|---|
| erste Zeilen | 24,0 ms | 23,9 ms |
| indexiert | 2,14 s | 2,15 s |
| Level-Filter | 30 ms | 27 ms |
| Suchfilter | 728 ms | 739 ms |
| Baum 1 / 5 / 20 Text-Blätter | 773 / 799 / 925 ms | 772 / 805 / 966 ms |
| `get_lines` 200 zufällig | 289 µs | 288 µs |
| `get_lines` 5000 mit / ohne Layout | 7,00 / 1,22 ms | 7,06 / 1,22 ms |
| Tail-Updates in 3 s bei 10k Zeilen/s | 27 | 28 |

`extract_integration measure_get_lines_with_rules` (5000 Zeilen je Aufruf, Spring-Layout, `message` als Quelle):
0 Regeln 7,8 ms, 4 Regeln (alle treffen) 11,8 ms, 16 Regeln (4 treffen, 12 nicht; mit `RegexSet`) 12,8 ms.
Einlesen und Tail laufen ohne Regeln, unverändert (Rauschen).

## Fortschritt

- [x] `extract.rs`: Regeln, Prüfung, `RuleBook`, `Extractors` (mit `RegexSet`), `parse_value`, `suggest`, `preview`
- [x] `fields.rs`: `with_rules`, Spalten hinten, `parse`/`field` mit extrahierten Spannen, keine für Fortsetzungen
- [x] Sitzung/Manager: `set_extract_rules`, `refresh_rules`, `load_extract_rules`, `suggest_fields`; Commands
- [x] Feld-Bedingungen mit `parse_value` und Einheiten (`took > 500 ms`)
- [x] Rust-Tests: `parse_value` als Tabelle, Prüfung (ohne Gruppe, kaputt, Kollision, 33 Regeln), Prefilter,
  Vorschläge (cpu/took/mem, keine IDs/Zeiten/Konstanten), Integration (Spalte, Spannen mit Umlauten und Emoji,
  Revision, Fortsetzung, Tail, andere Sitzungen, Laden, Stichprobe über die ganze Datei, `samples/metrics.log`)
- [x] Frontend: Modelle, Settings mit Merge, `rule-from-selection.ts`, `fields-logic.ts`, Dialog, Hinweis,
  Toolbar „ƒ Felder“, Kontextmenü, `lt-num`; Specs inkl. überlappender Spannen in `cellSegments`
- [x] `gen-log.mjs --metrics`, `samples/metrics.log`, `mock-ipc.js`, Screenshots `fields.png`, `extracted.png`
- [x] e2e: Hinweis, Vorschläge annehmen, Wert in der Spalte (rechtsbündig), Regel löschen, Regel aus Markierung per
  Formular, Regex ohne Gruppe wird abgelehnt
- [x] Doku: README, CLAUDE.md, architecture, roadmap
- [x] Prüfläufe: `npm run check` grün (Vitest 210, Rust 120 + 63 Integration, Kontrast unverändert 29/56 Paare),
  `npm run e2e` grün mit 272 Schritten (erster Lauf scheiterte an einem doppelten Bezeichner im Szenario, zweiter an
  der Erwartung `16.5` statt `16.5%`: Vorschläge nehmen die Einheit in die Gruppe)
- [ ] Sichttest von Hand (`npm run demo:log -- --metrics` bzw. `node scripts/gen-log.mjs /tmp/app.log --rate 5000 --metrics`), hell/dunkel, schmales Fenster
- [ ] „Spalte aus Auswahl“ mit echter Mausmarkierung und Rechtsklick (e2e nimmt den Formular-Weg)
- [ ] Neustart: Regeln bleiben (nur über `mergeSettings`-Spec und `load_extract_rules`-Test geprüft)
