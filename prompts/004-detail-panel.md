# Prompt 004: Detail-Panel unter der Log-Ansicht

> Start in neuer Sitzung: „Führe `prompts/004-detail-panel.md` aus.“
> Reihenfolge: vor 005, denn 005 nutzt den Splitter von hier. Unabhängig von 003.
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

Unter der Log-Ansicht zeigt ein Panel den vollständigen Eintrag der gewählten Zeile: Kopfzeile samt Fortsetzungszeilen, ohne
Kürzung auf die Zeilenbreite, auf Wunsch mit formatiertem JSON oder XML. Die Höhe ist per Splitter verschiebbar, das Panel
lässt sich ein- und ausblenden.

Der Nutzen liegt in zwei Fällen, die die Zeilenansicht schlecht kann: lange Zeilen ohne Umbruch lesen und eingebettete
JSON- oder XML-Blöcke verstehen.

## Entscheidungen

| Thema | Entscheidung | Warum |
|---|---|---|
| Klick | Doppelklick blendet ein geschlossenes Panel ein. Ein einfacher Klick aktualisiert ein offenes Panel, öffnet aber keins. | Einfacher Klick wählt schon heute einen Eintrag (`selectEntry`). Beim Durchklicken soll das Detail mitlaufen, ohne dass jeder Klick das Layout ändert. |
| Was gezeigt wird | `selection().anchor`, als `computed`, ohne neues Signal für die Auswahl | Damit folgen Klick, Shift-Klick (Anker bleibt), Suche (`find` setzt die Auswahl) und `Esc` (leerer Zustand) ohne weiteren Code. |
| Geltung | Sichtbarkeit und Höhe global in den Settings, Inhalt je Tab | Wie die Einstellung `wrapLines`; die Auswahl gehört schon zu `SessionState`. |
| Formatieren | Eigener Tokenizer, der nur Einrückung und Farbe ändert. Kein `JSON.parse`, kein `DOMParser`. | `JSON.parse` rundet 64-Bit-IDs und verfälscht damit Logdaten. Ein XML-Parser scheitert an Fragmenten, wie sie in Logs üblich sind. |

Verworfen: Text im Frontend aus dem `PageCache` zusammensetzen. Dort liegen nur gefilterte Zeilen, je Zeile auf 128 KB gekürzt.

## Backend

1. Neuer Befehl `get_entry(session_id, line) -> EntryDetail` in `commands.rs`, Logik in `session.rs` neben `entry_range`
   (`session.rs:515`), DTO in `model.rs` und `log.models.ts`, Aufruf nur über `LogApi`:
   `{ first, last, level, lineCount, totalBytes, text, truncated }`.
2. Der Bereich kommt aus `entry_range`. Der Text kommt wie in `copy_lines` (`session.rs:536`) über `LineReader` und
   `display_text`, aber direkt aus dem Index. Für den Eintrag gilt also kein Filter.
3. Grenze `MAX_DETAIL_BYTES = 1 MiB` im Text. Darüber `truncated: true` und Schnitt an einer Zeichengrenze, nicht mitten in
   UTF-8 oder UTF-16. Das Kopieren bleibt davon unberührt, siehe unten.
4. Eine Datei, die zwischenzeitlich geschrumpft ist, liefert kürzeren Text (`LineReader::raw`), das ist kein Fehler.

## Frontend

1. **Splitter:** `src/app/shared/splitter.ts` als wiederverwendbare Komponente mit `orientation`, `min`, `max`, Ausgabe beim
   Ziehen und am Ende. `role="separator"`, `aria-orientation`, `aria-valuenow`, per Tastatur fokussierbar: Pfeiltasten
   verschieben, Doppelklick stellt die Standardhöhe her. Reine Rechnung (Klemmen) als Funktion mit Spec. Pointer Events mit
   `setPointerCapture`, dabei `user-select: none` am Body. Die Settings erst am Ende des Ziehens speichern.
2. **Layout:** `.main` in `app.ts` wird zu einer Spalte aus Log-Ansicht, Splitter und Panel. Mindesthöhen: Panel 80 px,
   Log-Ansicht 120 px, bei kleiner werdendem Fenster gewinnt die Log-Ansicht. Fenster-Minimum ist 400 px (`tauri.conf.json`).
   Ohne Sitzung (Startbildschirm) kein Panel.
3. **Komponente** `src/app/features/detail/detail-panel.ts`, OnPush und Signals. Kopf: Level, Zeilenbereich („Zeile 812–840“),
   Größe, Schalter Roh/Formatiert, Kopieren, Schließen. Inhalt: `<pre>` mit Segmenten, keine `innerHTML`. Umbruch nach
   `wrapLines`, sonst horizontal scrollbar. Leerzustand: „Zeile anklicken, um den Eintrag zu sehen“.
4. **Kopieren:** über `copy_lines` mit `first` und `last`, damit auch ein gekürzter Eintrag vollständig ankommt. Bei
   `truncated` steht das im Hinweis („Anzeige nach 1 MB gekürzt, Kopieren liefert alles“).
5. **Formatieren:** reine Funktionen in `detail-format.ts`: Block im Text suchen (ganzer Text oder Rest nach der Kopfzeile,
   beginnend mit `{`, `[`, `<?xml`, `<name`), bei Erfolg Segmente mit Klassen liefern, sonst Rohtext. Oberhalb von 256 KB nicht
   formatieren. Treffer der aktuellen Suche in der Rohansicht markieren, `highlight.ts` wiederverwenden.
6. **Farben** nur als Tokens in `src/styles.css`, dunkel und hell. Prüfen, ob `scripts/check-contrast` die neuen Paare schon
   abdeckt, sonst dort ergänzen. Danach `npm run contrast`.
7. **Bedienung:** Button in der Toolbar mit `aria-pressed`, Kürzel `D` in `onKey`, Eintrag im Menü nur, falls ohne Umbau möglich.
8. **Settings:** `detailVisible`, `detailHeight` in `settings.models.ts`, Vorgaben in der Merge-Logik, damit alte Dateien weiter laden.

## Fallen im vorhandenen Code

- **Doppelklick im laufenden Tail:** Die Zeilen sind nach `row.position` getrackt (`log-view.ts:67`). Im Follow kann zwischen
  den beiden Klicks eine andere Zeile unter dem Zeiger liegen. Der Doppelklick darf die Zeile deshalb nicht neu bestimmen, er
  zeigt, was der erste Klick gewählt hat. Nur ohne Auswahl gilt das Ziel des Doppelklicks.
- **Wortauswahl beim Doppelklick:** Der zweite Klick markiert ein Wort, und `onClick` kehrt dann in `log-view.ts:343` vorzeitig
  zurück. Das ist hier richtig so, den Test aber genau darauf ausrichten.
- **Kürzel:** `onKey` hängt am `document` (`log-view.ts:248`) und nimmt nur Eingabefelder aus (`log-view.ts:352`). Pfeile, Bild
  auf/ab, Pos1 und Ende im fokussierten Panel würden die Log-Ansicht bewegen. `.detail` dort ausnehmen und das Panel scrollbar
  fokussierbar machen (`tabindex="0"`).
- **Wachsender Eintrag:** Ein Stacktrace wird oft erst nach der Kopfzeile fertig geschrieben. Liegt das Ende des Eintrags am
  Dateiende (`last + 1 >= totalLines`), bei jedem Update neu laden. Ebenso bei neuer `viewGeneration`, denn ein Profilwechsel
  kann Fortsetzungszeilen ändern. Sonst kein Neuladen, 10 Updates pro Sekunde kämen sonst als IPC-Last an.
- **Überholte Antworten:** Mit Zähler verwerfen, wie beim schnellen Durchklicken nötig. Bei neuer `epoch` leert
  `applyUpdate` die Auswahl (`session-state.ts:140`), der Leerzustand folgt daraus. Der Hinweis `frozenStale` gilt auch fürs Panel.
- **Verdeckte Zeile:** Öffnet das Panel, wird die Ansicht kleiner, der `ResizeObserver` (`log-view.ts:241`) und der Follow-Effekt
  fangen das ab. Ohne Follow muss die gewählte Zeile aber sichtbar bleiben: Liegt sie danach unter dem Panel, `scroll` so
  setzen, dass sie unten im Bild steht. Follow selbst ändert der Doppelklick nicht.
- **e2e und Pointer Capture:** `setPointerCapture` wirft bei synthetischen Events. Den Splitter in `scenario.js` per Tastatur
  prüfen, nicht per erfundenem Ziehen.

## Tests

- **Rust:** `get_entry` für Zeile mitten im Stacktrace, Eintrag am Dateiende und wachsend, Grenze mit UTF-8 und UTF-16 am
  Schnitt, Datei nach Rotation (älteres Segment), geschrumpfte Datei.
- **Vitest:** `detail-format` mit großer Zahl `{"id":9007199254740993}` (bleibt exakt erhalten), Strings mit `{` und `"`, kaputtem
  JSON (Rohtext), XML-Fragment, Kommentar, CDATA, Attribut mit `>`. Klemmen des Splitters. Merge der Settings.
- **e2e** (`scripts/e2e/scenario.js`): Doppelklick öffnet, einfacher Klick wechselt den Inhalt, `D` schließt, Höhe per Tastatur
  ändern, Stacktrace steht vollständig im Panel, Pfeil im Panel bewegt die Log-Ansicht nicht. `update`/`get_entry` in
  `mock-ipc.js` nachziehen.

## Nicht in diesem Prompt

Vorheriger/nächster Eintrag aus dem Panel, Felder eines Eintrags als Tabelle (braucht die Feld-Extraktion aus der Roadmap),
weitere Formate wie YAML oder SQL.

## Fertig, wenn

- [ ] Tests oben grün, `npm run check`, `npm run contrast` und `npm run e2e` grün
- [ ] Bei 5000 Zeilen/s bleibt das offene Panel stabil auf seinem Eintrag und der Tail läuft ruhig weiter
- [ ] Einstellungen überleben einen Neustart
- [ ] Screenshots mit `scripts/screenshots.mjs` erneuert, neuer Screenshot mit offenem Panel
- [ ] `README.md`, `CLAUDE.md` (Layout, Entscheidung zum Tokenizer) und `docs/roadmap.md` ergänzt
- [ ] Sichttest mit `npm run demo:log` und `npm run demo:app`, sonst im Bericht als offen genannt

Kein Commit ohne Rückfrage.
