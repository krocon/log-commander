# 007 Overview Ruler und Navigation – Design und Entscheidungen

- **Status:** umgesetzt (autonom nach Auftrag von Marc, Entscheidungen statt Haltepunkten unten festgehalten)
- **Datum:** 2026-11-07
- **Branch:** `feat/overview-ruler`

## Abweichungen des Prompts vom heutigen Code

Der Prompt stammt aus der Zeit des eigenen Viewports. Zuordnung:

| Prompt | Heute |
|---|---|
| `log-view.css:8` `.scroller` mit Scrollleiste, `:host` als Zeile | GuiExpert Table in `log-table/log-table-view.ts`, eigene Scrollleiste der Tabelle (Ziehen → `onTableScroll`). Die Zeile ist `.log-row` in `app.ts` (Tabelle + Ruler), der Host der Tabelle bleibt unverändert |
| `log-view.ts:241` `ResizeObserver` am Scroller | misst weiter am Host der Tabelle; der Ruler liegt außerhalb und verkleinert ihn nur |
| `features/log-view/overview-ruler.ts` | `features/log-table/overview-ruler.ts`, Logik in `log-table/ruler-logic.ts` |
| `.mark` der Zeile (`log-view.ts:76`) | Klasse `bookmark` an der Zelle des Zeilenrands (`LogAreaModel.getCustomClassesAt`), Fähnchen `⚑` per `::before` (`log-table-marks.css`) |
| `onKey` in `log-view.ts:350` | `onKey` in `log-table-view.ts`; belegt waren `End`, `F`, `Space`, `P`, `T`, `D`, `Home`, Bild/Pfeile, `Esc`; mit Modifier `O`, `W`, `B`, `,`, `Shift+M`, `F`, `C` (`app.ts`, `toolbar.ts`). `E`, `W`, `N`, `M`, `G` ohne Modifier waren frei |
| `log-session.service.ts:167` `find` | `find` im Service, gleiche Scroll-Regel (`top = position − 5`), jetzt als `jumpScroll` in `navigation-logic.ts` |
| `session-state.ts:140` Auswahl bei neuer Epoche, `:173` `onViewChanged` | `applyUpdate` (Epoche) und `onViewChanged` in `session-state.ts` |
| `filter.rs:227` `append`, `:255` `list.extend`, `:192` `position_of` | `append_from`, `list.extend(entry_start..line)`, `position_of` in `filter.rs` (verschoben) |
| `session.rs:356` Identität in `start_job`, `:93` `pop`/`restore`, `:618` `run_relevel` | `start_job`, `retract_provisional`, `run_relevel` in `session.rs` |
| `indexer.rs:77` `replace` | `LineIndex::replace` |
| `model.rs:114` `FindHit` | `FindHit` in `model.rs` |
| Zwischenzähler aus 005 | `entry_head` + `entry_counts` in `FilteredLines`; die Zusammenfassung bucht nachträglich aufgenommene Zeilen daraus |
| „Mit 006: Index wird neu aufgebaut“ | „Neu sortieren“ und Truncation sind neue Epochen, Lesezeichen fallen dort weg |

## Entscheidungen (statt Rückfrage)

| Frage | Optionen | Entscheidung | Grund |
|---|---|---|---|
| Platz des Rulers | a) neben der Scrollleiste der Tabelle, b) Scrollleiste ausblenden und ersetzen | a) | Das Ziehen der Scrollleiste ist schon auf Zeilen abgebildet und getestet; `scrollbar-width` lässt sich nicht nur für die vertikale Achse abschalten, die horizontale muss bleiben. macOS blendet die Leiste aus, das Band im Ruler gibt die Orientierung |
| Startgröße der Abschnitte | 16 Zeilen (Prompt) / 1 Zeile | 1 Zeile, Verdichten ab 64 K Abschnitten wie im Prompt | Bei 16 lägen in kleinen Dateien (100 Zeilen auf 400 px) Marken 64 px hoch und ungenau. Mit 1 ist die Leiste bis 64 K Zeilen exakt; ab 1 M Zeilen ist die Größe ohnehin ≥ 16. Speicher wie im Prompt höchstens 64 KB je Zusammenfassung |
| Eimer-Zuordnung | Abschnitt in den Eimer seiner ersten Position / in jeden berührten Eimer | jeden berührten | Zuerst „erste Position“ umgesetzt: bei weniger Zeilen als Pixeln (Screenshot mit 15 Zeilen) zerfiel ein Stacktrace in einzelne Striche mit Lücken. Jetzt füllt eine Zeile alle ihre Pixel; ein Abschnitt über einer Eimergrenze markiert beide (höchstens 1 px Unschärfe) |
| Nachträglich aufgenommene Zeilen | exakt je Zeile merken / als Lauf | `push_run(Maske, Anzahl)` aus dem Zwischenzähler von 005 | Die Reihenfolge ist dort nicht mehr bekannt; Fortsetzungen erben das Level des Kopfs, praktisch ist die Maske ein Bit |
| Rückzug der provisorischen Zeile | offener Abschnitt im Checkpoint (Prompt) / `truncate` | beides: `SummaryMark` im `FilterCheckpoint`, exakt solange kein Abschnitt geschlossen wurde, sonst `truncate` (Bit darf bleiben). `LineIndex::pop` macht dasselbe ohne Checkpoint | Der Prompt erlaubt das stehende Bit; `find_level` sucht exakt |
| `find_level`: Startpunkt | inklusiv / exklusiv | `from_position` exklusiv, `None` = vom Anfang bzw. Ende | Wie `find` mit `fromLine`; „nächster“ heißt nach der aktuellen Stelle |
| `get_overview`/`find_level` über `blocking` | ja / nein | nein, nur Lesesperre | Messung 500 MB: 0,22–0,32 ms bzw. ≤ 0,17 ms |
| Grenzen überschritten | kappen / Fehler | Fehler `too_large` | Das Frontend schickt nie mehr (Höhe ≤ 8192, Lesezeichen gekappt), ein Fehler fällt im Test auf |
| Tooltip „3 ERROR, 12 WARN“ | Anzahlen je Abschnitt speichern / nur Level | Level und Zeilenbereich der Ansicht („ERROR, WARN · Zeilen 101–110 der Ansicht“) | Anzahlen bräuchten Zähler je Abschnitt (×7 Speicher) für einen Tooltip; Roadmap |
| Bezugspunkt von `E`/`W`/`N` | Auswahl / oberste Zeile / letzter Sprung | letzter Sprung (`jumpMark`), solange nicht gescrollt wurde; sonst oberste Zeile (vorwärts einschließlich) | Die Auswahl bleibt bei Sprüngen gleich, sie als Bezug ergäbe immer denselben Treffer |
| Position eines Lesezeichens für `N` | aus der letzten Ruler-Antwort / `get_position` | `get_position` (vorhandener Befehl) | „kein IPC“ im Prompt verstanden als kein neuer Befehl: Lesezeichen liegen im Frontend. Die Ruler-Daten fehlen bei ausgeschaltetem Ruler |
| `M` ohne Auswahl, `G` ohne Auswahl/Filter | still / Meldung | Meldung über `showFindMessage` („Keine Zeile gewählt“, „Kein Filter aktiv“) | Rückmeldung statt nichts |
| Filtersuche bei `G` | leeren / zu Hervorheben machen | Modus „Hervorheben“, Text bleibt | Die Treffer bleiben im Gesamtlog markiert und mit `Enter` erreichbar; zurück stellt den Modus her |
| Wann verfällt der gemerkte Filter | jede Änderung von Hand | jeder `applyFilter` außer Hin- und Rückweg (Levels, Suche, Modus, Quellen, Presets, Seitenleiste) | Prompt: „ändert der Nutzer selbst den Filter, verfällt das Gemerkte“ |
| Buttons für Teil B | Toolbar / auch Detail-Panel | beide: „⇱ Im Gesamtlog“ bei aktivem Filter und Auswahl, sonst „↩ Zurück zum Filter“ solange gemerkt | Prompt; mit 004 vorhanden |
| „Ans Ende“ | Badge ersetzen / zusätzlich | Button am Fuß des Rulers mit `aria-pressed` = Follow; Badge „N neue Zeilen“ und die leise Variante in der Tabelle bleiben | Prompt; die leise Variante deckt den ausgeschalteten Ruler ab |
| Klick auf eine Lesezeichen-/Auswahl-Marke | Trefferradius | 4 px, Auswahl gewinnt bei Gleichstand | Marken sind klein; vor Level-Marken laut Prompt |
| Marke für ausgeblendete Lesezeichen/Auswahl | weglassen / hohl | hohl gezeichnet an der Position der nächsten sichtbaren Zeile, Tooltip „(vom Filter ausgeblendet)“ | `visible` aus `get_overview` |
| e2e ohne Canvas-Pixel | | `data-count`, `data-generation`, `data-marks` (`LEVEL:y`), `data-pins` (`kind:line:y`) am Ruler | Prompt verlangt Prüfung über Daten |
| CSS-Budget | Budget erhöhen / eigene Datei | `log-table-marks.css` | `log-table-view.css` lag 4 KB knapp an der Warnschwelle |

## Vertrag

- `get_overview(sessionId, buckets ≤ 8192, lines ≤ 10 000) -> Overview { viewGeneration, epoch, count, buckets: u8[], marks: { line, position, visible }[] }`, Bits `1 << Level` (UNKNOWN = 0 … FATAL = 6), Fehler `too_large`.
- `find_level(sessionId, fromPosition: u32 | null, forward, levels: Level[]) -> FindHit | null` (nur Köpfe, `wrapped` wie bei `find`).
- `SessionState`: `bookmarks`, `keptFilter`, `filterActive`, `pendingReveal`, `jumpMark`, `jumpTo`, `revealPending`.
- `LogSessionService`: `jumpToLevel`, `jumpToRulerLevel`, `toggleBookmark`, `jumpToBookmark`, `revealInFullLog`, `returnToFilter`, `toggleFullLog`.
- Settings: `showOverviewRuler` (Vorgabe an), Dialog „Übersichtsleiste rechts“.
- Kürzel: `E`/`Shift+E`, `W`/`Shift+W`, `N`/`Shift+N`, `M`, `G`. Ruler `aria-hidden`, Button „Ans Ende“ fokussierbar.
- Tokens: `--ruler-bg`, `--ruler-band`, `--ruler-band-edge`, `--ruler-fatal`, `--ruler-error`, `--ruler-warn`, `--ruler-bookmark`, `--ruler-selection` (dark und light, `GRAPHIC_PAIRS`).

## Messwerte

`measure_500mb` (5,1 Mio. Zeilen, release, Apple Silicon):

| | vorher | nachher |
|---|---|---|
| Einlesen | 2,14 s | 2,14–2,18 s |
| Level-Filter | 30 ms | 25–30 ms |
| Suchfilter | 733 ms | 716–753 ms |
| Tail-Updates in 3 s bei 10k Zeilen/s | 29 | 29 |
| `get_overview` 800 Eimer, 1000 Marken (Identität / ERROR-Filter) | – | 223 µs / 320 µs (vor dem Füllen aller Eimer 90 / 151 µs) |
| `find_level` nächster ERROR (Identität / Filter) | – | 0,1 µs / 0,03 µs |
| `find_level` FATAL ohne Treffer (Identität / Filter) | – | 128 µs / 172 µs |

## Fortschritt

- [x] Phase 1: Bestand, Zuordnung, Entscheidungen
- [x] Phase 2: `overview.rs` mit Unit-Tests, Zusammenfassung in `LineIndex` und `FilteredLines`, `get_overview`, `find_level`, Integrationstests (Filter mit Stacktrace-Treffer, provisorische Zeile, Identität nach Filter, Neu-Leveln, Truncation, Rotation, `find_level` vor/zurück/Umlauf/Köpfe/kein Treffer, `visible`), Messung
- [x] Phase 3: `ruler-logic`, `navigation-logic` (Specs), Ruler-Komponente, Lesezeichen, Tasten, `G`/Buttons, Einstellung, Tokens
- [x] Phase 4: e2e (Ruler-Daten, Klick auf ERROR-Marke bei gleicher Auswahl, `E`/`Shift+E`/`Shift+W`, `M`/`N`, ERROR-Filter ordnet Marken neu, `G` hin und zurück mit gleicher Auswahl, Button, Verfall bei Filter von Hand, Ruler im Tail, neue Epoche leert Lesezeichen)
- [x] Phase 5: Doku, Screenshots
- [x] Phase 6: `npm run check`, `npm run contrast`, `npm run e2e`
- [ ] Sichttest mit `npm run demo:log` / `npm run demo:app` (5000 Zeilen/s), hell und dunkel: von Hand offen
