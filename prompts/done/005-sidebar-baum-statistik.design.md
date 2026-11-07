# 005 Seitenleiste mit Baum und Statistik – Design und Entscheidungen

- **Status:** umgesetzt (autonom nach Auftrag von Marc, Entscheidungen statt Haltepunkten unten festgehalten)
- **Datum:** 2026-11-07
- **Branch:** `feat/sidebar-baum-statistik`

## Abweichungen des Prompts vom heutigen Code

Der Prompt stammt aus der Zeit des eigenen Viewports. Zuordnung:

| Prompt | Heute |
|---|---|
| `filter.rs:100` `FilterSpec`, `:146` `FilterCheckpoint`, `:227` `append`, `:255` `list.extend` | gleiche Namen in `filter.rs` (Zeilen verschoben) |
| `session.rs:111` `SessionData::update`, `:677` `run_filter` | `SessionData::update` (~`:142`), `run_filter` (~`:844`), unverändert über `feed` → `append` |
| `model.rs:58` `counts` | `SessionUpdate.counts`, daneben jetzt `view_counts` |
| `indexer.rs:26` Index | `LineEntry`, weiterhin 16 Byte je Zeile |
| `log-view.ts:350`/`:370` `onKey` am `document`, Space/Enter | `onKey` in `log-table-view.ts`: nimmt jetzt auch `[role=tree]` und `.stats` aus |
| `log-view.ts:223` `heights` an `viewportW`, `wrapLines` | gibt es nicht mehr (feste Zeilenhöhe). Stattdessen: Die Tabelle folgt ihrem Host erst nach 500 ms; `draw()` zeichnet jetzt auch bei neuer **Breite** hart neu (wie seit 004 bei neuer Höhe) |
| `toolbar.ts:347` Debounce der Suche | `onSearchInput` in `toolbar.ts`, abgesichert über `SessionState.presetRevision` |
| Splitter aus 004 | `shared/splitter.ts` wiederverwendet (vertikal für die Breite, horizontal für Baum/Statistik) |

## Entscheidungen (statt Rückfrage)

| Frage | Optionen | Entscheidung | Grund |
|---|---|---|---|
| Vorgabe `sidebarVisible` | an / aus | an | Neue Funktion soll sichtbar sein; unter 900 px weicht sie ohnehin. |
| Zähler im Hot Path | a) Zwischenzähler-Array je Zeile, b) Kopf-Level getrennt + Array nur für Fortsetzungen (`entry_pending`), c) lazy aus der Liste zählen | b) | a) kostete messbar mehr; c) braucht Zugriff auf den Index und Sonderfälle beim Zurückziehen. b) kostet ~0,35 ns je Zeile. |
| Was zählt „Ansicht“ | Einträge / Zeilen | Zeilen je eigenem Level (wie `counts`) | Summe = `filtered_lines`, passt zu Chips und Statusleiste. |
| Cmd/Ctrl+B im schmalen Fenster | Einstellung umschalten / vorübergehend zeigen | vorübergehend (`override`, nicht gespeichert, verfällt ab 900 px) | „ohne die Einstellung zu ändern“; im breiten Fenster bleibt die Leiste so, wie eingestellt. |
| Klick/Alt-Klick in der Statistik | wie Chips (Klick an/aus) / wie Prompt | wie Prompt: Klick nur dieses Level, Alt-Klick an/aus | Prompt nennt das ausdrücklich; in einer Zählertabelle ist „nur dieses“ die häufige Absicht. Titel erklärt beides. |
| Suche im Highlight-Modus | Knoten / kein Knoten | Knoten mit Zusatz „hervorheben“ | Sie wirkt sichtbar und lässt sich mit speichern. |
| Gleicher Name beim Speichern | Duplikat / ersetzen | ersetzen (ohne Groß-/Kleinschreibung), Id bleibt | Keine zwei gleich benannten Einträge. |
| Gespeicherte Filter ohne Einträge | leere Gruppe / keine | keine Gruppe | Weniger Rauschen; Einstieg ist „Speichern“ am aktiven Filter. |
| Tastatur im Baum | Buttons in der Tab-Reihenfolge / Tasten | Buttons `tabindex=-1`, `Enter` auf „Aktiver Filter“ speichert, `Entf`/`Backspace` entfernt | Interaktive Kinder in `treeitem` sind nach WAI-ARIA problematisch, ein Tab-Stopp für den ganzen Baum. |
| Debounce der Suche vs. Preset | Debounce abbrechen / Wert vergleichen | beides: Effekt auf `presetRevision` bricht ab, der Callback prüft die Revision und den Tab | Ein Tipp-Rest darf den Preset nicht überschreiben (e2e prüft das). |
| Splitter-Sichtbarkeit (Zusatzwunsch Marc) | | Griff 32×2 px mittig (`--splitter-grip`, ≥3:1 zu Leiste, Hover, `--bg-app`, `--bg-panel`), Leiste `--splitter-bg`, Hover `--splitter-hover-bg`, Ziehen: Griff `--accent`, Fokus: Fläche `--accent`; Trefferfläche ±5 px per `::after`, sichtbare Leiste bleibt 6 px | Die alte Leiste in `--bg-panel` war im dunklen Theme kaum zu sehen. `check-contrast.mjs` hat jetzt `GRAPHIC_PAIRS` (Schwelle 3). |

## Vertrag

- `SessionUpdate.viewCounts: LevelCounts` (Rust `view_counts`), während `filterPending` noch die des alten Filters.
- Settings: `sidebarVisible` (true), `sidebarWidth` (240, 180–2000), `sidebarTreeShare` (0,55, 0,1–0,9),
  `savedFilters: { id, name, levels: Level[], query: SearchQuery, mode }[]` (höchstens 100, kaputte Einträge fallen weg).
- `LogSessionService.applyPreset(session, { levels, query, mode })`, `clearSearch(session)`.
- Kürzel: `Cmd/Ctrl+B`; im Baum Pfeile, Pos1/Ende, Enter/Space, Entf.

## Messwerte

`measure_500mb` (5,1 Mio. Zeilen, release, Apple Silicon):

| | vorher | nachher |
|---|---|---|
| Einlesen | 2,14–2,16 s | 2,13–2,18 s |
| Level-Filter | 15 ms (4 Läufe) | 26–30 ms (5 Läufe) |
| Suchfilter | 709–717 ms | 708–725 ms |
| Tail-Updates in 3 s bei 10k Zeilen/s | 26–30 | 28–30 |

Der Level-Filter wird in `measure_` mit 10-ms-Polling gemessen; der Sprung ist eine Polling-Stufe. Direkt gemessen
(`append` über 5,1 Mio. Zeilen, bestes von 7): 10,5 ms → 12,2 ms, also ~0,35 ns je Zeile.

## Fortschritt

- [x] Phase 1: Bestand, Zuordnung, Entscheidungen
- [x] Phase 2: Rust `view_counts` in `FilteredLines`, Checkpoint, Unit- und Integrationstests, Messung
- [x] Phase 3: Settings, `tree-model`, `sidebar-logic`, Baum, Statistik, Layout, Toolbar, `Cmd/Ctrl+B`, `applyPreset`, `session-marks`
- [x] Phase 4: e2e (Leiste umschalten, Breite per Tastatur, Datei über den Baum, Pfeile/Space im Baum, Statistik der Probe, ERROR-Klick, Alt-Klick, `×`, speichern/anwenden/löschen, Tipp-Rest gegen Preset)
- [x] Phase 5: Doku, Screenshots (`sidebar.png`, alle erneuert), sichtbarer Splitter
- [x] Phase 6: `npm run check`, `npm run contrast`, `npm run e2e`
- [ ] Sichttest mit `npm run demo:log` / `npm run demo:app`, hell und dunkel, 720 × 400: von Hand offen
