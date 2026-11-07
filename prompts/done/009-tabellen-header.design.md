# 009 Tabellen-Header: Design und Entscheidungen

Status: umgesetzt · Datum: 2026-11-07 · Branch `feat/tabellen-header`

Der Prompt wurde vor 003 geschrieben und wollte den eigenen Viewport behalten. Seit 003 ist die GuiExpert Table die
einzige Ansicht; Marc hat 009 ausdrücklich auf die Tabelle umgeplant. Offene Punkte wurden ohne Rückfrage entschieden
(Auftrag: autonom arbeiten), hier mit Optionen, Entscheidung und Grund.

## Verträge

- Keine neuen Commands, DTOs oder Fehlercodes: Grundlage sind `LogLine.fields` und `get_columns` aus 008.
- Settings: `columnMode: 'columns' | 'raw'` (Vorgabe `columns`), `columnLayouts: Record<profileId, { order, widths,
  hidden }>`. `mergeSettings` verwirft kaputte Einträge und Teile (Breiten nur endliche Zahlen > 0, ganzzahlig).
- Kürzel: `T` Spalten/Roh (frei: nicht in `README.md`, `log-table-view.ts`, `app.ts`, `toolbar.ts`), `Shift+F10` und die
  Kontextmenü-Taste öffnen das Spaltenmenü. Beide nur, wenn der Fokus nicht in einem Eingabefeld, Dialog oder dem Menü liegt.
- ARIA: die Tabelle setzt `role="grid"`, Zeilen `role="row"`, Kopf `columnheader`, Zellen `gridcell` mit
  `aria-colindex` und bei Spannen `aria-colspan`. `aria-rowcount` setzt die Tabelle aus `getRowCount` (= `displayedLines`).
  Spaltenmenü `role="dialog"` mit `aria-label="Spalten"`, Schalter in der Toolbar mit `aria-pressed`.

## Entscheidungen

| Frage | Optionen | Entscheidung | Grund |
|---|---|---|---|
| Basis | eigene Kopfzeile über der Tabelle; Kopfzeile der Tabelle | Kopfzeile der Tabelle, je Feld eine Tabellenspalte, Spalte 0 bleibt die Zeilennummer (fix links) | Breite ziehen, Titel ziehen, horizontales Mitlaufen und ARIA bringt die Tabelle mit. Eine eigene Kopfzeile müsste das alles nachbauen und mit dem Scroll-Modell synchron halten. |
| Rohansicht | Textspalte zusätzlich; eigener Aufbau | zwei Spalten wie in 003, unverändert | „Die Rohansicht ist exakt die von heute“; alle bestehenden e2e-Prüfungen laufen darin. |
| Wann neu bauen | Tabelle bei jeder Layout-Änderung neu; Spalten im Modell tauschen | neu nur bei anderem Modus, anderen Spalten (Profil, Ids, Labels) oder anderer Kopfhöhe (Schriftgröße); Menü-Aktionen über `applyState({ columns })`, Ziehen in der Kopfzeile liest die Tabelle am Ende aus | Neu bauen kostet einen vollständigen Aufbau; bei Breite, Reihenfolge und Sichtbarkeit reicht der vorhandene Weg der Tabelle. Die Position bleibt in `SessionState`, ein Neubau zeichnet an derselben Stelle. |
| Spaltenreihenfolge im Body | Index → Id über die `ColumnDef`s je Zelle; eigene Liste | `LogAreaModel` führt die Ids selbst und überschreibt `changeColumnOrder` (ruft die Tabelle beim Ziehen und bei `applyState`) | Ein Ort, keine Suche je Zelle. |
| Letzte Spalte | feste Breite; füllt den Rest | die letzte sichtbare Spalte füllt den Rest, mindestens so breit wie ihr breitester gezeichneter Inhalt (wie die Textspalte in 003); ihre Breite wird nicht gespeichert, im Menü steht „Rest“ | Sonst bleibt rechts eine leere Fläche oder lange Nachrichten wären abgeschnitten. Gilt auch, wenn `message` nicht hinten steht. |
| Fortsetzungszeilen | ab Nachricht-Spalte; ab erster Spalte | über die ganze Breite ab der ersten Spalte (Empfehlung des Prompts), ebenso Zeilen, die das Layout nicht trifft (alles in `message`, Rest leer) | Stacktraces werden nicht in eine schmale Spalte gequetscht. |
| Wie spannen | `getColspanAt` + `getMaxColspan`; Text in jeder Zelle mit negativem Versatz; Colspan ab erster sichtbarer Spalte | Colspan ab der ersten **sichtbaren** Datenspalte (`spanFrom`, `spanStart()` aus Breiten und `scrollLeft`), Text rückt um deren x nach links; überdeckte Zellen `visibility: hidden`; `getMaxColspan` bleibt 0 | Siehe Tabellen-Grenzen 1 und 2. Mit negativem Versatz in jeder Zelle stünde der Text mehrfach im DOM (Kopieren einer Textauswahl doppelt). |
| Zellen | eigene Tokenisierung je Feld; Segmente der Zeile schneiden | `cellSegments(line, field)` schneidet `lineSegments` an den Spannen, Cache je Zeile und Feld | Treffer und Tokens gelten in allen Spalten gleich, kein zweiter Regex-Lauf. |
| Bedienung per Tastatur | Fokus in der Kopfzeile + Pfeiltasten; Menü | Spaltenmenü (kein natives Menü): je Spalte Checkbox, ◀ ▶, − + (24 px), „Zurücksetzen“, „Schließen“; `Shift+F10`/Kontextmenü-Taste, Rechtsklick auf den Kopf öffnet es für diese Spalte; Escape schließt, der Fokus geht zurück | Die Tabelle hat keine Tastatur-Breitenänderung (Ziehgriff `aria-hidden`, nur Maus). Ein Menü deckt Ein-/Ausblenden, Umordnen und Breite in einem ab, ohne die Tasten der Log-Ansicht (Pfeile scrollen) umzudeuten. |
| Doppelklick auf den Rand | Tabelle `autoResizeColumns`; eigene Messung | eigene Messung der gezeichneten Zellen der Spalte und des Titels | `autoResizeColumns` misst alle Zeilen des Modells (Datei-Scan), verlangt ist nur das Sichtbare. |
| Sortieren | – | aus: `sortable: FalseFn` an jeder `ColumnDef`, Doppelklick sortiert nicht | Prompt. |
| Standard | – | Spalten an, sobald `get_columns` mehr als `message` liefert; sonst keine Kopfzeile, Schalter deaktiviert, `T` wirkt nicht | Prompt. |
| Speichern | je Datei; je Profil | je `ColumnSet.profileId` (inferierte Layouts teilen sich `generic`), sofort nach Menü-Aktion bzw. am Ende des Ziehens | Prompt. Unbekannte Ids im Layout werden ignoriert, neue Spalten hinten angehängt. |
| Kopfhöhe | eigene Area; `defaultRowHeights.header` | `rowH + 8`, über `defaultRowHeights`; `bodyH = Hostthöhe − Kopf` für `visibleRowCount`, Follow und Balken | Ohne Abzug stünde die letzte Zeile im Follow unter dem Rand. |
| Farben | neue Tokens; vorhandene | vorhandene (`--bg-panel`, `--text`, `--border`, `--bg-raised`, `--bg-hover`), neue Paare in `PAIRS` | Kein neues Token nötig, Kontrast trotzdem geprüft. |
| Ziehen während Updates | weiterzeichnen; anhalten | Zeichnen wartet, solange die Maus in der Kopfzeile gedrückt ist (wie bei einer Textauswahl), danach wird nachgeholt | Ein `repaintHard` mitten im Ziehen setzt Breiten der Tabelle (letzte Spalte) und zeichnet den gezogenen Titel neu. |

## Grenzen der GuiExpert Table (für einen Mono-Prompt)

1. **Spannen brauchen alle Zeilen vorab.** Sobald `getMaxColspan()` oder `getMaxRowspan()` > 1 liefert, baut
   `ColAndRowspanModel.init()` (`col-and-rowspan-model.ts`) die Bereiche über **alle Zeilen × alle Spalten** und tut das bei
   jeder neuen Zeilenzahl wieder (`initIfRowCountChanged`, `render-scope.ts:609`), also je Tail-Update O(n) bei Millionen
   Zeilen, dazu `getColspanAt` für nicht geladene Zeilen. **Umgehung:** `getMaxColspan` bleibt 0, die App liefert den Colspan
   nur in `getColspanAt`. Core-Wunsch: Spannen nur für die gerenderten Zeilen auswerten (z. B. Option „lazy spans“, die
   `ColAndRowspanModel` überspringt und Bereiche je Render-Pass aus den sichtbaren Zeilen sammelt).
2. **Ohne Bereichsmodell zeichnet die Tabelle einen Colspan nur aus seiner Startzelle** (`adjustColumnsToRowParent`,
   Bedingung `left + w > 0`). Ist die Startspalte horizontal herausgescrollt, fehlt die ganze Spanne, und die überdeckten
   Zellen werden trotzdem gezeichnet. **Umgehung:** Start in der ersten sichtbaren Spalte, Text mit negativem
   `margin-left`, überdeckte Zellen per Klasse unsichtbar; ändert sich `spanFrom` ohne Positionswechsel der Tabelle
   (eigener Balken), folgt ein `repaint()`. Core-Wunsch: angeschnittene Spannen ohne Bereichsmodell zeichnen und
   überdeckte Zellen auslassen.
3. **Die Zeilennummer ist eine normale Spalte**, weil `rowNumbersVisible` bei eigenen Area-Modellen nicht passt (003). Die
   Tabelle schützt nur `RowNumberColumnDef` vor dem Ziehen; eine Spalte lässt sich vor die Nummer ziehen (Ziel
   `max(index, getFirstDataColumnIndex())` = 0) und gerät damit in den fixen Bereich. **Umgehung:** `mousedown` auf dem
   Nummernkopf wird abgefangen, nach dem Ziehen stellt `applyState` die Nummer wieder nach vorn. Core-Wunsch: fixe Spalten
   (`fixedLeftColumnCount`) generell nicht als Ziehziel bzw. Ziehquelle, oder ein Flag „nicht verschiebbar“ an `ColumnDef`.
4. **Breite per Tastatur** gibt es nicht (Ziehgriff `aria-hidden`, nur Maus); `autoResizeColumns` misst alle Zeilen.
   **Umgehung:** Spaltenmenü und eigene Messung der sichtbaren Zellen.
5. Kein Ereignis „Ziehen in der Kopfzeile beendet“ mit Ergebnis; `onStateChanged` kommt entprellt (300 ms) und meldet auch
   Breiten, die die App selbst gesetzt hat. **Umgehung:** `mouseup` abwarten, dann Reihenfolge und Breiten aus dem
   Tabellenmodell lesen; die Füllbreite der letzten Spalte wird erkannt und nicht gespeichert.

## Messwerte

`node scripts/e2e/run.mjs --scenario scripts/e2e/spike-003.js` (macOS, Debug-Build, echtes Backend, `big.log` mit 2 Mio.
Zeilen im Spring-Boot-Format, Writer 5000 Zeilen/s, Fenster sichtbar). Je Modus zwei Durchgänge im Wechsel (Spalten, Roh,
Spalten, Roh), hier die Spannen:

| Follow, 5000 Zeilen/s | Rohansicht | Spaltenansicht (6 Spalten + Nummer) |
|---|---|---|
| alle Level: Frames p50 / p95 / max | 17 / 20 / 25–38 ms | 17 / 22–24 / 32–43 ms |
| ERROR+: Frames p50 / p95 / max | 17 / 19–20 / 23–25 ms | 17 / 22–23 / 28–47 ms |
| Frames > 50 ms | 0 | 0 |
| Zeichnen je Update p50 / p95 | 4 / 5 ms | 7–8 / 8–10 ms |
| Platzhalter im Follow | 0 | 0 |
| CPU App / WebView | 17–24 % / 18–24 % | 15–20 % / 24–29 % |
| Lesen bei Zeile ~1 Mio., 30.000 neue Zeilen: Versatz | 0 | 0 |
| Textauswahl beim Lesen, 6000 neue Zeilen | bleibt | bleibt |

Bewertung: 60 fps im Median bleiben, keine langen Frames; die Spaltenansicht kostet je Update etwa 3–4 ms mehr
(p95 der Frames +2–4 ms). Ursache ist die Zahl der Zellen (je Zeile 7 statt 2), die die Tabelle bei jedem Update vollständig
neu aufbaut (Blocker 7/Optional aus 003: „nur geänderte Zeilen neu aufbauen“ im Core würde beide Modi entlasten).
Nachgebessert: Zellen ohne Token/Treffer setzen `textContent` direkt statt eines Spans je Segment; messbar war das nicht
(innerhalb des Rauschens). Der Rest liegt im Core und ist als Wunsch notiert; der Verlust ist nicht spürbar (Median
unverändert), deshalb hingenommen.

Hinweis zur Messung: In einem verdeckten Fenster laufen weder `requestAnimationFrame` noch Timer normal; ein Lauf so
ergab Zeichenzeiten von 60–80 ms in der Spaltenansicht (gedrosselter WebView), sichtbar waren es 7–8 ms. Für Vergleiche
nur Läufe mit sichtbarem Fenster verwenden.

## Fehler unterwegs

- **Follow ging beim Neubau der Tabelle verloren.** Die Tabelle meldet beim Aufbau (`firstInit`) synchron ihre
  Scrollposition 0; `onTableScroll` hielt das für Ziehen am Balken (alter Erwartungswert) und hielt den Follow an, oben.
  Zudem zeichnete `draw()` einmal mit dem neuen Aufbau, aber noch mit der Api der alten Tabelle. Jetzt zeichnet die App nur,
  wenn `api.getTableModel()` zum aktuellen Aufbau gehört, und wertet Scroll-Ereignisse erst nach dem ersten Zeichnen der
  neuen Tabelle aus (`drawnConfig`). Gefunden durch die e2e-Prüfung „big file indexed“ (Datei im Spaltenformat wurde beim
  Start im Hintergrund-Tab umgebaut).

## Fortschritt

- [x] Reine Logik `features/log-table/columns-logic.ts` mit Spec (zusammenführen, neu/fehlend, klemmen, verschieben,
  Füllbreite, Spannen, Spannenstart), `cellSegments` in `highlight.ts` (Treffer über Grenze, leeres Feld, Emoji, keine
  Felder, Segment zerschnitten), Settings-Merge mit Spec
- [x] `LogAreaModel`: Spalten je Feld, Colspan, Klassen `lt-col`, `lt-lead`, `lt-span`, `lt-spanned`, `data-col`
- [x] `LogTableViewComponent`: Aufbau je Modus, Kopfzeile, Füllbreite, Spannenstart, Halten beim Ziehen, Speichern,
  Doppelklick-Anpassen, `T`, `Shift+F10`; `ColumnMenuComponent`
- [x] Toolbar-Schalter „▦ Spalten“ mit `aria-pressed`
- [x] e2e: Kopfzeile für Spring Boot, keine für eine Datei ohne Struktur, Zellinhalt, Spanne ab erster Spalte, bündig
  auch horizontal, Menü per `Shift+F10`, Breite, Ausblenden, Verschieben, Escape, Treffer in Zellen, Rechtsklick,
  Zurücksetzen, `T` hin und zurück; alle bisherigen Prüfungen laufen in der Rohansicht
- [x] Mock (`mock-ipc.js`) mit Spring-Boot-Spalten, Screenshots erneuert
- [x] Doku: README, CLAUDE.md, architecture, roadmap, themes, Kopf von 003
- [ ] Sichttest von Hand mit `npm run demo:log` / `demo:app` (hell/dunkel, schmales Fenster, Ziehen mit Maus/Trackpad)
- [ ] VoiceOver
- [ ] Neustart: Layout bleibt je Profil (nur über die Merge-Specs und den Store-Weg geprüft, nicht mit echtem Neustart)
- [x] Vergleich Spalten/Roh bei 5000 Zeilen/s (oben)
