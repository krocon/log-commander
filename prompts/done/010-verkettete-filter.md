# Prompt 010: Verkettete Filter mit UND und ODER

> Start in neuer Sitzung: „Führe `prompts/010-verkettete-filter.md` aus.“
> Voraussetzung: 005 (Baum). Bedingungen auf Feldern brauchen 008, Zeit braucht `timestamp.rs` (006 oder 008). Fehlt etwas, die Bedingung weglassen und im Bericht nennen.
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

Filter lassen sich im Baum verschachteln und mit UND oder ODER verknüpfen, um genau die Zeilen einer Sitzung zu isolieren:
eine Request-ID suchen, auf den Abschnitt zwischen Start- und Endmarke eingrenzen, darin nur WARN und schlimmer zeigen.

## Entscheidungen

| Thema | Entscheidung | Warum |
|---|---|---|
| Auswertung | Ein Ausdruck, kompiliert zu **einer** gefilterten Liste. Kein Listen-Stapel je Knoten | Kind unter Eltern ist logisch UND. Speicher bleibt bei `Vec<u32>`, inkrementeller Tail und Hintergrund-Job bleiben, und die Ansicht hat weiter ein Positionsmodell. |
| Granularität | Bedingungen gelten für den **Eintrag**, nicht die Zeile | Schon heute bringt ein Treffer im Stacktrace den ganzen Eintrag (`filter.rs:254`). `"Timeout" UND "OrderService"` soll treffen, auch wenn eins im Kopf und eins im Stacktrace steht. |
| Vorhandene Bedienung | Level-Chips und Suche bleiben. Sie sind implizite UND-Glieder über dem Baum | Keine zweite Filterwelt, und das Einfache bleibt einfach. |
| Eingabe | Baum und Formular, keine Query-Sprache | `level:ERROR AND …` aus der Roadmap kann später auf denselben Ausdruck aufsetzen. |

## Backend

1. **`filter_expr.rs`**, frei von Tauri:
   ```
   FilterExpr = Group { op: And | Or, negate, children } | Cond { negate, cond }
   Cond = Text { text, is_regex, case_sensitive }
        | Level { levels }
        | Field { column, op, value }           // =, enthält, Regex, >, <, zwischen, Zahl wenn kind = number
        | Time { from, to }
        | Range { start: TextPattern, end: Option<TextPattern>, inclusive }   // Abschnitt zwischen Marken
        | Lines { first, last }                 // „ab hier“ aus der Auswahl
   ```
   Serde für IPC, `compile() -> AppResult<CompiledExpr>`, höchstens 64 Blätter (Bitmaske). Fehler nennen den Knoten (`node_id`), `invalid_search` bleibt der Code.
2. **`FilterSpec`** (`filter.rs:100`) bekommt `expr: Option<Arc<CompiledExpr>>`, `is_identity` und `needs_text` prüfen es, `set_filter` nimmt es entgegen.
3. **Auswertung je Eintrag in `append`** (`filter.rs:227`): Pro Eintrag eine Maske der bisher erfüllten Blätter, jede Zeile ergänzt sie (ODER), danach wird der Ausdruck mit der Maske ausgewertet. Text-Blätter gemeinsam über `RegexSet`, damit 20 Blätter nicht 20 Läufe kosten. Text wird nur gelesen, wenn das Ergebnis noch offen ist.
4. **Verneinung ist die Falle:** `NICHT "x"` kann ein Eintrag erfüllen und in einer Fortsetzungszeile wieder verlieren. Ein bereits aufgenommener Eintrag muss dann aus dem Ende der Liste heraus: `list.truncate` bis zur Position von `entry_start` (die liegt am Ende, da die Liste geordnet ist). `filtered_lines` kann also um wenige Zeilen sinken. Das prüfen: `invalidateTail` und `nextDisplayedLines` (`displayed-lines.ts`) bei kleinerem Ziel, auch im Follow.
5. **`FilterCheckpoint`** (`filter.rs:146`) um Blattmaske und Range-Zustand ergänzen, sonst stimmt der Rückzug der provisorischen Zeile nicht. Auch `entry_included` allein reicht nicht mehr.
6. **Range ist zustandsbehaftet:** Start-Muster öffnet, End-Muster schließt, wiederholt möglich, Auswertung streng in Zeilenfolge. Im ODER darf es nicht durch Kurzschluss ausgelassen werden: Zustände immer zuerst fortschreiben, dann auswerten. Offener Abschnitt am Dateiende bleibt im Tail offen. Bei 006 läuft das über die gemischte Reihenfolge, so ist es dort gewollt.
7. **Vor der Sperre lesen:** `ingest` (`tail.rs:282`) bereitet heute einen `matched`-Wert vor, und `same_matcher` (`tail.rs:308`) vergleicht den Matcher über `Arc::ptr_eq`. Das wird zu einer vorbereiteten Blattmaske und einem Vergleich des kompilierten Ausdrucks. `run_filter` und `feed` (`session.rs:772`) analog. Der Fall „Filter wechselt während des Stapels“ muss wie bisher halten.
8. **Felder und Zeit:** Field-Blätter lassen Layouts aus 008 laufen, das kostet. Nur bei Bedarf und nur für Einträge, deren Rest offen ist. Ausdruck so sortieren, dass Level und `Lines` vorn prüfen. Time: Zeitstempel aus dem Kopf, Fortsetzungszeilen erben.
9. **Suche** bleibt getrennt: `find` und `scan` (`session.rs:394`, `:438`) bewegen sich in der gefilterten Ansicht, keine Änderung nötig.

## Frontend

1. **Modell:** `SessionState.filterTree` (Signal), Knoten mit stabiler `id`, `enabled`, `label`. Reines `filter-tree.ts` mit Spec: hinzufügen, entfernen, verschieben, deaktivieren, zu `FilterExpr` kompilieren. Deaktivierte Knoten und leere Gruppen fallen weg.
2. **Baum aus 005:** Unter „Aktiver Filter“ die Knoten mit Häkchen (an/aus), Gruppen mit Umschalter UND/ODER, `×`, „Bedingung hinzufügen“, „Gruppe hinzufügen“. Kind wird eingerückt, und die Verknüpfung steht als Text dazwischen, damit sie nicht nur an einem Symbol hängt. Reihenfolge per Tastatur (`Alt+↑/↓`) und Ziehen.
3. **Formular** für Bedingungen im Baum oder als kleiner Dialog: Art, Spalte (aus `session.columns`), Operator, Wert. Sofortprüfung über Debounce, Fehler am Knoten aus `node_id`.
4. **Schnellwege**, sie sind der eigentliche Nutzen:
   - Text in der Zeile markieren, Rechtsklick „Filtern auf …“ oder Kürzel `I`. Eine Request-ID ist damit zwei Klicks entfernt.
   - Auswahl: „Abschnitt ab hier“ und „Abschnitt bis hier“ (`Lines`).
   - Mit 009: „Filtern nach diesem Wert“ im Kontextmenü von Zelle oder Spaltenkopf.
5. **Gespeicherte Filter** (005): `savedFilters` speichert den Baum. Einträge ohne `tree` aus 005 beim Laden umsetzen, Version im Eintrag, kein Verlust.
6. **`applyFilter`** (`log-session.service.ts:119`) sendet den Ausdruck in einem Aufruf. Mehrere Änderungen in Folge bündeln, jede startet sonst einen Filter-Job. Laufende Jobs bricht `generation` schon ab.
7. **Teil-Ergebnis** in der Statusleiste: „3 Bedingungen · 1.204 von 2,1 Mio. Zeilen“, vorhandene Anzeige ausbauen.
8. **Mit 007:** `G` hebt auch den Baum auf und stellt ihn wieder her. Ist 007 da, dort zusammenführen.

## Tests

- **Rust, rein** (`filter_expr.rs`, `filter.rs`): Tabelle für UND, ODER, NICHT, verschachtelt. Teilbedingungen auf Kopf und Stacktrace. NICHT mit spätem Treffer (Rücknahme aus der Liste). Range geöffnet, geschlossen, wieder geöffnet, ohne Ende, im ODER. Rückzug der provisorischen Zeile für jede Art. 64 Blätter, 65 mit Fehler.
- **Integration:** Inkrementell gleich Ergebnis des Hintergrund-Jobs: gleiche Eingabe, Liste identisch (am besten mit vielen erzeugten Ausdrücken). Filterwechsel während `ingest`. Tail mit `filtered_lines`, das sinkt. Rotation, Truncation, Freeze. Messung: Filter mit 1, 5 und 20 Text-Blättern auf 500 MB gegen heutigen Wert.
- **Vitest:** `filter-tree`, Umsetzung gespeicherter Filter. `nextDisplayedLines` bei sinkendem Ziel.
- **e2e:** Request-ID per Markierung filtern, UND und ODER wechseln, Häkchen aus, Abschnitt über Start- und Endmuster, Fehlertext am Knoten.

## Nicht in diesem Prompt

Query-Sprache, je Thread gefilterte Sitzungsbäume, Filter-Vorlagen teilen, Trace-ID-Isolation über Dateien hinweg (das ergibt sich aber aus 006 und diesem Prompt).

## Fertig, wenn

- [ ] Tests oben grün, `npm run check`, `npm run contrast` und `npm run e2e` grün
- [ ] Eingabe ohne Baum: exakt das Verhalten und die Leistung von heute (`measure_`)
- [ ] Inkrementeller Weg und Job liefern dieselben Zeilen, durch Test belegt
- [ ] `README.md`, `CLAUDE.md` (Entscheidung, Grenze 64 Blätter), `docs/roadmap.md` ergänzt
- [ ] Sichttest mit `npm run demo:log` und `npm run demo:app`, sonst im Bericht als offen genannt

Kein Commit ohne Rückfrage.
