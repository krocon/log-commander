# Prompt 011: Felder aus der Nachricht extrahieren

> Start in neuer Sitzung: „Führe `prompts/011-feld-extraktion.md` aus.“
> Voraussetzung: 008 (Felder, Spalten), 009 (Spaltenansicht). Filter auf Felder setzt auf 010 auf, Auswertung auf 012.
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

Stecken Messwerte im Text, etwa `cpu=72.3% mem=1.2GB took 340ms`, werden daraus eigene Spalten, ohne die Datei zu ändern. Die App
schlägt solche Felder selbst vor, und der Nutzer kann sie aus einer Markierung oder per Regex anlegen.

## Entscheidungen

| Thema | Entscheidung | Warum |
|---|---|---|
| Automatisch | **Vorschlagen und annehmen**, nicht still Spalten anlegen | Eine Heuristik findet auch Unsinn wie `id=7`. Spalten, die sich von selbst ändern, widersprechen dem festen Spaltensatz aus 008. Ein Hinweis mit einem Klick ist fast genauso schnell. |
| Ablage | Wie die Felder aus 008: Spannen in `get_lines`, nichts im Index | Eine Regex je sichtbare Zeile ist billig, eine neue Index-Spalte je Feld nicht. |
| Geltung | Regeln je Profil in den Settings | Sie beschreiben ein Format. Beim nächsten Öffnen derselben Art sind sie wieder da. |
| Typ | Text, Zahl, Prozent, Dauer, Größe. Einheiten werden für Vergleiche umgerechnet | `340ms` und `1.2s` müssen vergleichbar sein, sonst nützen `> 500 ms` und Diagramme nichts. |

Regeln kennen Quelle: **eine Spalte** (Standard `message`), Regex mit **einer** Gruppe je Feld, erster Treffer je Zeile.

## Backend

1. `ExtractRule { id, name, column, pattern, kind, unit }` in `Profile` oder getrennt daneben, Settings wie eigene Profile über `set_custom_profiles` nachempfunden. Eigener Befehl `set_extract_rules(session_id, rules)`, schon gültig für andere Sitzungen desselben Profils.
2. `fields.rs` aus 008: Nach dem Layout laufen die Regeln über die Spanne der Quellspalte, Treffer werden Spannen an `fields` gehängt. Neue Spalten in `ColumnSet`, `kind` passend, neue `columns_revision`, dadurch Neuladen.
3. **Wert aus Spanne:** `parse_value(text, kind, unit) -> Option<f64>` als reine Funktion, für Größen und Dauer in Basiseinheit (Bytes, Sekunden). `,` und `.` als Dezimaltrenner nur eindeutig: `1,234` ist unklar, wird als fehlend gewertet, nicht geraten.
4. **`suggest_fields(session_id) -> Vec<FieldSuggestion>`:** Stichprobe aus bis zu 2000 Köpfen, gleichmäßig über die Datei verteilt, nicht nur der Anfang, ausgeführt als `blocking`.
   - Muster: `name=wert`, `name: wert`, `wert einheit` nach Text wie `took 340ms`, `CPU 72%`. Nachricht normalisieren (Zahlen raus), gleiche Vorlagen zusammenfassen, Name aus dem umgebenden Wort.
   - Reihenfolge nach Häufigkeit und Streuung. Felder mit nur einem Wert oder unter 5 % Vorkommen fallen weg. UUIDs, Hex und Zeitstempel sind keine Messwerte.
   - Ergebnis ist eine fertige `ExtractRule` samt Beispielen und Anteil. Höchstens 10.
5. **Keine Änderung beim Indexieren.** Regeln laufen bei `get_lines`. Bei Filtern (010) und Berichten (012) laufen sie im Hintergrund-Job.

## Frontend

1. **Hinweis:** Beim Öffnen läuft `suggest_fields` im Hintergrund, nur wenn es noch keine Regeln gibt und nur einmal je Profil. Unauffällige Meldung in der Statusleiste: „4 Felder erkannt“. Nie als Dialog, der Tail läuft.
2. **Dialog „Felder“:** Vorschläge mit Häkchen, Beispielwerten, Anteil. Name und Typ sind änderbar. Vorhandene Regeln bearbeiten und löschen. Reine Logik als Funktionen mit Spec, Regex-Prüfung durch das Backend.
3. **Aus Markierung:** Text in einer Zeile markieren, Kontextmenü „Spalte aus Auswahl“. Aus dem Umfeld wird eine Regex gebaut (reine Funktion `rule-from-selection.ts`, zum Beispiel `cpu=([\d.]+)%`), die Vorschau zeigt Treffer in den geladenen Zeilen. Vor dem Anlegen bestätigen.
4. **Spalten:** Über `columns` aus 008 erscheinen sie automatisch. Zahlen rechtsbündig mit `tabular-nums`, kein eigener Code in der Zeile. Layouts nach `profile_id` (009): neue Spalten hinten.
5. **Hervorhebung:** Das extrahierte Stück bleibt auch in der Nachricht stehen, Spannen dürfen sich überlappen. `cellSegments` muss das tragen.
6. **Mit 010:** Blatt `Field` kennt Vergleiche auf Zahlen, wie `CPU > 70`, inklusive Einheit. `Field`-Zahlenwerte kommen aus `parse_value`.

## Fallen

- Regeln sind Nutzereingaben. Prüfen beim Speichern, Fehler am Eintrag. Rust-Regex läuft in linearer Zeit, trotzdem bei einer Zeile nur die ersten 16 KB auswerten (Grenze aus 008).
- Eine Regel ohne Treffer auf einer Zeile ergibt `[0, 0]`, nicht „0“. Bei Zahlen ist das „fehlt“ und zählt nicht in Statistiken.
- Spaltennamen kollidieren mit Layout-Spalten oder JSON-Schlüsseln: Dialog verhindert das, im Backend Fehler. Keine stille Umbenennung.
- Fortsetzungszeilen: keine Extraktion.
- Mehr als 16 Regeln verlangsamen `get_lines`: `RegexSet` als Vorfilter, Messung bei 5000 Zeilen. Harte Grenze 32, im Dialog gemeldet.
- `mock-ipc.js` nachziehen, damit die Screenshots stimmen.

## Tests

- **Rust, rein:** `parse_value` als Tabelle (`340ms`, `1.2s`, `1h`, `72.3%`, `1.2GB`, `1 024`, `1,234`, `-3`, leer). Vorschläge für künstliche Logs: findet `cpu`, `took`, verwirft IDs, Zeitstempel und Konstanten. Regel ohne Gruppe oder mit kaputter Regex ergibt Fehler.
- **Integration:** Spalte erscheint, Spannen stimmen, Revision steigt, Umlaute und Emoji. Messung `get_lines` mit 0, 4, 16 Regeln.
- **Vitest:** `rule-from-selection` (Sonderzeichen, Anfang und Ende der Zeile, Zahlen und Text). Überlappende Spannen in `cellSegments`.
- **e2e:** Vorschlag annehmen, Spalte zeigt den Wert, Regel löschen. Regel aus Markierung per Formular-Weg. `scripts/gen-log.mjs` muss dafür Messwerte schreiben, Option ergänzen.

## Nicht in diesem Prompt

Mehrere Treffer je Zeile als Liste, abgeleitete Spalten (Formeln), Felder aus Fortsetzungszeilen, Anlegen über den Stacktrace.

## Fertig, wenn

- [ ] Tests oben grün, `npm run check`, `npm run contrast` und `npm run e2e` grün
- [ ] Log mit `cpu=` und `took …ms`: Felder werden vorgeschlagen, Annahme wirkt ohne Neuladen der Datei, Regeln überleben den Neustart
- [ ] Einlesen und Tail nicht langsamer (`measure_`)
- [ ] `README.md`, `CLAUDE.md`, `docs/roadmap.md` (Feld-Extraktion) ergänzt
- [ ] Sichttest, sonst im Bericht als offen genannt

Kein Commit ohne Rückfrage.
