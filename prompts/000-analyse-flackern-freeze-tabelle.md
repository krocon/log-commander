# Analyse: Flackern, Freeze, GuiExpert Table (Stand 07.11.2026)

Grundlage der Prompts 001 bis 003. Untersucht auf `main` (`cd3e188`) und GuiExpert Table 1.1.106 (Mono-Repo, `938dd3f`).

## Ergebnis

| Frage | Antwort |
|---|---|
| Woher kommt das Flackern? | Aus dem Datenweg, nicht aus dem Rendering: Neue Zeilen werden gezeichnet, bevor ihr Text da ist. |
| Behebt die GuiExpert Table das? | Nein. Sie fragt `getValueAt()` synchron ab und stünde vor derselben Lücke. |
| Wie groß ist der Fix? | Klein und nur im Frontend, siehe [001](done/001-flackern-beheben.md) (umgesetzt). |
| Freeze | Ist etwas anderes als das vorhandene „Pausiert“. Am einfachsten pausiert der Tail-Worker im Backend, siehe [002](done/002-freeze-button.md) (umgesetzt). |
| Lohnt die Tabelle trotzdem? | Für eine spätere Spaltenansicht ja, nicht gegen das Flackern. Es gibt offene Blocker, siehe [003](003-gui-expert-table.md). |

**Reihenfolge:** 001, dann 002, danach Entscheidung über 003. 001 und 002 hängen technisch nicht voneinander ab, aber
das Aufholen nach einem Freeze sieht erst mit 001 ruhig aus.

## a) Flackern

### Ursache

Ablauf bei jedem Live-Update (bis zu 10 pro Sekunde, `EMIT_INTERVAL` in `tail.rs:28`):

1. `SessionState.applyUpdate` setzt `filteredLines` sofort auf den neuen Wert und markiert die letzte Seite als veraltet
   (`session-state.ts:93`, `page-cache.ts:58`).
2. Im Follow-Modus springt `bottomAnchor` im selben Durchlauf ans neue Ende (`log-view.ts:189`).
3. `rows()` fragt für die neuen Positionen `cache.line()`. Die alte Seite kennt sie nicht, also kommt `null`, und die
   Zeile wird zu `row loading` (`log-view.ts:155-158`).
4. `.row.loading` hat keine Level-Klasse und damit `--lv-unknown-bg` (`log-view.css:41`). Das sind im hellen Theme
   `#fbfbfc` (weiß) statt `--lv-error-bg` `#fdecec` (rot).
5. Erst nach dem IPC-Aufruf `get_lines` sind die Zeilen da und werden rot.

Der Kommentar in `page-cache.ts:56` („So following does not flicker“) gilt nur für Zeilen, die schon in der Seite stehen,
nicht für die neuen am Ende.

Bei ERROR+ fällt das besonders auf, weil alle Zeilen dieselbe kräftige Farbe haben und der Wechsel zu weiß gleichmäßig über
die Fläche läuft. Bei „Alle“ passiert technisch dasselbe, geht aber im bunten Bild unter. Dass die Beschwerde das helle
Theme betrifft, schließe ich aus „rot und weiß“; im dunklen Theme wechselt es zwischen `#2c1719` und `#14171c`.

### Messung

Echtes Produktions-Frontend in Playwright-WebKit, IPC-Mock mit künstlicher Latenz, 10 Updates pro Sekunde, 5 s, Fenster
mit 28 Zeilen. Gezählt: Frames (per `requestAnimationFrame`), in denen `.row.loading` vorkommt, von rund 300 Frames.

| Szenario | Latenz 1 ms | Latenz 5 ms | Latenz 20 ms | Leere Zeilen je betroffenem Frame |
|---|---|---|---|---|
| ERROR+, 5000 Zeilen/s, 10 % ERROR | 24 | 25 | 71 | 28 von 28 |
| ERROR+, 200 Zeilen/s, 10 % ERROR | 21 | 17 | 69 | 2 von 28 |
| Alle, 5000 Zeilen/s | 31 | 38 | 73 | 28 von 28 |
| Alle, 200 Zeilen/s | 23 | 22 | 68 | 20 von 28 |

Schon bei 1 ms erreicht also rund jedes zweite der etwa 50 Updates den Bildschirm. Das passt zu einem sichtbaren Flackern
mit mehreren Hertz. Bei hoher Schreibrate ist die ganze Fläche betroffen.

Standbild des Zustands (Latenz nur für die Aufnahme gestreckt): [analyse-flackern-frame.png](analyse-flackern-frame.png).

Echtes Backend im Tauri-WebView (`npm run e2e`, Nachtrag aus 001): `get_lines` im Tail im Median 3 ms, höchstens 8 ms.
Vor dem Fix enthielten bei 10.000 Zeilen/s 36 von 66 Änderungen der Ansicht Zeilen ohne Text, danach keine.

## b) Freeze

Das vorhandene „Pausiert“ (Leertaste, Hochscrollen) stoppt nur das Mitscrollen (`SessionState.follow`). Weiter laufen die
Zähler in den Chips, die Zeilenzahl, die Scrollleiste und das Nachladen. Für ruhiges Lesen reicht das nicht.

Empfehlung: Der Worker liest im Freeze nicht weiter. Dann bleibt der Index stehen, und Filter, Suche, Kopieren und
Zeilenzahl sind ohne weiteren Code konsistent. Eine reine Frontend-Lösung müsste dagegen jede Abfrage auf einen
Zeilenstand begrenzen, weil ein Filterwechsel im Backend über alle bis dahin gelesenen Zeilen läuft.

Die Fallstricke stehen in 002: Filter-Updates laufen über `tick()`, der Text liegt nicht im Speicher (Truncation), und
mehrfache Rotation während des Freeze.

## c) GuiExpert Table

Die Begründung in `CLAUDE.md` („am Browser-Limit bei rund 1,5 Mio. Zeilen Schluss“) ist **überholt**: Die Tabelle kappt die
Scrollhöhe inzwischen bei 8 Mio. px (`ele-scope.ts:29`) und bildet den Rest proportional ab.

Messung (WebKit, `dist` 1.1.106, eigenes `AreaModel`, konstante Zeilenhöhe 20 px, Scrollposition Mitte, 50.000 Zeilen in
50 Schritten angehängt, je Schritt `repaintHard()`):

| Zeilen | `repaintHard()` Median | Versatz nach echtem Scrollen | Versatz nach `scrollToIndex` |
|---|---|---|---|
| 100.000 | 5 ms | 1 Zeile | 0 |
| 300.000 | 5 ms | 1 Zeile | 0 |
| 1.000.000 | 5 ms | **25.001 Zeilen** | 0 |
| 5.000.000 | 4 ms | **25.000 Zeilen** | 0 |
| 50.000.000 | 4 ms | **25.000 Zeilen** | 0 |

Die Menge ist also kein Problem mehr. Dafür bleibt das Wachsen: Ab 400.000 Zeilen (8 Mio. px / 20 px) wandert die Ansicht
beim Anhängen, wenn der Nutzer selbst gescrollt hat. Ursache ist `scrollFactorY` in `render-scope.ts:719`, das bei
gekappter Höhe konstant bleibt, während der Inhalt wächst. Der Lauf deckt nur diese eine Spalte ohne eigene Renderer ab.

Weitere Punkte (aus dem Code, nicht gemessen):

- **Platzhalter:** `getValueAt()` ist synchron, die Lücke aus a) bliebe bestehen.
- **Zeilenumbruch:** `RowLayout.setRows` braucht alle Höhen vorab, in den Quellen gibt es keine automatische Zeilenhöhe.
  Der heutige Viewport misst nur die sichtbaren Zeilen (`log-view.ts:256`).
- **DOM-Neuaufbau:** Jeder Render leert die Areas (`render-scope.ts:1257`). Eine Textauswahl mit der Maus dürfte damit bei
  jedem Live-Update verloren gehen; im heutigen Viewport bleiben die Zeilen-Elemente erhalten.

Passend für Log Commander: `AreaModel` auf Abruf, `getCustomClassesAt`, Renderer für Inline-Tokens, Paket
`@guiexpert/angular-table@22.1.106` für Angular 22, MIT-Lizenz (`mono/CLAUDE.md` §8 erwägt künftig eine Dual-Lizenz).

## Reproduktion

Die Messskripte lagen nur im temporären Scratchpad. Nachbauen lässt sich die Messung mit `scripts/screenshots.mjs` plus
`scripts/e2e/mock-ipc.js`: dort `get_lines` verzögern, eine Funktion zum Anhängen von Zeilen ergänzen, die jeweils
`callbacks.get(session.channel)` mit `update(session)` aufruft, und `.row.loading` je `requestAnimationFrame` zählen.
