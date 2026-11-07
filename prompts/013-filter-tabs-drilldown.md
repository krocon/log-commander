# Prompt 013: Filter als eigener Tab (Drill-down)

> Start in neuer Sitzung: „Führe `prompts/013-filter-tabs-drilldown.md` aus.“
> Voraussetzung: 010 (Ausdrücke). 005 ist hilfreich (Baum zeigt die Kette).
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

Ein Filter lässt sich als neuer Tab öffnen. Der neue Tab zeigt das Ergebnis des alten und filtert darin weiter, Schritt für Schritt:
„app.log › ERROR › OrderService › Request 4711“. Jede Stufe bleibt als Tab offen, man kann zurück und daneben weiterarbeiten.

## Entscheidungen

| Thema | Entscheidung | Warum |
|---|---|---|
| Datenhaltung | **Mehrere Ansichten in einer `LogSession`**, keine zweite Sitzung für dieselbe Datei | Index, Worker, Handles und Encoding gibt es einmal. Eine zweite Sitzung würde die Datei doppelt indexieren und doppelt tailen. |
| Kette | Filter des Kind-Tabs = Filter der Eltern UND eigener Filter, live | Ändert man oben, folgen die Stufen darunter. So stimmt die Kette immer. |
| Freeze | Gilt für die Datei, also für alle Tabs der Kette | Der Worker liest für alle. Die Statusleiste und die Tab-Markierung zeigen das bei allen. |
| Grenze | Höchstens 8 Ansichten je Datei | Jede Ansicht kostet bis zu 4 Byte je Zeile und Zeit je neuer Zeile. |

## Backend

1. **Ansichten:** Was heute in `SessionData` je Sitzung liegt und den Filter betrifft, wandert in `ViewState`: `filter`, `requested_spec`,
   `view_generation`, `filter_pending`, `filter_progress`, Job-Generation (`session.rs:61`). `SessionData.views: Vec<ViewState>`, Ansicht 0
   gibt es immer und verhält sich wie heute.
2. **Alle Stellen mit `data.filter`** bekommen eine `view_id`: `get_lines`, `set_filter`, `find`, `scan`, `position_of_line`, `copy_lines`,
   `update`, `run_filter`, `ingest` (`tail.rs:282`), `retract_provisional` und der Checkpoint der provisorischen Zeile (`session.rs:56`,
   jetzt einer je Ansicht). Mit `rg "\.filter\b"` vollständig finden, jede Stelle im Bericht abhaken.
3. **`ingest`:** Text einer Zeile wird höchstens **einmal** gelesen und dekodiert, auch wenn mehrere Ansichten ihn brauchen. Ergebnisse je Ansicht
   vor der Sperre vorbereiten, `same_matcher` (`tail.rs:308`) je Ansicht prüfen.
4. **Neu-Leveln** (`run_relevel`): danach alle Ansichten neu filtern. `epoch`: alle Ansichten leeren.
5. **Updates:** `SessionUpdate` je Ansicht, bei 8 Ansichten also bis zu 80 Nachrichten pro Sekunde. Deshalb nur geänderte Ansichten senden und jede über
   ihren eigenen Channel (`open_view(session_id, parent_view, expr, on_update) -> ViewInfo`, `close_view`). `close_log` schließt alle.
6. **Kette:** `expr` des Kindes wird mit dem effektiven Ausdruck der Eltern verknüpft und kompiliert. Ändert sich ein Elternteil, starten
   die Jobs aller Nachfahren. Schließen der Eltern: Kinder übernehmen den effektiven Ausdruck, bleiben also gleich.

## Frontend

1. `SessionState` bekommt `viewId` und `parentViewId`. `PageCache` lädt über `view_id`. `tryOpen` entprellt weiter über den Pfad und landet bei Ansicht 0.
2. `LogSessionService.openFilterTab(session, expr?)`: ohne `expr` mit leerem eigenem Filter, sonst etwa „Nur dieser Thread“. Neuer Tab direkt rechts
   neben den Eltern.
3. **Tabs:** Name aus der Kette, gekürzt („…› ERROR › 4711“), voller Pfad im Titel. Einrückung oder Linie zeigt, was zusammengehört. Fehler-Markierung
   (`hasNewErrors`) je Ansicht.
4. **Einstieg:** Button „Als Tab öffnen“ neben dem Filter, im Baum (005) am Knoten, Kontextmenü „In neuem Tab filtern“ (010), Kürzel
   `Cmd/Ctrl+Shift+T`. Bei 8 Ansichten deaktiviert, mit Begründung im Titel.
5. **Baum (005):** Ansichten unter ihrer Datei, die Kette als Unterknoten.
6. Auswahl, Lesezeichen (007) und Scrollposition je Tab. Lesezeichen gelten für die Datei, sie sind Zeilennummern. Empfehlung: geteilt über alle
   Tabs derselben Datei, weil man sie in der Kette wiederfinden will.

## Fallen

- Jeder neue Tab kostet bei aktiver Ansicht ein Filter-Job über den ganzen Index. Bei 500 MB messen, Fortschritt im Tab.
- `sessions.close(id)` schließt heute die Sitzung im Backend (`log-session.service.ts:71`). Das schließt künftig nur eine Ansicht, außer bei der letzten.
- Tauri-Channel je Ansicht muss beim Schließen beendet werden, sonst bleiben Sender bestehen.
- `mock-ipc.js`, e2e und Screenshots sprechen heute nur eine Ansicht.

## Tests

- **Rust:** zwei und acht Ansichten auf dieselbe Datei, Tail mit Filter in jeder, provisorische Zeile, Rotation, Truncation, Freeze, Elternfilter ändert sich,
  Eltern schließen. Ergebnis jeder Ansicht = gleiches Ergebnis in einer Einzelsitzung. Messung Einlesen mit 1, 4, 8 Ansichten.
- **Vitest:** Namen der Kette, Zuordnung der Updates zur Ansicht, Schließen.
- **e2e:** Filter als Tab, darin weiter filtern, Eltern ändern und Kind folgt, Tab schließen ohne Fehler, Tail läuft in allen.

## Fertig, wenn

- [ ] Tests oben grün, `npm run check` und `npm run e2e` grün
- [ ] Mit einer Ansicht exakt die Leistung von heute (`measure_`)
- [ ] `README.md`, `CLAUDE.md` (Entscheidung, Grenze 8), `docs/roadmap.md` ergänzt
- [ ] Sichttest, sonst im Bericht als offen genannt

Kein Commit ohne Rückfrage.
