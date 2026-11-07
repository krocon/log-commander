# 003 GuiExpert Table – Spike

- **Status:** Spike fertig, wartet auf Freigabe (Phase 2/3) 🛑
- **Datum:** 2026-11-07
- **Branch:** `feat/gui-expert-table` (log-commander), im Mono-Repo nichts geändert
- **Tabelle:** `@guiexpert/table@1.1.106`, `@guiexpert/angular-table@22.1.106` (npm, MIT)
- **Entscheidung Marc:** Umbau auf die GuiExpert Table gewollt, oberste Priorität (vor 009, das den eigenen Viewport behalten
  wollte; 009 muss danach auf der Tabelle aufsetzen).

## Aufbau des Spikes

Zweite Komponente `features/log-table/` neben der alten, umschaltbar in den Einstellungen („Tabellen-Ansicht (Test, ohne
Umbruch)“, Setting `tableView`, Vorgabe aus). Beide lesen denselben `SessionState`, die Logik aus 001 (`displayedLines`,
`PageCache`) ist unverändert.

| Datei | Inhalt |
|---|---|
| `log-area-model.ts` | `LogAreaModel extends AreaModel`: `getRowCount` = `displayedLines`, `getValueAt` aus `PageCache`, `getCustomClassesAt` = Level, Fortsetzung, Auswahl, Treffer; `LogCellRenderer` baut die Segmente aus `highlight.ts` mit `textContent` |
| `table-logic.ts` (+ Spec) | reine Logik: Zeilenklassen, Zeile ↔ Inhaltspixel, Balken → Inhaltspixel, Halten bei Textauswahl, Breite der Textspalte |
| `log-table-view.ts/.css` | `TableSignalComponent`, Spalte 0 Zeilennummer (fix links), Spalte 1 Text; Header aus; Farben über die vorhandenen Tokens |

**Prinzip: Die App bleibt Herrin der Position.** `SessionState.scroll` (Zeile + Pixel) bleibt die Wahrheit, Rad und Tasten
laufen über `viewport-logic.ts` wie bisher. Die Tabelle zeichnet nur: bei neuer Zeilenzahl `repaintHard()`, danach immer
`scrollToPixel(left, top·rowH + subPx)`. Das Ziehen am Balken meldet die Tabelle über `(scroll)`, daraus wird wieder eine
Position. So bleiben Follow, „N neue Zeilen“, Freeze, Klemmen am Ende und `wantedRange` unverändert.

Messung: `node scripts/e2e/run.mjs --scenario scripts/e2e/spike-003.js` im echten WebView (macOS, Debug-Build, echtes Backend),
Datei mit 2 Mio. Zeilen, Writer mit 5000 Zeilen/s. Frame-Zeiten per `requestAnimationFrame`, Platzhalter per
`MutationObserver`, CPU über `ps` (App-Prozess und WebKit-Content-Prozess).

## Messwerte

Frame-Zeiten aus Lauf 1 (Fenster sichtbar). In Lauf 2 war das Fenster verdeckt, `requestAnimationFrame` lief nur alle
~400 ms; daraus nur CPU, Wandern und Auswahl. „Zeichnen“ = Dauer von `draw()` (Tabelle: `repaintHard` + `scrollToPixel`).

| Messung (2 Mio. Zeilen, 5000 Zeilen/s) | Eigener Viewport | GuiExpert Table |
|---|---|---|
| Follow, alle Level: Frames p50 / p95 / max | 17 / 18 / 22 ms | 17 / 26 / 32 ms |
| Follow, ERROR+: Frames p50 / p95 / max | 17 / 18 / 21 ms | 17 / 26 / 35 ms |
| Frames > 50 ms im Follow | 0 | 0 |
| Zeichnen je Update p50 / p95 / max | – (Angular-Template) | 4 / 9 / 15–17 ms |
| Zeile ohne Text im Follow (`.row.loading`) | 0 von 51 | 0 von 105 bzw. 155 |
| CPU App / WebView im Follow (Lauf 1) | 15 % / 13 % | 11 % / 27 % |
| CPU App / WebView im Follow (Lauf 2) | 16 % / 13 % | 23 % / 18 % |
| RSS WebView nach Follow | 173–184 MB | 241–276 MB |
| RSS WebView nach Scrollen (Lauf 1) | 192 MB | 369 MB |
| Lesen bei Zeile ~1 Mio., 30.000 neue Zeilen: Versatz | 0 | 0 (nach Verankern) |
| Textauswahl beim Lesen, 6000 neue Zeilen | bleibt | bleibt (nach Fix, vorher verloren) |
| Rad + Balken: Frames p50 / p95 / max | 17 / 18 / 18 ms | 17 / 19 / 20 ms |
| Rad + Balken: Platzhalter-Änderungen | 12 von 112 | 31 von 246 |
| Bundle `main.js` roh / übertragen | 222 / 61 kB | 762 / 180 kB |

Lesart: Die Tabelle hält 60 fps im Median, kostet im Follow aber spürbar mehr pro Update (p95 26 statt 18 ms, doppelt so
viel WebView-CPU, ~90–180 MB mehr Speicher). Hauptgrund ist das doppelte Rendern (Blocker 7) und der vollständige Neuaufbau
aller sichtbaren Zellen je Update. Platzhalter beim Springen gibt es in beiden, weil `getValueAt` synchron ist und Seiten
nachgeladen werden; das ist das Verhalten von heute.

**10 Mio. Zeilen** (`--big-lines 10000000`, Fenster sichtbar), Kriterium „ruhiges Lesen im laufenden Tail ohne Wandern“:

| Messung (10 Mio. Zeilen, 5000 Zeilen/s) | Eigener Viewport | GuiExpert Table |
|---|---|---|
| Follow, alle Level: Frames p50 / p95 / max | 17 / 18 / 21 ms | 17 / 23 / 32 ms |
| Follow, ERROR+: Frames p50 / p95 / max | 17 / 18 / 22 ms | 17 / 22 / 28 ms |
| Zeichnen je Update p50 / p95 / max | – | 4–5 / 10–11 / 12–22 ms |
| Platzhalter im Follow | 0 von 48 / 52 | 0 von 120 / 165 |
| CPU App / WebView im Follow | 17 % / 15 % | 13 % / 25 % |
| RSS WebView | 193–201 MB | 276–344 MB |
| Lesen bei Zeile ~5 Mio., 30.000 neue Zeilen: Versatz | 0 | **0** |
| Textauswahl beim Lesen | bleibt | bleibt |
| Rad + Balken: Frames p50 / p95 / max | 17 / 17 / 18 ms | 17 / 20 / 22 ms |

Die Werte hängen nicht von der Zeilenzahl ab (2 Mio. und 10 Mio. gleich), wie im Prompt für `repaintHard` erwartet.

**Nach 1.1.107** (Prompt 017: ein Render je `repaintHard({ px, py })`, Scrollhöhe aus dem Area-Modell), 2 Mio. Zeilen,
Fenster sichtbar. App-Umgehung `defaultRowHeights` entfernt, Balken per CSS `scrollbar-width: none` ausgeblendet:

| Messung (2 Mio. Zeilen, 5000 Zeilen/s) | Eigener Viewport | GuiExpert Table 1.1.107 (vorher 1.1.106) |
|---|---|---|
| Follow, alle Level: Frames p50 / p95 / max | 17 / 18 / 22 ms | 17 / **20** / 28 ms (17 / 26 / 32) |
| Follow, ERROR+: Frames p50 / p95 / max | 17 / 18 / 22 ms | 17 / **19** / 23 ms (17 / 26 / 35) |
| Zeichnen je Update p50 / p95 / max | – | 4 / **5–6** / 12–13 ms (4 / 9 / 15–17) |
| Platzhalter im Follow | 0 von 45 / 47 | 0 von 99 / 115 |
| CPU App / WebView im Follow | 15–17 % / 15–16 % | 13–15 % / **18 %** (11–23 % / 18–27 %) |
| RSS WebView nach Follow / Scrollen | 172–181 MB | **216–261 MB** (241–369 MB) |
| Lesen bei Zeile ~1 Mio., 30.000 neue Zeilen: Versatz | 0 | 0 |
| Textauswahl beim Lesen | bleibt | bleibt |
| Rad + Balken: Frames p50 / p95 / max | 17 / 18 / 20 ms | 17 / 18 / 21 ms |

Blocker 7 und 8 sind damit im Core behoben; der Abstand zum eigenen Viewport im Follow ist p95 1–2 ms.

## Blocker → Lösung → Aufwand → Core-Änderung

| # | Blocker | Ergebnis im Spike | Lösung | Aufwand | Core |
|---|---|---|---|---|---|
| 1 | Wandern beim Anhängen | **gelöst ohne Core.** Bei gekappter Scrollhöhe hängt die Inhaltsposition an `scrollTop / Balkenbereich`, der Bereich wächst mit. Nach jedem Update `scrollToPixel(left, top·rowH + subPx)`: Das setzt `pendingContentScroll`, der Inhalt steht pixelgenau. Gemessen: 0 Zeilen Versatz bei Zeile ~1 Mio. von 2 Mio., 30.000 neue Zeilen | App verankert nach jedem Zeichnen | erledigt | nein (optional: `repaintHard(contentTop)`, siehe 7) |
| 2 | Zeilenumbruch | **offen.** `RowLayout` kann variable Höhen nur als vollständiges `Float64Array` (10 Mio. Zeilen = 80 MB, O(n) je `repaintHard`, also je Update). Ausweg im Core: Grundhöhe konstant plus **dünn besetzte Mehrhöhen** je Zeile. `RowLayout` hat dafür schon `setExtras` (für Detailzeilen), es fehlt ein Weg vom Area-Modell (z. B. `getRowHeightOverrides()`), das Zeichnen der Zeile mit ihrer Gesamthöhe und Zellen mit `white-space: pre-wrap`. Die App misst sichtbare Zeilen nach dem Zeichnen (wie heute `heights`) und meldet Überhöhen. | Core-Feature „sparse row heights“, dann Messschleife in der App | Core 2–3 Tage inkl. Tests, App 1 Tag | **ja** |
| 3 | Textauswahl | **gelöst ohne Core, mit Einschränkung.** Jedes Zeichnen baut das DOM neu und beendet die Auswahl. Solange eine Auswahl in der Tabelle liegt und nicht gefolgt wird, zeichnet die App nicht (`holdForSelection`), danach holt sie nach. Gemessen: Auswahl bleibt über 6000 neue Zeilen. Falle gefunden: Tabellen-Aufrufe in einem `effect` lesen das Area-Modell und abonnieren dessen Signale, also nur in `untracked`. Im Follow geht die Auswahl wie erwartet verloren (heute ebenso, die Zeilen wandern raus). | App hält das Zeichnen an | erledigt | nein (besser: Core zeichnet nur geänderte Zeilen) |
| 4 | Horizontales Scrollen | **gelöst ohne Core.** Breite der Textspalte = breiteste bisher gezeichnete Zeile + 24 px, mindestens die freie Breite, `setColumnWidth(1, w)`. Wachsen nur nach oben, zurückgesetzt je Tab. | App misst `.lt-text` | erledigt | nein |
| 5 | Platzhalter | **gelöst.** `getRowCount` = `displayedLines`; Follow ohne leere Zeile (0 von 105 bzw. 155 Änderungen). Beim schnellen Springen per Balken kurz `…` wie heute. | – | erledigt | nein |
| 6 | Auswahl und Tastatur | **gelöst ohne Core.** `mouseClicked` (Debounce 0) → `selectEntry`, Shift erweitert; Tasten bleiben am `document`; `shortcutActionsDisabled`, keine Tabellen-Selektion (`isSelectable` false); eigene Spalte für Zeilennummern (fix links) statt `rowNumbersVisible`. | – | erledigt | nein |
| 7 | Mehrfaches Rendern (neu) | Je Update rendert die Tabelle **dreimal** (`repaintHard` zweimal: `ele-scope.ts:525` und `render-scope.ts:606`, dann `scrollToPixel`). Zeichnen dauert p50 4 ms, p95 9 ms, max 17 ms; im Follow p95 26 ms Frame statt 18 ms. | Core: `repaintHard` mit Zielposition (ein Render), oder `scrollToPixel` misst selbst neu | Core 0,5 Tage | ja (klein) |
| 8 | Scrollbalken bei wenig Zeilen (neu) | **Ursache gefunden:** `TableModel.getAreaHeight` rechnet mit `defaultRowHeights` (34 px) statt mit der Höhe des Area-Modells (20 px), gezeichnet wird mit 20 px. 15 Zeilen → `scrollHeight` 511; 3000 Zeilen → 102.001 statt 60.001 px (falscher Daumen, falsche Balken-Zuordnung). App-Umgehung: `defaultRowHeights.body` = `rowH()`, danach kein Balken mehr (435 = 435) | App: erledigt; Core: Prompt 017 im Mono-Repo | Core 0,5–1 Tag | ja (Fehler) |
| 9 | Bundle (neu) | `main.js` 222 → 762 kB roh, 61 → 180 kB übertragen. Für eine lokale Tauri-App ohne Netz unkritisch, Budget 1 MB Warnung. | – | – | nein |
| 10 | CSP (neu) | `style-src 'self' 'unsafe-inline'` mit `dangerousDisableAssetCspModification` reicht, die Tabelle setzt Inline-Styles. Keine Änderung nötig. | – | – | nein |

## Empfehlung

**Für den Umbau, mit drei Core-Änderungen vorab.** Wandern, Textauswahl, Breite, Platzhalter, Klick und Tastatur sind ohne
Core lösbar und im Spike gelöst. Die Position bleibt in der App (`viewport-logic.ts` bleibt, nur das Zeichnen wechselt).
Offen sind:

1. **Zeilenumbruch (Blocker 2):** „Sparse row heights“ im Core: konstante Grundhöhe plus Überhöhen je Zeile über das
   Area-Modell, Prefix-Summen nur über die Ausnahmen (Baustein `setExtras` existiert). Ohne das verliert die App den Umbruch.
2. **Ein Render je Update (Blocker 7):** `repaintHard` mit Zielposition oder `scrollToPixel`, das Höhen selbst neu
   berechnet. Bringt den Follow auf das Niveau von heute zurück.
3. **Kein Scrollbalken ohne Überlauf (Blocker 8).**

Optional später: nur geänderte Zeilen neu aufbauen (weniger CPU, Auswahl auch im Follow).

Mit 1–3 ist der Umbau ohne Funktionsverlust machbar. Danach Phase 3 wie im Prompt: alter Viewport (`log-view.ts`, Teile von
`log-view.css`) raus, `viewport-logic.ts` bleibt als Scroll-Modell, e2e-Selektoren von `.row`/`.text`/`.scroller` auf die
Tabelle umstellen. 009 (Kopfzeile) setzt dann auf den Header der Tabelle auf statt auf eine eigene Kopfzeile.

## Entscheidungen Marc (2026-11-07)

- **Zeilenumbruch entfällt.** Die Tabelle zeigt Zeilen mit fester Höhe, kein Core-Feature „sparse row heights“. In Phase 3
  fallen `wrapLines`, der Umbruch-Schalter in Toolbar und Einstellungen und die Höhenmessung weg (Funktionsverlust
  ausdrücklich freigegeben).
- **Core-Fixes 7 und 8** kommen als eigener Prompt im Mono-Repo:
  `guiexpert-table/mono/prompts/017-ein-render-je-update-und-scrollhoehe.md`. Statt einer Option zum Ausblenden des
  Balkens wird die Ursache behoben (falsche Scrollhöhe).

## Offene Fragen an Marc (Stand Spike)

1. **Zeilenumbruch:** Core-Feature „sparse row heights“ bauen (Empfehlung), Umbruch streichen, oder für den Umbruch den
   alten Viewport behalten (zwei Ansichten, nur als Übergang)?
2. **Core-Änderungen 1–3** im Mono-Repo auf eigenem Branch freigeben? Bis zum Release teste ich lokal gegen
   `packages/table/dist` und `angular-builds/ng22/dist` (dort derzeit nicht gebaut). Release/Publish nur auf deine Anweisung.
3. **009** auf die Tabelle umplanen (Header der Tabelle, Spaltenbreiten/Reihenfolge aus der Tabelle)? Die Entscheidung
   „Eigener Viewport bleibt“ in 009 ist damit überholt.

## Fortschritt

- [x] Phase 1: Spike, Messung, dieses Dokument. `npm run check` grün, `npm run e2e` grün (108 Schritte, Rohmodus
  unverändert), Spike-Szenario mit 2 und 10 Mio. Zeilen gelaufen. Harness: `--scenario`, `--big-lines`, Aktionen
  `cpustart`/`cpustop`, `rate … big`.
- [x] „Unabhängig vom Ergebnis“: `CLAUDE.md` und `docs/roadmap.md` zur Scroll-Skalierung korrigiert
- [ ] Sichttest von Hand mit `npm run demo:log` / `demo:app`, hell und dunkel, schmales Fenster (nur Screenshots per
  WebKit-Mock angesehen, dunkel und hell)
- [ ] Freigabe 🛑
- [x] Phase 2: Core-Änderungen im Mono-Repo: Prompt 017, Release 1.1.107 (von Marc umgesetzt)
- [x] Phase 3, Schritt 1: auf 1.1.107 gehoben, `draw()` nutzt `repaintHard({ px, py })` (ein Render), Umgehung
  `defaultRowHeights` entfernt, Balken per CSS ausgeblendet; `npm run check` und `npm run e2e` grün (108), Spike neu gemessen
- [x] Phase 3, Schritt 2: Tabelle ist die einzige Ansicht. `log-view.ts`/`.css` entfernt, `highlight` und
  `viewport-logic` nach `features/log-table/`; Settings `tableView` und `wrapLines` entfernt (alte Werte im Store werden
  verworfen), Umbruch-Knopf weg. Zellen tragen `data-line`. e2e auf `.lt-cell`/`.lt-gutter` umgestellt (107 Schritte grün,
  Umbruch-Schritte entfallen). Fehler gefunden und behoben: `scrollToPixel` rendert bei gleicher Position nicht, eine
  nachgeladene Seite oder ein Filter ohne Positionswechsel blieb alt stehen → dann `repaint()`. Spike nur noch für die
  Tabelle. Scrollleiste wieder sichtbar (Marc, 2026-11-07): ohne Überlauf erscheint seit 1.1.107 keine, und Ziehen
  springt in großen Dateien schnell an eine Stelle. Messung danach: Follow p95 20–21 ms, Zeichnen p95 6–7 ms, Versatz 0, Auswahl bleibt. Doku (CLAUDE.md,
  README, architecture, themes, roadmap) nachgezogen.
- [ ] Sichttest von Hand (hell/dunkel, schmales Fenster, Klick-Auswahl, Shift-Klick, Ziehen mit Trackpad)
- [ ] Zeilenumbruch als Folgezeilen fester Höhe (Roadmap, eigene Entscheidung)
