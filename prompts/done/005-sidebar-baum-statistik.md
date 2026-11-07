# Prompt 005: Seitenleiste mit Baum und Statistik

> Start in neuer Sitzung: „Führe `prompts/005-sidebar-baum-statistik.md` aus.“
> Voraussetzung: 004 (Splitter). Falls 004 noch offen ist, zuerst dort den Splitter umsetzen, nicht zwei bauen.
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

Links neben Log-Ansicht und Detail-Panel steht eine Seitenleiste: oben ein Baum mit Dateien und Filtern, unten eine Statistik
mit den Spalten „Alle“ und „Ansicht“. Sie ist in der Breite verschiebbar und lässt sich ein- und ausblenden, die Trennung
zwischen Baum und Statistik ist ebenfalls verschiebbar.

```
Tabs · Toolbar (volle Breite)
┌───────────┬──────────────────┐
│ Baum      │ Log-Ansicht      │
├╌╌╌╌╌╌╌╌╌╌╌┤                  │
│ Statistik ├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤
│           │ Detail           │
└───────────┴──────────────────┘
Statusleiste
```

## Entscheidung: Was der Baum zeigt

**Erste Stufe:** Dateien, der aktive Filter und gespeicherte Filter.

```
▾ app.log                   ● live
   ▾ Aktiver Filter            [Speichern]
       WARN, ERROR, FATAL   ×
       „timeout“            ×
▸ nginx-error.log           ● eingefroren
▾ Gespeicherte Filter
     Nur Fehler
     Timeouts
```

Bewusst **nicht** Teil dieser Stufe:

- **Verschachtelte Filter**, bei denen jeder Knoten das Ergebnis des Elternknotens weiter einschränkt. `FilterSpec` kennt genau
  einen Filter je Sitzung (`filter.rs:100`). Eine Hierarchie wäre ein Umbau des Filter-Backends mit eigenem Prompt.
- **Thread, Logger, Klasse als Knoten oder Statistik-Zeilen.** Der Index speichert je Zeile nur Offset, Länge und Level
  (`indexer.rs:26`). Diese Felder braucht zuerst die Feld-Extraktion aus `docs/roadmap.md`.
- **Zeitfilter** (Roadmap „Zeitfenster“). Sie brauchen die Zeitstempel aus 006.

Die Tabs bleiben. Der Baum ist eine zweite Sicht auf denselben Zustand, keine zweite Quelle: Alles schreibt über
`LogSessionService` und liest aus `SessionState`.

## Backend: Zähler der Ansicht

Heute gibt es nur `counts` über alle Zeilen (`model.rs:58`). Für die Spalte „Ansicht“ fehlt das Level je gefilterte Zeile.

1. `SessionUpdate` bekommt `view_counts: LevelCounts`, DTO und `mock-ipc.js` nachziehen.
2. `FilteredLines` führt Zähler in `append` (`filter.rs:227`). Bei Identität (`list` ist `None`) kehrt `append` vorher zurück,
   dann liefert `SessionData::update` (`session.rs:111`) einfach `index.counts`.

**Die Falle:** Ein Treffer im Stacktrace nimmt nachträglich Kopf und Zwischenzeilen auf (`list.extend(entry_start..=line)`,
`filter.rs:255`). Deren Levels kennt `append` an dieser Stelle nicht mehr. Deshalb seit `entry_start` einen Zwischenzähler
mitführen und ihn beim Aufnehmen des Eintrags addieren. Beide Zähler gehören in `FilterCheckpoint` (`filter.rs:146`), sonst
stimmen sie nach dem Zurückziehen der provisorischen Zeile nicht mehr. `clear` setzt sie zurück. Der Job in `run_filter`
(`session.rs:677`) befüllt seine eigene Liste über denselben Weg, das prüfen.

Während `filter_pending` gehören die Werte noch zum alten Filter, so wie `filtered_lines`. Das Frontend zeigt dann „…“.

## Frontend

1. **Layout:** in `app.ts` Seitenleiste, Splitter und die Spalte aus 004 nebeneinander. Mindestbreiten: Leiste 180 px,
   Log-Ansicht 360 px. Das Fenster kann 720 px schmal werden (`tauri.conf.json`), unter 900 px blendet sich die Leiste
   automatisch aus, ohne die Einstellung zu ändern. Ohne offene Sitzung keine Leiste.
2. **Baum** `src/app/features/sidebar/log-tree.ts`: Knoten als reine Funktion aus Sitzungen und Settings berechnen
   (`tree-model.ts` mit Spec), Komponente zeichnet nur. Klick auf eine Datei aktiviert den Tab. Status, Fehler-Markierung und
   Freeze-Markierung wie in `tabs.ts`, gemeinsamen Teil herausziehen statt kopieren. Lange Namen mit Ellipse und Titel.
3. **A11y des Baums:** `role="tree"`, `treeitem`, `aria-expanded`, `aria-level`, roving `tabindex`, Pfeiltasten nach WAI-ARIA.
4. **Aktiver Filter:** Knoten nur, wenn etwas eingeschränkt ist. `×` setzt Levels auf `ALL_LEVELS` oder leert die Suche.
5. **Gespeicherte Filter:** `savedFilters` in den Settings (`{ id, name, levels, query, mode }`), Levels als Array, weil `Set`
   nicht serialisiert wird. Klick wendet auf den aktiven Tab an, löschen per `×`. Name über ein Eingabefeld direkt im Baum, nicht
   `window.prompt`. Ungültige Regex aus einem alten Eintrag läuft in den vorhandenen `searchError`.
6. **`applyPreset`** im Service: Levels, Query und Modus setzen und dann **einmal** `applyFilter`. Nacheinander `setLevels` und
   `setQuery` würden zwei Filter-Jobs starten. Einen noch laufenden Debounce der Suche in `toolbar.ts:347` beachten, er darf den
   Preset nicht überschreiben.
7. **Statistik** `stats-panel.ts`: Tabelle mit echten `<th scope>`, Zeilen „Zeilen“, TRACE bis FATAL, „Ohne Level“, Spalten „Alle“
   und „Ansicht“, `formatCount`, `font-variant-numeric: tabular-nums`. Klick auf ein Level filtert darauf (`onlyLevel`), Alt-Klick
   schaltet es um, gleiches Verhalten wie bei den Chips. Zusätzlich Dateigröße. Zähler sollen zu den Level-Chips passen.
8. **Bedienung:** Toolbar-Button, `Cmd/Ctrl+B` in `onKey` von `app.ts`.
9. **Settings:** `sidebarVisible`, `sidebarWidth`, `sidebarTreeShare`, Vorgaben in der Merge-Logik. Farben nur in `styles.css`.

## Fallen

- `onKey` in `log-view.ts:350` hängt am `document`. Pfeile im Baum würden die Log-Ansicht mitbewegen: `[role=tree]` und die
  Statistik dort ausnehmen.
- Die Statistik ändert sich bis zu 10-mal pro Sekunde. Nur Text ändern, kein Neuaufbau der Tabelle, sonst leidet der Tail.
- `Space` und `Enter` auf Buttons im Baum dürfen nicht das Follow umschalten (`log-view.ts:370`).
- Schmalere Log-Ansicht: `heights` hängt schon an `viewportW` (`log-view.ts:223`), beim Ziehen also nicht je Pixel neu messen lassen,
  wenn das bei `wrapLines` ruckelt. Beim Sichttest gezielt prüfen.
- `scripts/screenshots.mjs` erzeugt `narrow.png`: Das Ausblenden unter 900 px muss dort sichtbar stimmen.

## Tests

- **Rust** (`filter.rs`, `tail_integration.rs`): Zähler für Level-Filter, Suche mit Treffer im Stacktrace, Checkpoint und
  Rückzug der provisorischen Zeile, Filterwechsel, Identität gleich `counts`, Neu-Leveln nach Profilwechsel, Summe der Spalte
  „Ansicht“ gleich `filtered_lines`.
- **Vitest:** `tree-model` (Knoten, Sortierung, leere Fälle), `applyPreset` ruft den Filter genau einmal, Serialisierung von
  `savedFilters`, Merge der Settings.
- **e2e:** Leiste umschalten, Datei über den Baum wechseln, Filter per `×` entfernen und Toolbar zeigt das, Filter speichern und
  anwenden, Statistik stimmt für eine bekannte Datei aus `samples/`, Klick auf ERROR filtert.

## Nicht in diesem Prompt

Verschachtelte Filter, Thread und Logger, Tortendiagramme, Lesezeichen und Notizen (die Icons unter der Statistik im Vorbild).

## Fertig, wenn

- [ ] Tests oben grün, `npm run check`, `npm run contrast` und `npm run e2e` grün
- [ ] 5000 Zeilen/s mit offener Leiste und offenem Panel: kein spürbarer Unterschied zu heute, im Bericht gemessen oder beschrieben
- [ ] Layout überlebt Neustart, Fenster auf 720 × 400 bleibt bedienbar
- [ ] Screenshots erneuert, `README.md`, `CLAUDE.md` (Layout) und `docs/roadmap.md` ergänzt
- [ ] Sichttest mit `npm run demo:log` und `npm run demo:app`, sonst im Bericht als offen genannt

Kein Commit ohne Rückfrage.
