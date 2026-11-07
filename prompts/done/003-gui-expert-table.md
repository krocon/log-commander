# Prompt 003: Log-Ansicht auf GuiExpert Table umstellen

> Start in neuer Sitzung: „Lies `prompts/000-analyse-flackern-freeze-tabelle.md` und führe `prompts/done/003-gui-expert-table.md` aus.“
> Voraussetzung: 001 ist umgesetzt. **Erst nach dem Sichttest von 001 entscheiden, ob dieser Prompt noch gewollt ist.**
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Wozu

Dieser Umbau ist **kein Fix für das Flackern**, das erledigt 001. Sein Nutzen: eine Tabellen-Basis für die Spaltenansicht
aus `docs/roadmap.md` (Feld-Extraktion, fixierte Spalten, Sortierung, Excel-Export) und weniger eigener Viewport-Code.
Der Preis sind die Blocker unten und mindestens eine Änderung am Core der Tabelle.

Tabelle: `/Users/marckronberg/WebstormProjects/video/2026/guiexpert-table/mono`, zuerst dort `CLAUDE.md` §3 und
`packages/angular-table/instructions.md` Abschnitt 14 lesen (`TableSignalComponent`, Angular 22, zoneless).

## Was schon passt

- Eigenes `AreaModel` mit `getRowCount`, `getValueAt`, `getConstantRowHeight`: nur sichtbare Zeilen werden abgefragt.
- `repaintHard()` nach wachsender Zeilenzahl dauert 4 bis 5 ms, unabhängig von der Menge (gemessen bis 50 Mio. Zeilen, eine
  Spalte ohne eigene Renderer).
- Scrollhöhe gekappt bei 8 Mio. px; das alte Argument in `CLAUDE.md` gilt nicht mehr.
- `getCustomClassesAt` für Level-Farben, `CellRendererIf` für Inline-Tokens und Treffer aus `highlight.ts`.
- `@guiexpert/angular-table@22.1.106`, MIT.

## Blocker, im Spike zu klären

| # | Thema | Stand | Mögliche Lösung |
|---|---|---|---|
| 1 | **Wandern beim Anhängen** | Gemessen: Ab 400.000 Zeilen wandert die Ansicht nach echtem Scrollen (25.000 Zeilen Versatz je 50.000 neue, Mitte des Balkens). Ursache `render-scope.ts:719`. Nach `scrollToIndex` war der Versatz 0. | Core: Inhaltsposition beim Wachsen halten, oder hier nach jedem Update mit `scrollToIndex` neu verankern (nicht getestet, auch nicht mit laufendem Scrollen). |
| 2 | **Zeilenumbruch** | `RowLayout` braucht alle Höhen vorab, keine automatische Zeilenhöhe. `wrapLines` ist ein vorhandenes Feature. | Core-Feature mit geschätzten Höhen, oder Umbruch streichen (Rückfrage). Zwei Viewports parallel nur als Übergang. |
| 3 | **Textauswahl** | `adjustArea` baut bei jedem Render das DOM neu (`render-scope.ts:1257`), das dürfte eine Maus-Auswahl bei jedem Update löschen. `user-select` der Body-Zellen prüfen. | Repaint nur bei sichtbarer Änderung. Im Tail bleibt das Problem, außer im Freeze. |
| 4 | **Horizontales Scrollen** | Heute misst `log-view.ts:272` die breiteste sichtbare Zeile. Die Tabelle braucht eine Spaltenbreite. | `api.setColumnWidth` nach Messung, Verhalten beim Wachsen prüfen. |
| 5 | **Platzhalter** | `getValueAt` ist synchron. Ohne `displayedLines` aus 001 käme das Flackern zurück. | `getRowCount` liefert `displayedLines`. |
| 6 | **Eintrags-Auswahl und Tastatur** | Klick wählt einen mehrzeiligen Eintrag (`selectEntry`), Tasten in `onKey`, eigene Zeilennummern. `rowNumbersVisible` warnt bei eigenen Area-Modellen. | Eigene Spalte für Nummern, `onMouseClicked`, Konflikte mit dem `ShortcutService` prüfen. |

## Phase 1: Spike, dann anhalten 🛑

Auf einem Branch, ohne bestehenden Code zu entfernen: Tabelle in einer zweiten Komponente hinter einem Schalter einbauen
und mit `npm run demo:log` gegen das echte Backend laufen lassen. Nacheinander messen oder zeigen:

1. Verhalten bei 5000 Zeilen/s im Follow, mit ERROR+, hell und dunkel: `.row.loading`-Entsprechung und Frame-Zeiten.
2. Blocker 1 mit Lesen mitten im Log bei mehr als 400.000 Zeilen.
3. Blocker 3 mit einer echten Textauswahl im Tail.
4. Bundle-Größe vorher und nachher (`npm run build`), CSP in `tauri.conf.json` (`style-src`).
5. Vergleich mit dem Viewport aus 001: Scrollen per Rad und Balken, Speicher, CPU.

Ergebnis ist `prompts/done/003-gui-expert-table.design.md` mit den Messwerten, einer Tabelle „Blocker → Lösung → Aufwand →
Core-Änderung ja/nein“ und einer Empfehlung für oder gegen den Umbau. **Danach anhalten und die Entscheidung einholen.** Vor
allem zum Zeilenumbruch muss Marc entscheiden. Ein negatives Ergebnis ist ein gültiges Ergebnis.

## Phase 2: Core-Änderungen im Mono-Repo (nur nach Freigabe)

Eigener Branch und Ablauf dort nach `prompts/000-arbeitsweise.md`. Kein Release und kein Publish ohne ausdrückliche
Anweisung. Bis zum Release lokal gegen `packages/table/dist` und `angular-builds/ng22/dist` testen, nicht `package.json`
dauerhaft auf lokale Pfade umstellen.

## Phase 3: Umstellung (nur nach Freigabe)

1. Abhängigkeiten ergänzen, `.ge-table`-CSS laden, `--ge-table-*` aus den Tokens in `src/styles.css` ableiten.
   Farben bleiben nur in `styles.css`, `npm run contrast` prüft sie.
2. `LogAreaModel` liest aus `SessionState`: Zeilenzahl `displayedLines`, Werte aus `PageCache`. Die Logik aus 001 bleibt
   unangetastet.
3. `LogViewComponent` umbauen: `api.repaintHard()` bei Änderung des Stands, `api.repaint()` bei neuem Seiteninhalt,
   Follow per Scrollen ans Ende, Anzeige „N neue Zeilen“, Tastenkürzel und Auswahl wie bisher.
4. Danach nicht mehr Benötigtes entfernen (`viewport-logic.ts` und Spec, Teile von `log-view.css`).
5. `scripts/e2e/scenario.js` nutzt Selektoren wie `.row` und `data-line`: anpassen, ohne Prüfungen abzuschwächen.
6. `CLAUDE.md` (Abschnitt „Eigener Viewport“) und `docs/roadmap.md` neu fassen.

## Unabhängig vom Ergebnis

Die Aussage in `CLAUDE.md` zum Limit von 1,5 Mio. Zeilen und die Formulierung „oder die Tabelle Scroll-Skalierung bekommt“
in `docs/roadmap.md` korrigieren: Die Skalierung gibt es inzwischen, offen sind Wachsen und Umbruch.

## Fertig, wenn

- [ ] Alle vorhandenen e2e-Prüfungen gelten weiter und sind grün, `npm run check` grün
- [ ] 10 Mio. Zeilen: ruhiges Lesen im laufenden Tail ohne Wandern
- [ ] Kein Funktionsverlust gegenüber heute, außer er ist ausdrücklich freigegeben
- [ ] Nicht ausführbare Prüfungen im Bericht genannt

Kein Commit ohne Rückfrage.
