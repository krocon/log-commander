# 004 Detail-Panel – Design und Entscheidungen

- **Status:** umgesetzt (autonom nach Auftrag von Marc, Entscheidungen statt Haltepunkten unten festgehalten)
- **Datum:** 2026-11-07
- **Branch:** `feat/detail-panel`

## Abweichungen des Prompts vom heutigen Code

Der Prompt stammt aus der Zeit des eigenen Viewports (`features/log-view/log-view.ts`, `.row`, `wrapLines`). Seit 003/009
ist die GuiExpert Table in `src/app/features/log-table/` die einzige Ansicht. Zuordnung:

| Prompt | Heute |
|---|---|
| `entry_range` `session.rs:515`, `copy_lines` `session.rs:536` | `session.rs` ~`entry_range`/`copy_lines` (Logik jetzt in `range_of`, `copy`) |
| `log-view.ts:67` Zeilen nach `row.position` getrackt | Tabelle baut Zeilen je Repaint neu; Zellen tragen `data-line` (`log-area-model.ts`) |
| `log-view.ts:343` `onClick` kehrt bei Wortauswahl zurück | `onTableClick` in `log-table-view.ts` (gleiches Verhalten über `window.getSelection()`) |
| `log-view.ts:248`/`:352` `onKey` am `document` | `onKey` in `log-table-view.ts`, nimmt jetzt `.detail` und `[role=separator]` aus (außer `D`) |
| `log-view.ts:241` `ResizeObserver` | `ResizeObserver` im `ngOnInit` von `log-table-view.ts` (`viewportH` → `bodyH`) |
| `session-state.ts:140` Auswahl bei neuer `epoch` leeren | `applyUpdate` in `session-state.ts` (unverändert) |
| Umbruch nach `wrapLines` | `wrapLines` gibt es nicht mehr (`mergeSettings` löscht den Schlüssel); eigene Einstellung `detailWrap` |

## Entscheidungen (statt Rückfrage)

| Frage | Optionen | Entscheidung | Grund |
|---|---|---|---|
| Umbruch im Panel | a) immer umbrechen, b) nie, c) eigener Schalter | c) `detailWrap` (Vorgabe an), Schalter „↵ Umbruch“ im Kopf | `wrapLines` ist mit 003 entfallen, die Tabelle bricht nie um; im Panel ist Umbruch der Hauptnutzen bei langen Zeilen. |
| Kopieren eines gefilterten Eintrags | a) `copy_lines` wie bisher (gefiltert), b) optionaler Parameter `view` | b) `copy_lines(…, view: 'all')` ignoriert den Filter | `get_entry` liest ohne Filter; ein Eintrag, den ein späterer Filter ausblendet, käme sonst leer oder lückenhaft an. Abwärtskompatibel (Vorgabe `filtered`). |
| Farben | neue Tokens oder vorhandene | vorhandene `--tok-*`, `--hit-*`, Level-Paare; Paare auf `--bg-app` in `check-contrast.mjs` ergänzt | Keine neuen Farbwerte nötig, beide Themes sind schon geprüft. |
| Lade-Strategie | Zähler verwerfen alle älteren Antworten | höchstens ein `get_entry` zugleich, Updates währenddessen fordern genau einen weiteren an; Antworten für eine andere Zeile/Tab/`epoch`/`viewGeneration` werden verworfen | Ein reiner Zähler hungert bei 10 Updates/s und langsamem IPC aus (jede Antwort wäre schon überholt). |
| Neuladen am Dateiende | nur `totalLines` | `totalLines` **oder** `fileSize` | Die provisorische letzte Zeile wächst, ohne dass `totalLines` sich ändert. |
| Doppelklick im Tail | Ziel des Doppelklicks oder erster Klick | Zeigt die Auswahl; nur ohne Auswahl **und** ohne Klick in der letzten Sekunde gilt das Ziel (`data-line`) | `selectEntry` ist asynchron: beim `dblclick` kann die Auswahl des ersten Klicks noch unterwegs sein. |
| Block-Suche | nur ganzer Text / Rest nach Kopfzeile | zusätzlich bis zu 8 Stellen `{`, `[`, `<` in der Kopfzeile (`payload={…}`); JSON muss bis zum Zeilenende reichen, der Rest folgt roh | Häufigster Fall in Logs ist JSON hinter einem Präfix in derselben Zeile. |
| Leere Datei | leerer Eintrag oder Fehler | `get_entry` → `not_found` | Ohne Zeilen gibt es keine Auswahl; der Fall ist nur theoretisch. |
| Menü-Eintrag | Eintrag in „View“ mit oder ohne Kürzel | nicht umgesetzt | Ein Menü-Accelerator `D` finge das Tippen in Eingabefeldern ab; ohne Kürzel bräuchte es ein weiteres Event samt Listener in `app.ts`. Prompt: „nur falls ohne Umbau möglich“. |
| Splitter-Tastatur | | Pfeile 10 px, Shift 100 px, Pos1/Ende zu den Grenzen, Doppelklick Standard (240 px) | `role=separator` nach WAI-ARIA „Window Splitter“. |

## Vertrag

- `get_entry(sessionId, line) -> EntryDetail { first, last, level, lineCount, totalBytes, text, truncated }`;
  `totalBytes` = Bytes der Zeilen in der Datei ohne Zeilenende. Fehler: `unknown_session`, `not_found` (leere Datei), `io`.
- `copy_lines(sessionId, first, last, view?: 'all' | 'filtered')`.
- `MAX_DETAIL_BYTES = 1 MiB` (`session.rs`); je Zeile werden höchstens `2 × Rest + 4` Bytes gelesen, dann an einer
  Zeichengrenze geschnitten (in jeder Kodierung ergeben zwei Rohbytes mindestens ein Byte Text).
- Settings: `detailVisible` (false), `detailHeight` (240, 80–4000), `detailWrap` (true).
- Kürzel: `D` (Panel ein/aus, auch im fokussierten Panel), Doppelklick auf eine Zeile öffnet; im Panel scrollen Pfeile
  und Bild auf/ab nur das Panel.

## Messwerte

Kein Eingriff in Einlesen, Filter oder Suche: `measure_` nicht nötig. `get_entry` liest nur die Zeilen des Eintrags.
e2e: 10k Zeilen/s über 3 s mit offenem Panel, das Panel bleibt auf seinem Eintrag (Werte siehe Bericht).

## Fortschritt

- [x] Phase 1: Bestand, Zuordnung der Zeilenangaben, Entscheidungen
- [x] Phase 2: Rust `get_entry`, `copy_all_lines`, Tests (Stacktrace, wachsend, UTF-8/UTF-16-Grenze, Rotation, geschrumpft)
- [x] Phase 3: Splitter, Panel, `detail-format`, `detail-logic`, Settings, Toolbar, `D`, Doppelklick, Sichtbarkeit der Auswahl
- [x] Phase 4: e2e (Doppelklick, Klick, `D`, Splitter per Tastatur, Stacktrace vollständig, Pfeile im Panel, JSON, Tail)
- [x] Phase 5: Doku, Screenshots (`detail.png`); Fix: Tabelle zeichnet bei neuer Höhe hart neu (ihr eigener ResizeObserver entprellt 500 ms, sonst lag sie kurz über dem Panel)
- [x] Phase 6: `npm run check`, `npm run contrast`, `npm run e2e` (155 Schritte) grün
- [ ] Sichttest mit `npm run demo:log` / `npm run demo:app`, hell und dunkel, schmales Fenster: von Hand offen
