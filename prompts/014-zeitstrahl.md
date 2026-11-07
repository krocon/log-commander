# Prompt 014: Zeitstrahl über dem Log

> Start in neuer Sitzung: „Führe `prompts/014-zeitstrahl.md` aus.“
> Voraussetzung: `timestamp.rs` (006 oder 008). Nutzt die Zusammenfassung aus 007, falls vorhanden. Zeitfilter braucht 010.
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

Ein schmaler Streifen über der Log-Ansicht zeigt die Ereignisse über die **Zeit**, gestapelt nach Level. Spitzen, Lücken (Ausfälle) und
Fehlerhäufungen fallen sofort auf. Ein Klick springt zur Zeit, Ziehen wählt ein Zeitfenster als Filter.

Abgrenzung zu 007: Der Ruler bildet Positionen ab, eine Stunde Stille ist dort unsichtbar. Der Zeitstrahl macht genau sie sichtbar.

## Entscheidungen

| Thema | Entscheidung | Warum |
|---|---|---|
| Daten | Laufende Zusammenfassung **je Abschnitt von Zeilen**: erste und letzte Zeit, Zähler je Level | Nur der erste Kopf je Abschnitt wird nach Zeit geparst, das kostet beim Einlesen fast nichts. Kein Scan je Abfrage, keine Datenbank wie in 012. |
| Genauigkeit | Verteilung innerhalb eines Abschnitts linear angenommen | Bei Abschnitten von wenigen hundert Zeilen ist das unterhalb eines Pixels. Für exakte Zahlen gibt es 012. Im Tooltip mit „≈“ kennzeichnen. |
| Achse | Ganze Datei, mit Zoom (Mausrad, Ziehen), „Ganze Datei“ setzt zurück | Spitzen sind erst beim Zoom lesbar. |
| Filter | Zeigt **alle** Zeilen. Optional „nur Ansicht“, wenn die Zusammenfassung der Filterliste aus 007 Zeiten trägt | Der Zeitstrahl soll Kontext geben, gerade wenn gefiltert ist. |

## Backend

1. `TimeSummary` neben `LevelSummary` aus 007 (oder neu in `overview.rs`): Abschnitte zu 256 Zeilen, verdichtet wie dort, je Abschnitt `first_ts`,
   `last_ts`, Zähler WARN, ERROR, FATAL und alle. Zeit wird beim Indexieren für den ersten **und** den letzten Kopf mit Zeit des Abschnitts gelesen. Der
   letzte erst, wenn der Abschnitt schließt, also einmal je 256 Zeilen. Fehlt die Zeit, bleibt der Abschnitt ohne und erbt im Diagramm vom Nachbarn.
2. Gepflegt in `ingest` beim `index.push`. Verdichten, `pop` der provisorischen Zeile, `reset_index`, `run_relevel` wie bei der Zusammenfassung in 007.
3. `get_timeline(session_id, from, to, buckets) -> Timeline { from, to, buckets: [{ all, warn, error, fatal }], gaps }`. Eimer aus den Abschnitten
   anteilig füllen. Abschnitte mit `last_ts < first_ts` (ungeordnete Datei) nicht verteilen, sondern dem Eimer von `first_ts` zuschlagen.
4. `position_at_time(session_id, ts) -> u32` für den Sprung: Abschnitt per Suche, dann exakt in den Köpfen des Abschnitts.
5. Bei 006: Der Merge-Index ist nach Zeit geordnet, das passt. Verspätete Zeilen landen am Ende, aber in ihrem Zeit-Eimer: Das ist gewollt.

## Frontend

1. Komponente `features/timeline/timeline.ts` zwischen Toolbar und Log-Ansicht, 56 px hoch, ein- und ausblendbar (Toolbar, Kürzel `Z`, Setting).
   Canvas wie in 007, Farben aus Tokens, Theme-Wechsel zeichnet neu.
2. Gestapelte Säulen je Eimer (alle in neutral, darüber WARN, ERROR, FATAL). Lücken ohne Zeilen bleiben sichtbar leer, ab dem Zehnfachen des
   Eimer-Medians zusätzlich schraffiert und mit Tooltip „keine Einträge 10:04–10:51“. Zeitachse mit sinnvollen Ticks in lokaler Zeit.
3. Band für den sichtbaren Bereich der Log-Ansicht. Die Zeit dafür kommt aus der obersten und untersten sichtbaren Zeile, die im `PageCache` liegen.
4. **Klick:** springt mit `position_at_time`, Auswahl bleibt, Follow aus. **Ziehen:** Zeitfenster markieren. Danach „Als Filter“ (Blatt `Time` aus 010) oder „Hineinzoomen“.
   Tastatur: Pfeile bewegen einen Cursor, `Enter` springt. Der Streifen hat ein `aria-label` mit Zusammenfassung („Spitze 10:42 mit 312 Fehlern“).
5. Laden höchstens 2-mal pro Sekunde, nur bei Änderung. Im Follow wächst die Achse mit, beim Zoom bleibt sie stehen.

## Fallen

- Dateien ohne Zeit: Streifen aus mit Hinweis, kein leeres Diagramm.
- Ein Ausreißer (Jahr 1970, Zeitstempel in Daten) zieht die Achse auf Jahrzehnte: Achse vom 1. bis 99. Perzentil der Abschnitte, Ausreißer nur im Tooltip.
- Sommerzeitwechsel: Achse in UTC rechnen, lokal beschriften.
- `onKey` in `log-view.ts` hängt am `document`: Pfeile im Zeitstrahl ausnehmen.

## Tests

- **Rust:** Zusammenfassung bei wachsendem Index und Verdichten, ungeordnete Datei, Lücke, Datei ohne Zeiten, provisorische Zeile, `position_at_time` an Grenzen.
  Messung Einlesen mit und ohne, `get_timeline` bei 500 MB.
- **Vitest:** Eimer auf Säulen, Lückenerkennung, Ticks, Perzentil-Achse.
- **e2e:** Datei mit bekannter Lücke aus `scripts/gen-log.mjs` (Option für Pausen ergänzen): Lücke ist da, Klick springt zur richtigen Zeit, Zeitfilter wirkt.

## Fertig, wenn

- [ ] Tests oben grün, `npm run check`, `npm run contrast` und `npm run e2e` grün
- [ ] Einlesen nicht spürbar langsamer (`measure_`)
- [ ] `README.md`, `CLAUDE.md`, `docs/roadmap.md` (Fehler-Histogramm) ergänzt, Screenshot
- [ ] Sichttest, sonst im Bericht als offen genannt

Kein Commit ohne Rückfrage.
