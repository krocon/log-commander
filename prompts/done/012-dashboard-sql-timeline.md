# Prompt 012: Dashboard und SQL-Timeline-Berichte

> Start in neuer Sitzung: „Führe `prompts/012-dashboard-sql-timeline.md` aus.“
> Voraussetzung: `timestamp.rs` (006 oder 008). Ohne 011 gibt es nur Level, Quelle und Felder aus 008, die Aufgabe bleibt aber lösbar.
> Größter Eingriff in die Abhängigkeiten: **Phase 1 ist ein Spike mit Halt.**
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

Aus den Daten eines Logs entstehen Diagramme im Zeitverlauf: Fehler je Minute, CPU über die Zeit, Antwortzeit je Logger. Jeder Bericht ist eine
SQL-Abfrage in einem Dashboard. Ein Klick auf einen Punkt springt an die passende Stelle im Log.

## Entscheidungen

| Thema | Empfehlung, vom Spike zu bestätigen | Warum |
|---|---|---|
| SQL-Engine | SQLite über `rusqlite` mit `bundled` | Ist echtes SQL, kommt mit wenig Binärgröße, ohne Dienst. DuckDB wäre für Analysen schneller, ist aber deutlich größer. Im Spike vergleichen. Kein eigener SQL-Parser. |
| Speicher | Eigene temporäre Datenbankdatei je Sitzung im Cache-Verzeichnis der App | Der Index bleibt schlank, und der Text bleibt außerhalb des Speichers. Diese Daten braucht nur, wer ein Dashboard öffnet. |
| Inhalt | Tabelle `log(line, ts, level, source, <gewählte Felder>)`, ohne `message` | Die Nachricht würde die Datei fast so groß wie das Log machen. Felder nur, die eine Abfrage braucht, oder die der Nutzer angehakt hat. |
| Start | Aufbau erst beim ersten Öffnen eines Dashboards | Wer es nie öffnet, zahlt nichts. |
| Diagramme | `uPlot` als Paket, lokal gebündelt | Klein, schnell bei vielen Punkten, und die CSP (`script-src 'self'`) bleibt. Im Spike gegen ECharts abwägen. |

## Phase 1: Spike, dann anhalten 🛑

Auf einem Branch, mit 500 MB aus `scripts/gen-log.mjs`:

1. Binärgröße der App vorher und nachher, für `rusqlite` und zum Vergleich DuckDB. Bundle-Größe für das Diagramm.
2. Aufbauzeit, Dateigröße, Abfragezeit für `GROUP BY` je Minute. Tail-Nachzug bei 5000 Zeilen/s.
3. Wird die Log-Ansicht beim Aufbau langsamer, auch beim gleichzeitigen Filter?

Ergebnis ist `prompts/012-dashboard-sql-timeline.design.md` mit Messwerten, Empfehlung und den offenen Fragen. **Dann anhalten und entscheiden lassen.** Ein negatives Ergebnis, etwa nur eine feste Auswertung ohne SQL, ist ein gültiges Ergebnis.

## Phase 2: Datenbank (nur nach Freigabe)

1. **`report_db.rs`**, frei von Tauri. Aufbau als Hintergrund-Job wie `run_filter` (`session.rs:677`): Index in Stapeln (`JOB_BATCH`), Text nur, wenn Felder gebraucht werden, eigener `LineReader`, Sperren kurz, abbrechbar über Generation, Fortschritt in `SessionUpdate`. Transaktionen je Stapel, sonst dauert es ewig.
2. **Nur Köpfe.** Eine Zeile je Eintrag, sonst zählt ein Stacktrace 50-mal als Fehler. `line` ist die Zeile des Kopfes. Einträge ohne Zeit: `ts` NULL, sie zählen in Abfragen nur, wenn man will. Keine erfundenen Zeiten.
3. **Nachziehen:** Neue Zeilen im Tail erst alle 5 s und nur bei offenem Dashboard einspielen. `epoch` (`session.rs:107`) oder Layout- bzw. Regeländerung baut neu auf, mit Hinweis. Im Freeze ruht es.
4. **Hilfsfunktion** `bucket(ts, '1m')` als eigene SQL-Funktion, damit Berichte kurz bleiben. Zahlenwerte aus `parse_value` (011), fehlend ist NULL.
5. **Abfragen absichern:** Die SQL kommt vom Nutzer, kann aber auch aus einem geteilten Dashboard stammen. Eigene Verbindung, `PRAGMA query_only`, `stmt.readonly()` prüfen und ablehnen, `ATTACH` und `load_extension` über Authorizer und Build aus, Limit von 10.000 Zeilen, Zeitlimit von 10 s über Progress-Handler. Neuer Fehlercode `invalid_query`, Text der Engine zeigen.
6. **Befehl:** `run_report(session_id, sql) -> ReportResult { columns, rows, truncated, elapsedMs }`, über `blocking`. Überholte Abfragen abbrechen. `get_report_schema(session_id)` für die Hilfe im Editor.
7. **Aufräumen:** Beim Schließen der Sitzung löschen, beim Start alte Dateien entfernen, wenn die App abgestürzt ist. Dateien nur im eigenen Cache-Ordner.
8. **Platz:** Vor dem Aufbau schätzen und bei wenig freiem Speicher warnen. Volles Laufwerk ist ein Fehler im Dashboard, kein Absturz und kein Einfluss auf den Tail.

## Phase 3: Oberfläche (nur nach Freigabe)

1. **Ort:** Eigener Modus eines Tabs (Umschalter Log/Dashboard), die Log-Ansicht bleibt im Hintergrund aktiv. Komponente in `features/dashboard/`, Diagramm-Bibliothek per `import()` lazy, damit der Start nicht leidet.
2. **Panels:** Raster mit einstellbarer Größe. Je Panel: Titel, SQL, Diagrammart (Linie, Fläche, Säulen, gestapelte Balken, Kreis, Tabelle, Einzelwert). Erste Spalte `ts` oder `bucket` ist die Zeitachse. Weitere Zahlenspalten sind Reihen, Textspalten teilen in Serien. Kreis nur bis 8 Kategorien, der Rest kommt in „Sonstige“. Ohne Zeitachse (`GROUP BY logger`) Säulen statt Linie.
3. **Vorlagen zum Start**, ohne dass jemand SQL schreiben muss: Einträge je Level je Minute, Fehlerrate, je Quelle (006), je erkanntem Zahlenfeld Mittel und Maximum (011). Sichtbar als normales SQL und anpassbar. Das ist der Weg, wie SQL erlernbar bleibt.
4. **Editor:** einfaches `<textarea>` mit Schema-Hilfe und Ausführen über `Cmd/Ctrl+Enter`. Kein Monaco, das bläht das Bundle. Fehler direkt am Panel.
5. **Vom Punkt zur Zeile:** Klick auf einen Punkt oder Balken ermittelt den Zeitbereich und springt zur ersten Zeile über `min(line)` im Bereich. Filtert die Ansicht diese Zeile weg, Hinweis mit `G` aus 007, falls vorhanden. Auswahl bleibt unverändert. In Tabellen ist eine Zeile mit Spalte `line` klickbar, ein Säulenbalken ohne Zeitachse (`GROUP BY logger`) setzt einen Filter auf den Wert (010) oder öffnet ihn als Filter-Tab (013).
   SQL-Dialekt ist SQLite, nicht Transact-SQL. Die Hilfe nennt die üblichen Unterschiede (`LIMIT` statt `TOP`, `strftime`).
6. **Farben** aus Tokens in `styles.css`, Theme-Wechsel zeichnet neu. Level-Farben wie in der Ansicht, Serien aus einer neuen Palette, Prüfung mit `npm run contrast`. Legende immer sichtbar, Tooltip mit Werten, nicht nur Farbe.
7. **Speichern:** Dashboards je Profil in den Settings. Einzelne Dashboards größer als einige KB: eigene Datei über das Store-Plugin. Export und Teilen bleiben später.
8. **Live:** Aktualisierung höchstens alle 5 s, Pause bei unsichtbarem Tab, Schalter „Automatisch“. Eine laufende Abfrage wird nicht überholt.

## Fallen

- **Der Tail darf nie warten.** Aufbau und Abfragen laufen auf eigenen Threads und eigener Verbindung. `shared.data` wird nur kurz und nicht während eines SQLite-Aufrufs gehalten.
- **Filter:** Berichte zeigen standardmäßig die ganze Datei. Eine Option „nur gefilterte Ansicht“ würde die `filter`-Liste in die Datenbank kopieren: bewusst nicht in V1, in die Doku.
- **Zeitzone:** `ts` ist UTC, Anzeige lokal. Beim Sommerzeitwechsel keine Lücke und keine doppelte Stunde in `bucket`.
- **Punkte:** Über 5000 Punkte je Reihe: zuerst größere `bucket` vorschlagen, nicht still ausdünnen.
- **Merge (006):** `source` ist da, verspätete Zeilen stören nicht, weil nach `ts` gruppiert wird. `line` kann dann nicht mehr aufsteigend zu `ts` sein, `min(line)` also im Test prüfen.
- **CSP:** Das Dashboard rendert auf Canvas. Prüfen, dass die Bibliothek keine Inline-Skripte braucht. `tauri.conf.json` nicht aufweichen, sonst ist das eine Rückfrage.

## Tests

- **Rust, rein:** `bucket`, Absicherung (`DELETE`, `DROP`, `ATTACH`, `PRAGMA`, mehrere Anweisungen, Endlosschleife per rekursivem CTE läuft ins Zeitlimit), Limit.
- **Integration:** Aufbau gleich Werten aus `counts` (Summe je Level, nur Köpfe), Nachzug im Tail, Rotation, Truncation, Freeze, Sitzung schließen löscht die Datei, Abbruch beim Schließen. Messung: `measure_report` als `--ignored`.
- **Vitest:** Abbildung Ergebnis auf Reihen (Zeitachse, Serien aus Textspalte, NULL, keine Zeile), Klick auf Zeitbereich.
- **e2e:** Vorlage „Einträge je Level“ für `samples/`, Zahlen sind richtig, eigene SQL mit Fehlertext, Klick springt zur Zeile, Log läuft währenddessen weiter. Diagrammbild nicht pixelweise, Daten über Attribute.

## Nicht in diesem Prompt

Teilen und Export, PDF, Alarme aus Abfragen (Roadmap „Alarme“), Abfragen über mehrere Tabs (dafür gibt es Merge), Nachricht als durchsuchbare Spalte.

## Fertig, wenn

- [ ] Design-Datei freigegeben
- [ ] Tests oben grün, `npm run check`, `npm run contrast` und `npm run e2e` grün
- [ ] Ohne geöffnetes Dashboard: keine Datei, kein Thread, kein Unterschied bei Start und Speicher
- [ ] 500 MB: Werte im Bericht, Tail und Scrollen beim Aufbau messbar unverändert
- [ ] Keine Schreibanweisung kommt durch, belegt durch Tests
- [ ] Screenshots, `README.md`, `CLAUDE.md` (Entscheidungen, Layout), `docs/roadmap.md` ergänzt, Abhängigkeiten im Bericht
- [ ] Sichttest, sonst im Bericht als offen genannt

Kein Commit ohne Rückfrage.
