# 014 Zeitstrahl über dem Log – Design und Stand

- **Status:** umgesetzt (autonom nach Auftrag von Marc; Entscheidungen statt Haltepunkten unten festgehalten)
- **Datum:** 2026-11-07
- **Branch:** `feat/zeitstrahl`

## Abweichungen des Prompts vom heutigen Code

| Prompt | Heute |
|---|---|
| „Log-Ansicht“, `onKey` in `log-view.ts` | GuiExpert Table, `onKey` in `features/log-table/log-table-view.ts`; `.timeline` dort wie Detail-Panel/Baum ausgenommen, `Z` neu (frei laut README, `app.ts`, `toolbar.ts`) |
| „Canvas wie in 007“ | Muster von `log-table/overview-ruler.ts` (Laden ≤ 2/s mit Schlüssel, `getComputedStyle`, MutationObserver für das Theme) |
| `TimeSummary` „neben `LevelSummary` (oder in `overview.rs`)“ | eigenes Modul `timeline.rs` (rein), Feld `time` im `LineIndex`; gleiche Verdichtung (64 K Abschnitte) |
| „gepflegt in `ingest` beim `index.push`“ | `tail.rs::ingest` (Zeiten vor der Sperre), `SessionData::push_line(entry, ts, …)`, `LineIndex::push_timed`; Merge: `MergedLine.time` aus `Merger::emit` |
| `pop` der provisorischen Zeile, `reset_index`, `run_relevel` | `LineIndex::pop` + `TimeMark` in `Provisional`; `clear`; `recount` am Ende von `run_relevel` |
| Band „aus der obersten und untersten sichtbaren Zeile im PageCache“ | so umgesetzt; die Zeit der Zeile kommt aus Ankern (Zeile → Zeit an Abschnittsgrenzen, ≤ 1024) der `get_timeline`-Antwort, linear dazwischen, kein IPC beim Scrollen |
| „Zeitfilter braucht 010“, Blatt `Time` | `{ type: 'time', from, to }` im Baum des **Tabs** (`addCondition`), wirkt so je Ansicht (013) |

## Entscheidungen (statt Rückfrage)

| Frage | Optionen | Entscheidung | Grund |
|---|---|---|---|
| Was wird gezählt | Zeilen / Einträge | Einträge (Köpfe; die erste Zeile zählt immer) | „Ereignisse“; ein Stacktrace mit 50 Zeilen ist ein Fehler, „Spitze mit 312 Fehlern“ meint Einträge |
| Welche Köpfe werden geparst | erster+letzter (Prompt) / zusätzlich Proben | erster mit Zeit (≤ 8 Versuche), **jeder 32. Kopf**, letzter; endet der Abschnitt in Fortsetzungen, wird der letzte Kopf aus der Datei nachgelesen; am Ende jedes Blocks der letzte Kopf (Live-Ende) | Nur erster/letzter machte einen Ausfall innerhalb eines Abschnitts unsichtbar (Test mit 47 min Pause fiel durch). Proben kosten ~6 Parses mehr je 256 Zeilen (235 ns je Parse, zusammen ≈ 50 ms auf 500 MB) |
| Ausfall im Abschnitt | linear lassen / am größten Sprung teilen | größter Sprung je Abschnitt gespeichert (Zeiten und Zeilen davor/danach); ist er zehnmal länger als die Zeilen dazwischen bei der Rate des Rests brauchten, liegen diese Zeilen je zur Hälfte an den Enden, dazwischen bleibt es leer | Zeigt die Lücke auf eine Probe (≤ 32 Zeilen) genau, ohne Zeit je Zeile |
| Speicher | – | 64 Byte je Abschnitt, höchstens 64 K → 4 MB je Sitzung; Index bleibt 16 Byte/Zeile | |
| Datei ohne Zeiten | – | Parser nur, wenn eine Zeile des Samples eine Zeit hat; sonst kein Parse. Streifen wird zur einzeiligen Notiz | Prompt: kein leeres Diagramm |
| Achse ganze Datei | Perzentil roh / erweitert | 1.–99. Perzentil der Abschnittszeiten (nach Einträgen gewichtet), um das Dreifache der Spanne erweitert, bis zur äußersten Zeit innerhalb | Roh schnitte es die ersten/letzten 1 % jeder Datei ab und einzelne Einträge nach einer langen Pause; ein Ausreißer von 1970 bleibt draußen. Außerhalb: Zahl `◂ n` / `n ▸` mit Tooltip |
| Abschnitt mit Ausreißer (1970 am Anfang) | linear / als Punkt | Spanne > 16× Median und > 1 h → Punkt am Ende, das auf der Achse liegt | Sonst verteilten sich seine Einträge über Jahrzehnte |
| Perzentil-Achse testen | Vitest (Prompt) / Rust | Rust (`timeline.rs`), weil die Achse vor dem Verteilen feststehen muss; Vitest prüft Säulen, Lücken, Ticks, Texte | eine Abfrage statt zwei |
| Lücken | Frontend aus leeren Eimern / Backend | Backend liefert Lücken (zwischen Abschnitten und geteilte Abschnitte, ≥ 1 Eimer); Frontend wertet als Ausfall, wenn ≥ 10 × Eimerbreite / Median der Einträge je Eimer („Zehnfaches“) | Zeiten der Lücke exakt für den Tooltip „keine Einträge 10:04–10:51“ |
| „nur Ansicht“ | umsetzen / weglassen | weglassen, immer ganze Datei | Die Filterliste aus 007 trägt keine Zeiten (Prompt: „optional“); Roadmap |
| Klick | – | `position_at_time(view, ts)` → `jumpTo(position, line)`: Auswahl bleibt, Follow aus; versteckte Zeile → nächste sichtbare | Prompt |
| Tastatur | – | Spur ist `role="slider"` (fokussierbar, `aria-label` mit Zusammenfassung, `aria-valuetext` des Eimers); ←/→, Bild, Pos1/Ende, Shift = Fenster, `Enter` springt, `+`/`-` Zoom, `Esc` hebt Fenster auf, `Z` blendet aus | |
| Zoom | – | Mausrad um den Zeiger, „Hineinzoomen“ aus dem Fenster, „Ganze Datei“ zurück; je Tab gemerkt, nur im Speicher; im Zoom bleibt die Achse stehen, sonst wächst sie mit | Prompt |
| Vorgabe sichtbar | an / aus | an (`showTimeline`) | Kernfunktion; 56 px |
| Farben | neue / vorhandene | Ruler-Tokens für Fläche, Band, Level; neu `--tl-all`, `--tl-gap` | Gleiche Bedeutung, ein Kontrastpaar weniger zu pflegen |
| Uhrzeit-Logs ohne Datum | – | Zeitstrahl zählt Tageswechsel fortlaufend, die Zeit-Bedingung des Filters (010) nicht | als Grenze dokumentiert |

## Vertrag

- `get_timeline(sessionId, from?: µs, to?: µs, buckets ≤ 4096) -> Timeline { epoch, totalLines, entries, hasTimes, from, to, buckets: [{all, warn, error, fatal}] (Bruchzahlen), gaps: [{from, to}], min, max, before, after, untimed, anchors: [{line, ts}] }`, Fehler `too_large`.
- `position_at_time(sessionId, ts, viewId?) -> TimeHit { line, position, exact } | null` (blocking).
- Settings `showTimeline`; Kürzel `Z`; Toolbar „⏱ Zeit“; `LogSessionService.jumpToTime`, `filterTimeWindow`.
- `scripts/gen-log.mjs`: `--start ISO`, `--interval MS`, `--pause-after N`, `--pause MIN`.

## Messwerte

`measure_500mb` (5,1 Mio. Zeilen, release, Apple Silicon; Maschine stark belastet, Load ~20):

| | vorher | nachher |
|---|---|---|
| Einlesen | 2,27 s | 2,38 / 2,40 s (ein Lauf 2,82 s unter Last) |
| Level-Filter | 35 ms | 37 ms |
| Suchfilter | 760 ms | 761 ms |
| `get_overview` Identität | 184 µs | 172 µs |
| Tail-Updates in 3 s | 30 | 29 |
| `get_timeline` 1000 Eimer | – | 0,55–0,58 ms |
| `position_at_time` | – | 0,13 ms |
| ein Zeitstempel-Parse (Mikro-Benchmark) | – | 235 ns |

Erwarteter Mehraufwand ≈ 10 Parses je 256 Zeilen ≈ 50 ms (2 %); der gemessene Unterschied liegt im Rauschen der
belasteten Maschine. Nachmessen auf ruhiger Maschine empfohlen.

## Fortschritt

- [x] Phase 1: Bestand, Zuordnung, Entscheidungen
- [x] Phase 2: `timeline.rs` (19 Unit-Tests), Einbau in `LineIndex`/`tail.rs`/`merge.rs`/`session.rs`, Commands, `tests/timeline_integration.rs` (11: Lücke, Sprünge an Grenzen, Tail und Truncation, ohne Zeiten, ungeordnet, Stacktrace am Abschnittsende, provisorische Zeile, gefilterte Ansicht, Merge, UTF-16/CRLF/ANSI/Emoji, Profilwechsel), Messung
- [x] Phase 3: `timeline-logic.ts` (17 Specs: Säulen, Ausfälle, Ticks inkl. Sommerzeit, Band, Zoom, Texte), Komponente, Service (2 Specs), Toolbar, `Z`, Setting, Tokens, Mock
- [x] Phase 4: e2e mit `gap.log` (aus `gen-log.mjs`): Ausfall gefunden, Klick springt zur richtigen Zeit, `Home`+`Enter`, Fenster „Als Filter“, `Z`
- [x] Phase 5: Doku (README, CLAUDE.md, architecture, roadmap, themes), Screenshots `timeline(-light).png`
- [x] Phase 6: `npm run check`, `npm run contrast`, `npm run e2e`
- [ ] Sichttest mit `npm run demo:log` / `demo:app` (hell, dunkel, schmal): von Hand offen
