# 013 – Filter als eigener Tab (Drill-down): Design und Stand

- **Status:** umgesetzt (autonom, ohne Haltepunkt: Marc hat die Prompts zur selbständigen Abarbeitung freigegeben;
  Entscheidungen statt Rückfragen stehen unten)
- **Datum:** 2026-11-07
- **Branch:** `feat/filter-tabs-drilldown`

## Abweichungen des Prompts vom Code

- Zeilenangaben (`session.rs:61`, `tail.rs:282`, `tail.rs:308`, `session.rs:56`, `log-session.service.ts:71`) stammen aus
  einem älteren Stand; die Stellen wurden über `rg "\.filter\b"` gefunden. `same_matcher` heißt heute `TextTest::same`.
- Die alte eigene Ansicht gibt es nicht mehr, die Ansicht ist die GuiExpert Table (`features/log-table/`); sie war nicht
  betroffen, nur `overview-ruler.ts`, Detail-Panel und Dashboard rufen das Backend mit `sessionId`/`viewId`.

## Stellen mit `data.filter` (Prompt Backend 2)

| Stelle | jetzt |
|---|---|
| `get_lines` | `get_lines_of(view, …)` |
| `set_filter` / `set_filter_expr` | `set_view_filter(view, ViewFilter)`, Kette, Jobs aller Nachfahren |
| `find` / `scan` | `find_in(view, …)`, `scan` mit `view` (geschlossene Ansicht: nichts) |
| `position_of_line` | `position_in(view, line)` |
| `overview` / `find_level` | `overview_of(view, …)`, `find_level_in(view, …)` |
| `copy_lines` | `copy_lines_of(view, …)`, `copy_all_lines` ohne Ansicht |
| `update` | `update_of(view)`, `take_updates` (je Ansicht, eigener Sink) |
| `run_filter` | je Ansicht, eigener Job-Zähler, setzt Checkpoint der provisorischen Zeile |
| `ingest` (`tail.rs`) | Proben aller Ansichten vor der Sperre, Text einmal dekodiert (`TextTest::probe_many`), `Fresh` |
| `retract_provisional` / Checkpoint | `Provisional { prev }`, Checkpoint je Ansicht (`ViewState::provisional`), `mark_provisional` |
| `commit_partial_now` (`tail.rs`) | `mark_provisional` + `push_line` mit `probe_many` |
| `emit_if_due` (`tail.rs`, `merge.rs`) | `Shared::emit` |
| `merge.rs` `refresh_matcher` / `write` | Ansicht 0 vorab geprüft wie bisher, weitere über `Fresh` beim Schreiben |
| `run_relevel` | danach Format tauschen, neue `viewGeneration` aller Ansichten, wartende Filter-Jobs starten |
| `reset_index` (`epoch`) | leert alle Ansichten |

## Entscheidungen (statt Haltepunkt)

| Frage | Optionen | Entscheidung | Grund |
|---|---|---|---|
| Zusammensetzen der Kette | (a) Frontend schickt den ganzen Ausdruck, (b) Backend kennt Eltern und setzt zusammen | (b) `views.rs::compose` | Prompt: „live, ändert man oben, folgen die Stufen“. Das Backend startet die Jobs der Nachfahren ohne Umweg; ein ungültiger Filter wird für die ganze Kette vorher geprüft und ändert nichts. |
| Wie wird verknüpft | eigene Matcher-Liste in `FilterSpec` vs. ein Ausdruck | Level und Quellen schneiden, Bäume und **filternde** Suchen der Eltern als `Text`-Bedingungen in einem UND vor dem eigenen Baum | Kein neuer Pfad in `FilteredLines`, Ansicht 0 bleibt bitgleich (`exakt die Leistung von heute`). Suche der Eltern im Modus „Hervorheben“ filtert nicht und gehört nicht zur Kette. Grenze 64 Bedingungen gilt für die Kette zusammen. |
| Schließen der Eltern | Kinder neu filtern vs. Filter weiterreichen | `inherited` am Kind, kein Job | „Kinder übernehmen den effektiven Ausdruck, bleiben also gleich“. Das Frontend hält die Namen der geschlossenen Stufen (`inherited`), der Baum des Kindes zeigt weiter nur den eigenen Filter. |
| Tab der Datei (Ansicht 0) schließen, Filter-Tabs bleiben | alles schließen vs. Ansicht 0 verstecken | Ansicht 0 wird versteckte Identität ohne Channel und ohne Liste | „Ansicht 0 gibt es immer“; die Kinder bleiben. Öffnet man die Datei wieder, landet man beim ersten verbliebenen Tab der Datei (`tabOfFile`, sonst Ansicht 0). |
| Updates je Ansicht | immer alle senden vs. nur geänderte | nur geänderte; eine weitere Ansicht, deren eigener Stand gleich blieb (nur die Datei wuchs), höchstens 1×/s | Prompt: 8 Ansichten × 10/s = 80 Nachrichten. Ansicht 0 sendet wie bisher. Gemessen: 7 weitere Ansichten, ~6 s Einlesen + 3 s Tail = 421 Nachrichten (vorher wären es bis ~630). |
| Jobs | ein Job für alle vs. je Ansicht | je Ansicht eigener Zähler (`ViewState::job`), Neu-Leveln einmal je Sitzung (`job_generation`), danach starten die wartenden Filter (`awaiting_relevel`) | Ein Filterwechsel in Tab 3 bricht den Job von Tab 2 nicht ab. Früher brach ein Filter das Neu-Leveln ab und begann es neu; jetzt wartet er darauf. |
| Merge | Ansichten verbieten vs. erlauben | erlaubt; Ansicht 0 wie bisher vorab geprüft, weitere lesen den Text beim Schreiben unter der Sperre (einmal je Zeile für alle) | Der `Merger` hält eine Probe je Zeile; mehrere würden den Haltepuffer vergrößern. Live ist das wenig Text; als Grenze dokumentiert. |
| Lesezeichen | je Tab vs. je Datei | je Datei (ein Signal, geteilt) | Empfehlung des Prompts: man will sie in der Kette wiederfinden. |
| Fehler-Markierung | `counts` vs. `viewCounts` | Tab der Datei wie bisher `counts`, Filter-Tab `viewCounts` | „je Ansicht“; der Tab der Datei verhält sich wie vorher. |
| Freeze, Profil, Spalten, Dashboard | je Tab vs. je Datei | je Datei | Prompt (Freeze); Profil und Format sind Sache der Sitzung. Dashboard-Datenbank gibt es je Sitzung; Schließen des Dashboards in einem Tab pausiert den Aufbau für alle (Roadmap). |
| Dashboard-Säule ohne Zeitachse (012) | Filter im selben Tab vs. Filter-Tab | Filter-Tab unter dem Tab des Dashboards | Roadmap-Punkt „Säule ohne Zeitachse als Filter-Tab (013)“; der Dashboard-Tab bleibt, wie er ist. |
| Einstieg | – | Toolbar „⧉ Als Tab“, `Cmd/Ctrl+Shift+T` (frei, geprüft gegen README, `app.ts`, `log-table-view.ts`, Menü), Baum „⧉ Tab“ am „Aktiver Filter“ und `T` auf Datei/Ansicht/Filter-Knoten, Kontextmenü „In neuem Tab filtern auf …“ und „In neuem Tab: Spalte = …“, Dashboard-Säule. Bei 8 Tabs deaktiviert, Grund im Titel | |
| Tab-Name | – | „app.log › ERROR › 4711“, ab 4 Teilen „…› OrderService › 4711“, Teile über 24 Zeichen gekürzt; ganzer Pfad im Titel; leerer eigener Filter heißt „Alle“; gestrichelte Linie und `↳` vor dem Tab (vorhandene Tokens) | |
| Farben | neue Tokens vs. vorhandene | vorhandene (`--text-dim`) | Kein neues Kontrastpaar. |

## Messwerte (500 MB, 5,1 Mio. Zeilen, Release, M-Mac; `measure_` vorher/nachher)

| | vorher | nachher |
|---|---|---|
| Erste Zeilen | 25 ms | 24 ms |
| Ganz eingelesen (1 Ansicht) | 2,26 s | 2,18 s |
| Level-Filter | 37 ms | 37 ms |
| Suchfilter | 0,76 s | 0,78 s |
| Baum 1/5/20 Text-Blätter | 0,82/0,88/1,08 s | 0,89/0,83/0,96 s |
| `get_lines` 200 zufällig | 302 µs | 307 µs |
| `get_lines` 5000 mit/ohne Layout | 7,6/1,26 ms | 7,6/1,22 ms |
| `get_overview` ERROR/Identität | 244/169 µs | 250/165 µs |
| `find_level` FATAL ohne Treffer ERROR/Identität | 176/135 µs | 176/124 µs |
| Tail 10 000 Zeilen/s, 3 s | 29 Updates | 29 Updates |

`measure_views_500mb` (`views_integration`), Ansichten öffnen während des Einlesens, ihre Jobs laufen parallel:

| Ansichten | Einlesen + alle Filter fertig | Listen (4 Byte je gezeigte Zeile) | Tail 30 000 Zeilen in 3 s |
|---|---|---|---|
| 1 | 2,20 s | 0 MB | 3,13 s (ohne Rückstand) |
| 4 | 3,58 s | 9 MB | 3,12 s, 161 Updates der weiteren Ansichten |
| 8 | 4,63 s | 32 MB | 3,12 s, 421 Updates der weiteren Ansichten |

Speicher je weiterer Ansicht: höchstens 4 Byte je Zeile (`Vec<u32>`), bei 5,1 Mio. Zeilen also ≤ 19,5 MB; eine Identität
kostet nichts. Begrenzt durch `MAX_VIEWS = 8`.

## Tests

- Rust `tests/views_integration.rs`: zwei Ansichten (Kette, Tail, eigener Channel), acht Ansichten (Kette und Geschwister,
  neunte → `too_many_views`), provisorische Zeile, Rotation und Truncation, Freeze, Elternfilter ändert sich (auch
  ungültig: nichts ändert sich), Eltern schließen (auch Ansicht 0), Neu-Leveln; Vergleich jeweils mit einer Einzelsitzung
  und dem zusammengesetzten Filter. `merge_integration`: Ansicht eines Merges, live. `views.rs`: Zusammensetzen.
- Vitest: `view-chain.spec.ts` (Namen, Kürzen, Grenze, Einfügen, Weiterreichen), Service (Öffnen rechts neben den Eltern,
  Name, Filter an die eigene Ansicht, Updates je Ansicht, Schließen mit Weiterreichen und letzter Tab, neunter Tab, Datei
  erneut öffnen, Fehler-Markierung je Ansicht, Dashboard-Säule), `tree-model.spec.ts` (Kette als Unterknoten),
  `row-menu.spec.ts`.
- e2e (`scenario.js`, Ende): `⌘⇧T` öffnet rechts neben den Eltern, darin weiter filtern, Tail in beiden, Eltern ändern →
  Kind folgt und zurück, Tab schließen ohne Fehler, Eltern laufen weiter.

## Fortschritt

- [x] Phase 1: Bestand, Entscheidungen (oben)
- [x] Phase 2: Rust (`views.rs`, `session.rs`, `tail.rs`, `merge.rs`, Commands `open_view`/`close_view`, `viewId`)
- [x] Phase 3: Frontend (`view-chain.ts`, `SessionState`, `LogSessionService`, Tabs, Toolbar, Baum, Kontextmenü, Kürzel,
  Dashboard, Mock)
- [x] Phase 4: e2e (einmal am Ende)
- [x] Phase 5: Doku (README, CLAUDE.md, architecture, roadmap, themes), Screenshot `drilldown.png`
- [x] Phase 6: `npm run check`, `npm run contrast`, `npm run e2e`

## Nur von Hand prüfbar / offen

- Sichttest mit `demo:log`/`demo:app` (hell, dunkel, schmal) nicht gemacht; Screenshot im Mock dunkel angesehen.
- Kontextmenü per echtem Rechtsklick, Zwischenablage (Kopieren aus einem Filter-Tab) nur von Hand.
- Windows/Linux nicht geprüft (nichts Plattformspezifisches geändert).
