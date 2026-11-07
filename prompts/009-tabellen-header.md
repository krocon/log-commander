# Prompt 009: Tabellen-Header und Spaltenansicht

> Start in neuer Sitzung: „Führe `prompts/009-tabellen-header.md` aus.“
> Voraussetzung: 008 (Spalten und Felder). Ersetzt für die Spalten den Umbau aus 003, siehe unten.
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

Über der Log-Ansicht steht eine feste Kopfzeile mit den erkannten Spalten, zum Beispiel Date, Time, Thread, Level, Logger,
Message. Die Zeilen darunter stehen spaltenweise darunter. Spalten lassen sich in der Breite ändern, ausblenden und umordnen. Ein
Schalter führt zurück zur Rohansicht von heute.

## Entscheidungen

| Thema | Entscheidung | Warum |
|---|---|---|
| Basis | Eigener Viewport bleibt, kein Umbau auf die GuiExpert Table | Spalten brauchen nur Zellen je Zeile und eine Kopfzeile. Scroll-Modell, Follow, `displayedLines`, Auswahl und Zeilenumbruch bleiben erhalten. Die Blocker aus 003 (Wandern, Umbruch, Textauswahl) entstehen gar nicht erst. 003 bleibt als Option für später. |
| Sortieren | Kein Klick zum Sortieren | Die Ansicht ist nach Zeit und Datei geordnet und wächst live. Sortieren hieße, jede Zeile zu lesen und Positionen ohne Zeitbezug zu pflegen. Bewusst weggelassen, kein versteckter Button. |
| Standard | Spalten an, sobald 008 mehr als `message` erkannt hat. Sonst keine Kopfzeile | Bei einer Spalte wäre der Header nur Platzverlust. |
| Speichern | Breiten, Reihenfolge, Sichtbarkeit je `profile_id` in den Settings | Zwei Logs desselben Formats sollen gleich aussehen. Geltung je Datei wäre beim nächsten Öffnen wieder weg. |

## Frontend

1. **Reine Logik** `features/log-view/columns-logic.ts` mit Spec: Layout aus `ColumnSet` und Settings zusammenführen (neue Spalten hinten,
   weggefallene ignorieren), Breiten klemmen, Schneiden der Segmente in Zellen.
2. **Zellen:** `lineSegments` bleibt für die Zeile. `cellSegments(line, fields)` schneidet die vorhandenen Segmente an den Grenzen der
   Spannen, gecacht wie in `highlight.ts:68`. Treffer und Tokens gelten damit in allen Spalten. Die Tokenisierung endet bei 4000 Zeichen
   (`MAX_TOKENIZED`), danach ist es einfacher Text, das passt auch für Zellen.
3. **Zeile:** In `log-view.ts:68` je nach Modus `.text` oder Zellen. Breiten als CSS-Variablen am `.view`
   (`--col-0` …), damit beim Ziehen keine Zeile neu gebaut wird, nur Stil. `.gutter` und `.mark` bleiben links wie heute, ihre Breite
   spiegelt die Kopfzeile als leere Fläche. Letzte sichtbare Spalte (`message`) füllt den Rest, ist mindestens so breit wie der Inhalt.
4. **Kopfzeile** `log-header.ts` außerhalb von `.scroller`, sonst wandert sie mit oder braucht `sticky` in einem künstlich hohen Element.
   Horizontal folgt sie über `--sx` (`log-view.ts:61`), wie heute die Zeilen. Rechts die Breite der Scrollleiste aussparen: `offsetWidth − clientWidth` messen, unter macOS oft 0.
5. **Bedienung der Kopfzeile:**
   - Rand ziehen: Breite, mit dem Splitter-Verhalten aus 004 (Pointer Capture, `role="separator"`, Pfeiltasten). Speichern am Ende des Ziehens.
   - Doppelklick auf den Rand: an den Inhalt anpassen, gemessen an den **sichtbaren** Zeilen. Keine Datei-Scans.
   - Kontextmenü (Rechtsklick und Tastenkombination `Shift+F10`, kein natives Menü): Spalten ein- und ausblenden, zurücksetzen. `message` lässt sich nicht ausblenden.
   - Ziehen des Titels: Reihenfolge. Alternativ im Kontextmenü „nach links/rechts“, das deckt auch die Tastatur ab. `message` bleibt nicht fix.
6. **A11y:** `role="grid"` nur, wenn es wirklich trägt. Virtualisierung und Follow machen es teuer: `role="row"` und `columnheader` in der Kopfzeile, `aria-colindex` an den Zellen, `aria-rowcount` weglassen, wenn unbekannt. Zeilen sind nicht fokussierbar, wie heute. Mit VoiceOver prüfen oder als offen nennen.
7. **Umschalten:** Schalter „Spalten/Roh“ in der Toolbar mit `aria-pressed`, Kürzel `T`. Die Rohansicht ist exakt die von heute.
8. **Settings:** `columnLayouts: Record<profileId, { order, widths, hidden }>`, `columnMode`. Merge-Logik um Vorgaben ergänzen.

## Fallen

- **Fortsetzungszeilen:** Sie laufen über die Spalten hinweg ab der Nachricht-Spalte oder ab der ersten Spalte, kein Zerschneiden. Empfehlung: ab der ersten Spalte über die ganze Breite, weil Stacktraces sonst schmal gequetscht werden.
- **Umbruch:** Mit `wrapLines` brechen Zellen in ihrer Spalte um, Höhe ist die höchste Zelle. `measure` (`log-view.ts:264`) misst schon `offsetHeight` der Zeile. Bei Spaltenbreiten-Änderungen `heights` verwerfen (Effekt in `log-view.ts:220`). Während des Ziehens nur am Ende, sonst ruckelt es.
- **Breite im Spaltenmodus:** `measure` rechnet über `.text` (`log-view.ts:279`). Im Spaltenmodus Summe der Breiten plus Inhalt der letzten Zelle, damit die horizontale Scrollleiste stimmt.
- **Textauswahl:** Zeilen bleiben markierbar, `user-select` nur am Kopf aus. Auswahl über Spalten hinweg ergibt Text mit Zellgrenzen, deshalb bleibt `copy_lines` (Rohtext) für die Eintragsauswahl maßgeblich. Kopieren ändert sich nicht.
- **Klick-Logik:** `onClick` sucht `.row` (`log-view.ts:344`), bleibt also gültig. Klick in die Kopfzeile darf nicht auslösen, liegt aber auch außerhalb von `.view`.
- **Viewport-Höhe:** Die Kopfzeile nimmt nur Platz im Host. `ResizeObserver` misst `.scroller`, also richtig. `visibleRowCount` passt ohne Änderung.
- **Formatwechsel:** Bei neuer `columnsRevision` Layout neu berechnen, Scrollposition behalten. Keine Spalten-Reste im Cache durch `view_generation` aus 008.
- **Farben:** Level-Farbe gilt für die ganze Zeile wie heute. Token nur in `styles.css`, Kontrast der Kopfzeile prüfen.
- **Schmale Fenster:** Summe der Mindestbreiten über 720 px: horizontal scrollen, nichts wird abgeschnitten oder überlappt. Mit Leiste aus 005 prüfen.

## Tests

- **Vitest:** `columns-logic` (zusammenführen, neu/fehlend, klemmen), `cellSegments` (Treffer über Grenze, leeres Feld, Emoji, keine Felder, Segment zerschnitten). Settings-Merge.
- **e2e:** Kopfzeile erscheint für `samples/spring-boot.log`, keine für eine Datei ohne Struktur. Zelle enthält den erwarteten Text. Breite per Tastatur ändern, Spalte ausblenden, Rohansicht per `T`, Treffer im Spaltenmodus, horizontal: Kopf und Zellen bleiben bündig (`getBoundingClientRect`). Die vorhandenen Prüfungen in `scenario.js` gelten im Rohmodus weiter.
- **Vergleich:** Bei 5000 Zeilen/s im Follow mit Spalten: Frame-Zeiten gegenüber Rohmodus, Ergebnis im Bericht. Bei einem spürbaren Verlust nachbessern, nicht hinnehmen.

## Nicht in diesem Prompt

Sortieren, Filtern aus der Kopfzeile (kommt mit 010), feste (angepinnte) Spalten, Excel-Export.

## Fertig, wenn

- [ ] Tests oben grün, `npm run check`, `npm run contrast` und `npm run e2e` grün
- [ ] Kopfzeile und Zellen bleiben beim horizontalen Scrollen, Umbruch und Fenster-Änderung bündig
- [ ] Layout überlebt Neustart, je Profil getrennt
- [ ] Keine Verschlechterung der Rohansicht
- [ ] Screenshots erneuert, `README.md`, `CLAUDE.md` (Entscheidung zum Viewport), `docs/roadmap.md` (Spaltenansicht) und Kopf von `prompts/done/003-gui-expert-table.md` (Spalten erledigt, Nutzen neu bewerten) angepasst
- [ ] Sichttest mit `npm run demo:log` und `npm run demo:app`, sonst im Bericht als offen genannt

Kein Commit ohne Rückfrage.
