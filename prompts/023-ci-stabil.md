# Prompt 023: CI stabil machen – Wettläufe in Tests und App finden und beheben

> Zuerst `prompts/000-arbeitsweise.md` und `CLAUDE.md` lesen. Branch `fix/ci-stabil` von `main`.
> **Voraussetzung:** PR [krocon/log-commander#1](https://github.com/krocon/log-commander/pull/1) (`fix/ci-red`) ist
> gemergt. Sonst auf dessen Stand aufsetzen und das im Bericht nennen.
> 🛑 Haltepunkt nach Phase 1 (Analyse und Plan), bevor Code geändert wird.

## Problem

Die CI (`.github/workflows/ci.yml`: Frontend auf Ubuntu, Rust auf macOS, Windows und Ubuntu 22.04, dort zusätzlich
`xvfb-run -a npm run e2e`) ist seit v1.0.0 nicht verlässlich grün. In PR #1 wurde jeder Lauf an einer **anderen** Stelle
rot. Lokal (macOS) waren `npm run check` und `npm run e2e` jedes Mal grün. Bisher wurde jeder Befund einzeln behoben,
sobald er auftrat. Dieses Vorgehen endet nicht: Mit jedem behobenen Fehler läuft die Suite weiter und trifft den nächsten.

Befunde aus PR #1 (Commit = Fix):

| Ort | Plattform | Ursache | Art | Commit |
|---|---|---|---|---|
| `sources/database/tests.rs` `configs_are_checked` | Windows | `/var/log/app.db` ist unter Windows nicht absolut | Plattform | `408bdc1` |
| `tests/syslog_integration.rs` Verdrängen am Limit | macOS | feste Zeitgrenze zu knapp | Zeitgrenze | `408bdc1` |
| `mcp/src/host.rs` Deskriptor-Test | Linux | Watchdog-Thread hielt Socket-Klone 5 s | App | `616833f` |
| `mcp/src/host.rs` Flood-Test | Linux | Nagle + Delayed ACK, ~45 ms je Aufruf | App | `616833f` |
| `mcp/src/tools.rs` Snapshot | Windows | CRLF durch autocrlf | Plattform | `616833f` |
| e2e „saved filter applies“ | Linux | Zähler gelesen, bevor der Filter-Job fertig war | e2e-Wartebedingung | `e387e7a` |
| `report_db.rs` 50-Spalten-Abfrage | Linux | absolute Zeitgrenze; SQLite prüft den Progress-Handler nur an Sprüngen | Zeitgrenze | `78e30d4` |
| Lineal-Klick auf die letzte Fehlermarke | Linux | Eimergrenze mitten in einer Zeile, Suche startete eine Zeile zu spät und sprang an den Anfang | **App** | `0fbb388` |
| `winevent/fake.rs` `closing_cancels_a_hanging_call` | macOS | feste 100 ms, der Worker steckte noch in einer 200-ms-Runde | fester Sleep | `5f09a10` |
| `mcp/src/host.rs` `closed_connections_leave_no_descriptors_behind` | Linux | zählte alle Deskriptoren des Prozesses, andere Tests laufen parallel | prozessweite Messgröße | `5f09a10` |
| `report_db.rs` `a_newer_query_of_the_same_slot_stops_the_older_one` | Windows | feste 200 ms; der Thread startete später und wurde selbst die „neuere“ Abfrage | fester Sleep | `f423143` |
| e2e „alt-click only ERROR“ | Linux | `set_filter` ist `async` und läuft im Blocking-Pool: zwei schnelle Aufrufe in beliebiger Reihenfolge, der ältere Filter blieb | **App** | `1d54ab0` |
| `tests/expr_integration.rs` provisorische Zeile | macOS | Wartebedingung war schon vor der Aktion wahr | Wartebedingung | `9a5de2f` |
| e2e Dashboard „template … is drawn“ | Linux (nur CI) | `data-ready` des uPlot-Diagramms kam nie; im lokalen Linux-Container grün | **offen** | – |

### Muster

1. **Feste Pausen statt Bedingung** (`thread::sleep(…)` und danach eine Annahme über den Zustand eines anderen Threads).
   Rund 80 `thread::sleep(Duration::from_millis…)` in `src-tauri/src` und `src-tauri/tests`, nicht alle in Tests.
2. **Wartebedingung schon vor der Aktion erfüllt:** Der Test wartet auf einen Zustand, den es vorher schon gab, z. B.
   `total_lines == 3` bei provisorischer Zeile oder „keine INFO-Zeile“ nach „INFO aus“. Das gilt für Rust- und e2e-Tests.
3. **Prozessweite Messgrößen** (Deskriptoren, Threads, Speicher) bei parallel laufenden Tests.
4. **Absolute Zeitgrenzen** auf CI-Runnern mit 2–3 Kernen, die 2–5× langsamer sind als ein Entwickler-Mac.
5. **Echte Wettläufe in der App:**
   - Zustandsändernde `async`-Tauri-Befehle haben keine Reihenfolge (`spawn_blocking`).
   - Rundung an Grenzen (Lineal-Eimer).
   - Nebenläufigkeit beim Verbinden und Schließen.
   Die beiden App-Befunde oben treffen auch Nutzer auf langsamen Rechnern, nicht nur die CI.

## Ziel

Die CI ist **fünf Läufe in Folge auf allen drei Plattformen grün**, ohne dass Tests abgeschwächt werden. Wettläufe in der
App sind behoben. Für Tests gibt es Regeln und Helfer, damit neue Tests nicht wieder flackern.

## Phase 1: Analyse (🛑 danach Plan vorlegen)

1. **Inventar der Tests:** alle Rust-Tests (`src-tauri/src/**`, `src-tauri/tests/*`, `src-tauri/mcp/**`), Vitest-Specs
   mit Zeit (`setTimeout`, `vi.useFakeTimers`) und `scripts/e2e/scenario.js` durchgehen. Je Fundstelle notieren:
   - Muster 1–4 von oben,
   - was der Test eigentlich prüft,
   - ob die Wartebedingung vor der Aktion schon wahr sein kann.

   Ergebnis ist eine Tabelle (Datei:Zeile, Muster, Risiko hoch/mittel/niedrig, Vorschlag).
2. **Inventar der App-Wettläufe:**
   - **Zustandsändernde Befehle:** Für jeden zustandsändernden Befehl in `src-tauri/src/commands.rs` klären, ob zwei
     Aufrufe für dieselbe Sitzung oder Ansicht in vertauschter Reihenfolge ein falsches Endergebnis geben. Kandidaten:
     `set_filter` (behoben im Frontend, `applyFilter`), `open_view`, `close_view`, `set_profile`, `set_frozen`,
     `set_keep_on_rotate`, `set_extract_rules`, `set_custom_profiles`, `open_report`, `close_report`, `run_report`,
     `resort`, `set_spool_keep`, `set_spool_limit`.
   - **Aufrufer:** Je Befehl die Aufrufer im Frontend (`app/core/backend/call.ts` → `LogApi` → Services) und den
     MCP-Weg (`features/mcp/mcp-tools.ts`) prüfen: Wird gewartet, gereiht oder ein veraltetes Ergebnis verworfen?
   - **Rundung:** Stellen mit Rundung zwischen Frontend und Backend suchen, z. B. Positionen ↔ Pixel, Eimer, Seiten
     im `PageCache`, Zeitachse des Zeitstrahls.
3. **Messen statt raten.** Ein Skript `scripts/flaky-hunt.mjs` (oder `.sh`) läuft die Rust-Tests N-mal (Vorgabe 20)
   unter künstlicher Last und sammelt jeden Fehlschlag mit Name und Meldung. Last heißt z. B. parallel ein zweites
   `cargo test` oder CPU-Last, plus `--test-threads` über der Kernzahl. Lokal auf macOS laufen lassen und im
   Linux-Container (siehe Anhang). Zusätzlich eine Variante der CI mit `workflow_dispatch` und einer Matrix
   `repeat: [1..5]`, damit Windows und die GitHub-Runner selbst gemessen werden. Ergebnis: welche Tests wie oft fallen.
4. **Offener Dashboard-Befund:**
   - **Fakten:** Unter Linux in der CI kam `.rc[data-ready="1"]` für „Einträge je Level je Minute“ nie. Das
     Kreisdiagramm daneben war gezeichnet, die Abfrage lieferte 6 Zeilen. Im lokalen Linux-Container (WebKitGTK unter
     Xvfb) läuft derselbe Schritt durch.
   - **Hilfe:** Seit `d8b0101` meldet die e2e bei einer Zeitüberschreitung Fehler der Seite und `console.error`.
     Ersten CI-Lauf mit diesem Schritt auswerten.
   - **Verdächtig in `report-chart.ts`:** Der Effekt zeichnet bei jeder neuen `data` neu und setzt `ready` erst auf
     `false`, dann `true`; „⟳ Automatisch“ fragt alle 5 s neu ab. Ein `MutationObserver` auf `style`/`data-theme` von
     `<html>` zeichnet ebenfalls neu. `draw` hat keinen `try`: Ein Fehler in `new UPlot` oder `fit()` lässt `ready`
     auf `false`.

**Plan vorlegen:**

- je Befund Fix oder bewusst so lassen, mit Begründung;
- Reihenfolge;
- was nur in der CI prüfbar ist;
- Entscheidung zur Reihenfolge der Befehle:
  - (a) Frontend reiht je Tab, wie heute `applyFilter`;
  - (b) Backend reiht je Sitzung, z. B. ein Mutex oder eine Warteschlange je `LogSession` für ändernde Befehle;
  - (c) Sequenznummer je Aufruf, das Backend verwirft ältere.

  Empfehlung mit Begründung. (b) oder (c) schützt auch den MCP-Weg und künftige Aufrufer.

## Phase 2: Helfer und Regeln

- **Rust:** ein gemeinsamer Test-Helfer, z. B. `test_support::wait_until(what, timeout, || cond)` mit klarer Meldung
  und Zustandsausgabe. Er ersetzt die vielen lokalen `wait`/`wait_until` und vor allem feste Sleeps vor Annahmen.
- **Zeitgrenzen:**
  - relativ zu einer im Test gemessenen Basis (wie `78e30d4`), oder
  - nur als großzügige Obergrenze gegen Hänger (z. B. 10× der lokal gemessenen Zeit), nie als Leistungstest im
    normalen Lauf. Leistung bleibt in den `--ignored`-Messungen.
- **Fakes mit Zustandsmeldung:** Fakes und Testserver melden, was sie gerade tun (wie `FakeState.hanging` aus
  `5f09a10`). Tests warten darauf statt auf eine Zeit.
- **Prozessweite Messungen** nur auf das eigene Objekt beziehen (wie `port_sockets` in `mcp/src/host.rs`), oder den
  Test mit `#[serial]` bzw. als eigenes Test-Binary isolieren.
- **e2e:** Jede Aktion, deren Folge geprüft wird, wartet auf eine Bedingung, die **vor** der Aktion falsch war. Das am
  besten im Helfer erzwingen, z. B. `actAndWait(action, condition)`: prüft vorher, dass die Bedingung falsch ist.
- Die Regeln kommen kurz in `CLAUDE.md` unter „Arbeitsweise“ und in `prompts/000-arbeitsweise.md`, Abschnitt Tests.

## Phase 3: Fixes

- App-Wettläufe nach der Entscheidung aus Phase 1, je mit einem Test, der ohne Fix rot ist. Für Befehle eignet sich ein
  Rust-Test mit zwei Threads und gezielter Verzögerung oder eine Vitest-Spec mit von Hand aufgelösten Promises (Muster:
  `log-session.service.spec.ts` „sends one after the other“).
- Tests nach der Tabelle aus Phase 1. **Kein Test wird abgeschwächt, übersprungen oder mit `#[ignore]` versehen**, nur
  weil er flackert. Wenn doch nötig, dann mit Begründung und Rückfrage.
- Dashboard-Befund beheben oder die Ursache belegen.

## Phase 4: Nachweis

- `npm run check`, `npm run rust:check-windows`, `npm run e2e` lokal grün.
- `scripts/flaky-hunt` mit 20 Läufen ohne Fehlschlag, lokal und im Linux-Container.
- CI: der Wiederholungs-Workflow (5×) auf allen drei Plattformen grün, danach ein normaler Lauf auf dem PR.

## Bericht

- **Tabelle aller Befunde:** Ort, Muster, Fix, Test, der ohne Fix rot war.
- **Entscheidung** zur Reihenfolge der Befehle.
- **Offen:** was nur in der CI prüfbar war, und was offen bleibt.

## Anhang: Linux-e2e im Container nachstellen

So lief in PR #1 die Suite lokal unter Linux (500 Schritte grün):

```dockerfile
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y curl ca-certificates build-essential pkg-config git \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf xvfb xauth libssl-dev \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs \
 && curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH=/root/.cargo/bin:$PATH
WORKDIR /w
```

- **Quelltext kopieren:**
  `git ls-files -co --exclude-standard | COPYFILE_DISABLE=1 tar -cf - -T - | docker run --rm -i -v lc-w:/w <image> tar -xf - -C /w`.
  Die Variable muss vor `tar` stehen, nicht vor `git`. Ohne sie landen macOS-Dateien `._*` im Container, und der Build scheitert an
  `capabilities/._default.json`.
- **Volumes:** `target` und `~/.npm` als eigene Volumes, damit Wiederholungen schnell sind.
- **Sprache:** `-e LANG=C.UTF-8` wie die GitHub-Runner. Ohne sie blieb der Diagramm-Fehler aus PR #1 lokal unsichtbar.
- **Start:** `Xvfb :99 &` mit `DISPLAY=:99` statt `xvfb-run`. Als PID 1 hing `xvfb-run` nach dem Ende von
  `npm run e2e` stundenlang. Immer ein äußeres `timeout` setzen; macOS hat kein `timeout`, also im Container.
- **Rust-Tests allein:** `rust:1-slim` reicht für `lc-mcp`. Die App-Crate braucht die WebKitGTK-Pakete.
