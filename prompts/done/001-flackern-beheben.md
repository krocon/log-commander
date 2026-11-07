# Prompt 001: Flackern beim Live-Tail beheben

> Start in neuer Sitzung: „Lies `prompts/000-analyse-flackern-freeze-tabelle.md` und führe `prompts/001-flackern-beheben.md` aus.“
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Problem

Im Live-Tail wechselt die Log-Tabelle sichtbar zwischen rotem und weißem Hintergrund, besonders mit dem Filter ERROR+.
Neue Zeilen werden gezeichnet, bevor ihr Text geladen ist, und erscheinen für die Dauer eines `get_lines`-Aufrufs als
farblose `row loading`. Details und Messwerte stehen in der Analyse.

## Ziel

Im laufenden Tail zeigt die Ansicht nie eine Platzhalterzeile: Sie bleibt stehen, bis die neuen Zeilen da sind, und rückt
dann in einem Schritt vor.

## Lösungsweg

Die Änderung gehört in `SessionState`/`PageCache`, nicht in die View, damit sie eine spätere Tabelle (Prompt 003)
genauso nutzen kann.

1. **Zwei Zeilenstände trennen.** `update().filteredLines` bleibt der wahre Stand aus dem Backend. Neu ist ein Signal
   `displayedLines` in `SessionState`, der Stand, den die Ansicht zeichnet.
2. **Vorrücken nur mit Daten.** Wächst der wahre Stand, bleibt `displayedLines` zunächst stehen. Sobald die Seiten für das
   neue Ende geladen sind, rückt es im selben Signal-Durchlauf vor wie der Cache-Inhalt. Maßgeblich ist, was tatsächlich
   angekommen ist: das höchste lückenlos geladene Ende, höchstens der wahre Stand.
3. **Kein Aushungern.** Überholt ein Update einen laufenden Ladevorgang (`overtaken` in `page-cache.ts`), darf das Ergebnis
   trotzdem vorrücken. Sonst bliebe die Anzeige bei Latenz über 100 ms und hoher Schreibrate stehen.
4. **Schrumpfen sofort.** Wird eine provisorische Zeile zurückgezogen (`retract_provisional`) oder ändern sich `epoch` bzw.
   `viewGeneration`, folgt `displayedLines` ohne Wartezeit.
5. **Verwender umstellen.** In `log-view.ts` nutzen `metrics` (Z. 133), `rows` (Z. 149), `spacerH` (Z. 174),
   `syncScrollbar` (Z. 288) und `onScrollbar` (Z. 304) den neuen Stand. Der Zähler „N neue Zeilen“ (`newLines`) und die
   Statusleiste behalten den wahren Stand. Auch `@if (session().filteredLines() === 0)` im Template prüfen: Der leere
   Zustand darf nicht aufblitzen.

Das Nachladen braucht die Seiten des neuen Endes, ohne dass die Ansicht schon dort ist: Den Bereich für `cache.ensure`
in `log-view.ts:208` entsprechend aus dem wahren Stand ableiten, im Follow-Modus also das Ende.

## Zu prüfen und zu entscheiden

- **Filterwechsel:** `onViewChanged` leert den Cache (`session-state.ts:123`), danach folgt ein voller Platzhalter-Frame.
  Einmaliger Wechsel, aber derselbe Effekt. Wenn es mit wenig Code geht, das alte Bild halten, bis die erste Seite der
  neuen Sicht da ist; sonst im Bericht nennen.
- **Sprung an eine ungeladene Stelle** (Ziehen am Scrollbalken, Suchtreffer): Hier darf der Platzhalter bleiben, das ist
  kein Live-Flackern. `.row.loading` sollte aber neutral bleiben und nicht wie eine Datenzeile wirken.
- **Andere Effekte im echten WebView:** Sieht man nach dem Fix noch Unruhe, weiter suchen statt nachjustieren. Kandidaten
  sind `will-change: transform` auf `.rows` und `sticky` auf `.view` in `log-view.css`.

## Nicht ändern

Keine GuiExpert Table, kein Umbau von `viewport-logic.ts`, keine Änderung an Rust oder am Update-Takt.

## Tests

- **Vitest:** Neue Spec für den Zustandswechsel (Update kommt, Stand bleibt; Laden fertig, Stand rückt vor; überholte
  Ladung rückt trotzdem vor; Zurückziehen, Epoch- und View-Wechsel). Dafür bietet sich an, die Logik als reine Funktion
  oder kleine Klasse neben `page-cache.ts` zu halten, siehe `page-cache.spec.ts`.
- **e2e:** In `scripts/e2e/scenario.js` beim Lauf „10 000 lines per second“ (ab Z. 249) zusätzlich je
  `requestAnimationFrame` `.row.loading` zählen und erwarten, dass der Wert während des Tails 0 bleibt, einmal mit „Alle“,
  einmal mit ERROR+. Dabei die echte Dauer von `get_lines` messen und im Bericht nennen (die Analyse konnte das nicht).
- **Wiederholen:** Vor dem Fix muss der neue e2e-Schritt rot sein, sonst misst er nicht das Richtige.

## Fertig, wenn

- [ ] `.row.loading` im Live-Tail in 0 Frames, in beiden Szenarien, mit dem echten Backend
- [ ] Autoscroll, Badge „N neue Zeilen“, Rotation, Truncation und provisorische Zeile verhalten sich wie vorher
- [ ] Zeilenumbruch (`wrapLines`) getestet, weil dort `bottomAnchor` gemessene Höhen nutzt
- [ ] `npm run check` und `npm run e2e` grün
- [ ] Kurzer Sichttest mit `npm run demo:log` und `npm run demo:app` in ERROR+, hell und dunkel, oder im Bericht als offen
      genannt, falls nicht ausführbar
- [ ] Entscheidung in `CLAUDE.md` unter „Entscheidungen“ in zwei, drei Sätzen ergänzt

Kein Commit ohne Rückfrage.
