# Prompt 007: Overview Ruler und Navigation

> Start in neuer Sitzung: „Führe `prompts/007-overview-ruler.md` aus.“
> Unabhängig von 005 und 006. Das Kürzel und der Button aus Teil B ergänzen sich mit 004, setzen es aber nicht voraus.
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

**Teil A, Overview Ruler:** Rechts neben der Log-Ansicht zeigt eine schmale Leiste über die ganze Höhe, wo in der aktuellen
Ansicht Fehler, Warnungen und Lesezeichen liegen und wo die gewählte Zeile steht. Ein Klick springt dorthin.

**Teil B, Navigation aus dem Filter:** Aus einer gefilterten Ansicht führt ein Schritt zur selben Zeile im vollständigen Log und
wieder zurück.

**Für beide gilt:** Navigation lässt die gewählte Zeile unverändert. Man springt zum Nachsehen weg und findet zurück.

## Entscheidungen

| Thema | Entscheidung | Warum |
|---|---|---|
| Koordinaten | Der Ruler bildet Positionen der **aktuellen Ansicht** ab, nicht Zeilen der Datei | Die Scrollleiste tut das auch (`displayedLines`). Mit ERROR-Filter wären Marken sonst gegen den Balken versetzt. |
| Daten | Laufend geführte Zusammenfassung im Backend, kein Scan je Abfrage | Bei 10 Updates pro Sekunde und vielen Millionen Zeilen darf eine Abfrage nicht den Index durchlaufen. |
| Zeichnen | Ein `<canvas>`, kein Element je Marke | Hunderte Marken bis 10-mal pro Sekunde im DOM würden den Tail bremsen. |
| Lesezeichen | Einfache Lesezeichen je Tab im Speicher des Frontends, Umschalten mit `M` | Der Ruler braucht sie laut Vorbild. Dauerhaft gespeicherte Lesezeichen und Notizen bleiben Roadmap, weil Zeilennummern über Neustarts nicht stabil sind. |
| „Zum Gesamtlog“ | Kürzel `G` und Button, **nicht** Doppelklick | Doppelklick öffnet laut 004 das Detail-Panel. Dieselbe Geste darf nicht je nach Filter etwas anderes tun. |

## Teil A: Backend

### Zusammenfassung

Neue Datei `src-tauri/src/overview.rs`, frei von Tauri:

```rust
pub struct LevelSummary {
    chunks: Vec<u8>,   // Bit je Level, das im Abschnitt vorkommt
    chunk_size: u32,   // Zeilen je Abschnitt, beginnt bei 16
    open_mask: u8,
    open_len: u32,
}
```

- `push(level)` sammelt im offenen Abschnitt. Überschreitet `chunks` 64 K Einträge, werden je zwei zusammengelegt (ODER) und
  `chunk_size` verdoppelt. Der Speicher bleibt so bei höchstens 64 KB, und die Auflösung ist immer feiner als jede Leistenhöhe.
- `buckets(lines, n) -> Vec<u8>` legt die Abschnitte auf `n` Pixel-Eimer um, ohne Zeilen anzufassen.

Zwei Instanzen, weil es zwei Fälle gibt:

1. **`LineIndex`** führt immer eine. Sie gilt, wenn die Ansicht Identität ist. Das ist nötig, weil `start_job` eine
   Identität sofort unter der Schreibsperre herstellt (`FilteredLines::identity`, `session.rs:356`). Dort ist kein Scan möglich.
2. **`FilteredLines`** führt eine für die gefilterte Liste, gefüllt in `append` (`filter.rs:227`).

### Fallen in der Zusammenfassung

- **Nachträglich aufgenommene Zeilen:** `list.extend(entry_start..=line)` (`filter.rs:255`) nimmt Zeilen auf, deren Level `append`
  dort nicht mehr kennt. Seit `entry_start` Level und Anzahl mitführen und beim Aufnehmen buchen. Hat 005 hier schon einen
  Zwischenzähler eingeführt, denselben nutzen.
- **Provisorische Zeile:** `pop` und `restore` machen eine Zeile rückgängig (`session.rs:93`). Den offenen Abschnitt in den
  `FilterCheckpoint` aufnehmen. Wurde dabei ein Abschnitt abgeschlossen, darf ein Bit stehen bleiben: Die Zeile kommt praktisch
  immer gleich wieder. Der Sprung sucht exakt (unten) und verträgt das.
- **Neu-Leveln:** `index.replace` (`indexer.rs:77`) ändert Levels, ein ODER lässt sich nicht zurückrechnen. `run_relevel`
  (`session.rs:618`) baut parallel eine neue Zusammenfassung und tauscht sie am Ende. Der gefilterte Fall läuft ohnehin über
  den folgenden Filter-Job.
- `clear` setzt beide zurück. Die Kosten je Zeile sind wenige Rechenschritte, trotzdem `measure_` vorher und nachher vergleichen.

### Befehle

- `get_overview(session_id, buckets, lines) -> Overview` mit `{ viewGeneration, epoch, count, buckets: Vec<u8>, marks: Vec<Mark> }`.
  `lines` sind die Zeilennummern von Auswahl und Lesezeichen, `Mark` ist `{ line, position, visible }`, `visible` heißt
  `line_at(position) == line`, denn `position_of` liefert sonst die nächste Position (`filter.rs:192`). `count` kommt mit, damit
  Marken und Nenner immer zusammenpassen. Höchstens 10.000 `lines`, `buckets` höchstens 8192. Nur Lesesperre, nicht über
  `blocking`, falls die Messung das erlaubt.
- `find_level(session_id, from_position, forward, levels) -> Option<FindHit>`: nächste Position mit passendem Level, ohne Text zu
  lesen. Abschnitte ohne passendes Bit überspringen, im Rest über `line_at` und `index.entries` exakt suchen, am Ende einmal
  herumlaufen (`wrapped`, wie `FindHit` in `model.rs:114`). Nur Köpfe zählen, nicht Fortsetzungszeilen, sonst landet ein
  Stacktrace mit 50 Zeilen 50-mal im Treffer.

## Teil A: Frontend

1. **Platz:** `.scroller` (`log-view.css:8`) behält seine Scrollleiste. Rechts daneben liegt die Leiste, 14 px breit. `:host` in
   `log-view.css` wird dafür eine Zeile. `ResizeObserver` (`log-view.ts:241`) misst weiter am Scroller und bleibt richtig.
2. **Komponente** `features/log-view/overview-ruler.ts`, OnPush. Rechnen als reine Funktion in `ruler-logic.ts` mit Spec:
   Position auf Pixel und zurück, Eimer auf Marken, Vorrang FATAL vor ERROR vor WARN, Mindesthöhe 3 px, sichtbar auch bei einer
   einzigen Fehlerzeile unter vielen Millionen.
3. **Zeichnung:**
   - Marken in Level-Farbe, ganze Breite. Dazu ein Band für den sichtbaren Bereich: macOS blendet die Scrollleiste aus, ohne
     Band fehlt dort die Orientierung.
   - Lesezeichen als kleines Fähnchen, Auswahl als Dreieck vom Rand. Beide über den Level-Marken.
   - Am unteren Ende ein echter `<button>` „Ans Ende“ mit Pfeil, Zustand `aria-pressed` je nach Follow. Er ruft `jumpToEnd`. Der
     vorhandene Badge „N neue Zeilen“ bleibt.
   - Marken unterscheiden sich nicht nur über Farbe: Tooltip mit Text („3 ERROR, 12 WARN“, Zeilenbereich).
4. **Canvas:** `devicePixelRatio` beachten, Neuzeichnen in `requestAnimationFrame` gebündelt und nur bei geänderten Daten. Farben
   per `getComputedStyle` aus Tokens lesen und bei Themewechsel neu holen, sonst bleibt der Ruler in den alten Farben. Neue Tokens
   nur in `styles.css`, beide Themes, `npm run contrast` (Grafik mindestens 3:1 zum Hintergrund).
5. **Laden:** höchstens 2-mal pro Sekunde und nur bei geänderter `count`, `viewGeneration`, `epoch`, Auswahl, Lesezeichen oder
   Höhe. `buckets` entspricht der Höhe in CSS-Pixeln. Überholte Antworten verwerfen. Im Freeze ändert sich nichts, also keine Last.
   Antwort mit fremder `epoch` oder `viewGeneration` nicht zeichnen. Gezeichnet wird mit dem `count` der Antwort, das Band mit
   `displayedLines`.
6. **Klick:** Liegt unter dem Zeiger eine Marke, sucht `find_level` die exakte Zeile im Eimer. Ohne Marke geht es an die anteilige
   Position. Lesezeichen und Auswahl haben Vorrang. Immer `setFollow(false)` und `scroll.set({ top: max(0, position - 5), subPx: 0 })`
   wie in `find` (`log-session.service.ts:167`). **`selection` bleibt unverändert.**
7. **Lesezeichen:** `SessionState.bookmarks` als Signal mit `ReadonlySet<number>` aus Zeilennummern. `M` schaltet für den
   Kopf des gewählten Eintrags um. Sichtbar im `.mark` der Zeile (`log-view.ts:76`). Neue `epoch` leert sie, wie die Auswahl in
   `session-state.ts:140`. Mit 006: Der Index wird neu aufgebaut, dasselbe.
8. **Tastatur:** `E` und `Shift+E` nächster und vorheriger Fehler, `W` und `Shift+W` Warnung und schwerer, `N` und `Shift+N` nächstes
   und vorheriges Lesezeichen (Lesezeichen im Frontend, kein IPC), `M` umschalten. In `onKey` (`log-view.ts:350`) ergänzen,
   `f`, `p` und `d` sind belegt. Scrollposition wie beim Klick, Meldungen über `showFindMessage`. Der Ruler selbst ist `aria-hidden`,
   weil diese Wege dasselbe per Tastatur können.
9. **Einstellung:** `showOverviewRuler` in `settings.models.ts` und im Dialog, Standard an.

## Teil B: Navigation aus dem Filter

1. **`revealInFullLog(session)`** im Service, über `G` und einen Button, der erscheint, wenn ein Filter aktiv ist und eine Zeile
   gewählt ist (in der Toolbar, mit 004 auch im Kopf des Panels). Filter merken, Levels und Filter-Suche in **einem** Aufruf von
   `applyFilter` aufheben, dann zur gewählten Zeile scrollen, Follow aus. Mit 006 gehört die Quellenmaske dazu.
2. **`returnToFilter(session)`:** Button „Zurück zum Filter“ und nochmal `G`. Stellt den gemerkten Filter her und zeigt die gewählte
   Zeile, falls sie dort vorkommt. Ändert der Nutzer in der Zwischenzeit selbst den Filter, verfällt das Gemerkte.
3. **Die Hauptfalle:** Der Scroll zur Zeile darf erst gelten, wenn die neue Ansicht wirklich da ist. `position_of` liefert bis zum
   Tausch die Position im alten Filter, und `onViewChanged` (`session-state.ts:173`) verankert auf der obersten Zeile statt
   der gewählten. Deshalb `pendingReveal: number | null` in `SessionState`: `onViewChanged` nimmt es vorrangig und führt den vorhandenen
   Weg über `getPosition` aus. Dessen Prüfung „der Nutzer hat inzwischen gescrollt“ bleibt wirksam. Der Identitätsfall kommt
   ebenfalls über eine neue `viewGeneration`, das testen. Gleiche `viewGeneration` (Filter war schon leer): direkt scrollen.
4. **Highlight-Modus:** Die Suche filtert dort nicht und bleibt erhalten, Markierungen auch.
5. Auswahl bleibt erhalten, sie läuft ohnehin über Zeilennummern und übersteht den Filterwechsel.

## Tests

- **Rust, rein** (`overview.rs`): Verdichten bei wachsender Zeilenzahl ohne verlorene Bits, Eimer an Grenzen, einzelne Fehlerzeile
  in 10 Mio. Zeilen, leer, `n` größer als Zeilen.
- **Rust, Integration:** Filter mit Treffer im Stacktrace, Rückzug der provisorischen Zeile, Identität nach Filter, Neu-Leveln,
  Truncation, Rotation. `find_level` vor, zurück, Umlauf, nur Köpfe, kein Treffer. `visible` bei ausgefilterter Zeile. Neue
  `measure_`-Messung: `get_overview` und `find_level` bei 500 MB.
- **Vitest:** `ruler-logic` (Abbildung beidseitig, Vorrang, Mindesthöhe, Klick auf Marke), Lesezeichen samt Epoch-Reset,
  `pendingReveal` in `session-state.spec.ts` mit überholender Scrollbewegung.
- **e2e:** Klick auf eine ERROR-Marke zeigt die Zeile und die Auswahl bleibt gleich, Filter auf ERROR ordnet Marken neu, `E` springt
  auf eine ERROR-Zeile, `M` und `N`, `G` und zurück zeigen dieselbe gewählte Zeile, Ruler im Tail ohne Auffälligkeit. Canvas-Pixel nicht
  auswerten, sondern die Daten über `data-`-Attribute oder Logik prüfen. `mock-ipc.js` nachziehen.

## Nicht in diesem Prompt

Treffer der Suche im Ruler (im Highlight-Modus nur mit Textscan möglich, eigener Hintergrund-Job, wahrscheinlich die nächste
Nachfrage, in die Roadmap), dauerhaft gespeicherte Lesezeichen und Notizen, Ziehen im Ruler, Mini-Vorschau beim Hover, eigene
Regex-Marker.

## Fertig, wenn

- [ ] Tests oben grün, `npm run check`, `npm run contrast` und `npm run e2e` grün
- [ ] `measure_`-Werte fürs Einlesen nicht spürbar schlechter, neue Werte im Bericht
- [ ] 5000 Zeilen/s mit offenem Ruler laufen ruhig, hell und dunkel geprüft
- [ ] Ein Klick zum Fehler und `G` hin und zurück lassen die gewählte Zeile unverändert
- [ ] Screenshots erneuert, `README.md` (Kürzel), `CLAUDE.md` (Entscheidungen, Layout `overview.rs`) und `docs/roadmap.md` ergänzt
- [ ] Sichttest mit `npm run demo:log` und `npm run demo:app`, sonst im Bericht als offen genannt

Kein Commit ohne Rückfrage.
