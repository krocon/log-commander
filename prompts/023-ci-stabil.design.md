# 023 CI stabil – Analyse und Plan (Phase 1)

- **Status:** Phasen 1–3 fertig, Phase 4 lokal und im Linux-Container nachgewiesen (Abschnitt 7). Offen ist nur der
  Nachweis in der CI (Windows, GitHub-Runner): Er braucht Commit und Push. Plan am 2026-11-10 freigegeben.
- **Datum:** 2026-11-10 · Branch `fix/ci-stabil` von `main` (`eae36c9`, PR #1 ist gemergt).
- **Neu in Phase 1:** `scripts/flaky-hunt.mjs` (+ Test), `.github/workflows/ci-repeat.yml`, dieses Dokument.
- **Herkunft der Befunde:** Die Inventare sind aus dem Code gelesen. „gemessen“ steht nur dort, wo ein Lauf den
  Fehlschlag gezeigt hat (Abschnitt 3). Risiko = Einschätzung für einen Runner mit 2–3 Kernen.

## 1. Entscheidung: Reihenfolge der Befehle

**Empfehlung: Mutex je Sitzung im Backend (Atomarität) plus Variante (c), Sequenznummer aus `call.ts` (Reihenfolge).
Die Frontend-Kette (a) für `set_filter` bleibt, weil sie verworfene Filter-Jobs spart.**

Begründung:

- **(b) als echtes FIFO geht mit Tauri nicht ohne Umbau.** Tauri packt jeden `async`-Befehl samt dem Lesen der
  Argumente in `async_runtime::spawn` (`tauri-2.12.5/src/ipc/mod.rs:375`, Makro `command/wrapper.rs:383`). Auf der
  Multi-Thread-Runtime ist schon die Startreihenfolge zweier Aufrufe offen, nicht erst ab `spawn_blocking`. Ein
  „Ticket vor dem ersten await“ hilft also nicht. Synchron (nicht `async`) wären die Befehle geordnet, liefen aber auf
  dem Hauptthread (Regex kompilieren, `set_profile`).
- **(c) hält die Absicht des Aufrufers fest:** `call.ts` ist die einzige Stelle mit `invoke()`, JavaScript ist
  einsträngig. Für die Befehle mit „letzter gewinnt“ hängt `call.ts` `seq` an. Das Backend merkt je Schlüssel die
  höchste Nummer und beantwortet eine kleinere mit dem neuen Code `superseded`, den das Frontend still übergeht (kein
  Rollback, keine Meldung). Schlüssel: `filter:<view>`, `frozen`, `keep_on_rotate`, `spool_keep`, `profile`, `report`
  (öffnen und schließen teilen einen), global `custom_profiles`, `extract_rules:<profil>`; bei `run_report` ersetzt
  `seq` den Slot-Zähler bei Ankunft. Der MCP-Weg läuft über dieselben Services und erbt das.
- **Die Nummer allein reicht nicht:** `set_view_filter` und `open_view` kompilieren die Kette unter der Lesesperre und
  schreiben später unter der Schreibsperre. Ein `set_filter` eines anderen Tabs derselben Datei dazwischen ergibt
  (Eltern neu ∧ Kind alt). Dafür `mutate: Mutex<()>` in `LogSession`, genommen in `set_view_filter`, `open_view`,
  `close_view`, `set_profile`, `refresh_rules` über Kompilieren **und** Schreiben; Reihenfolge immer `mutate` → `data`.
  Tail, Merge, Filter-Job, Relevel und Builder nehmen `mutate` nie: Der Tail wartet auf keinen Befehl.
- **Dashboard braucht zusätzlich einen Zähler:** `open_report`/`close_report` sind kein „letzter gewinnt“, wenn zwei
  Tabs derselben Datei oder MCP (`withReport`) das Dashboard nutzen. `ReportDb` zählt Öffnungen, `pause()` erst bei 0.

Fallstricke: `seq` muss über einen Reload des WebViews hinweg steigen (Startwert aus `Date.now()`), `superseded` darf
kein optimistisches Zurücksetzen auslösen, `close_report` läuft nicht unter `mutate` (joint den Builder).

## 2. Befunde und Plan

Spalte **Plan**: F = Fix, L = bewusst so lassen. Reihenfolge der Arbeit steht in Abschnitt 4.

### 2.1 App (Wettläufe und Fehler, die auch Nutzer treffen)

| # | Ort | Problem | Risiko | Plan |
|---|---|---|---|---|
| A1 | `report-chart.ts` `loadUPlot`/`draw` | Offener Dashboard-Befund. `draw` ohne `try`, ein Fehler lässt `ready` für immer `false`; `loadUPlot` behält ein abgelehntes Promise. Ursache in der CI, im Container nachgestellt (3.2): uPlot ruft beim Laden `new Intl.NumberFormat(navigator.language)`, der Runner hat `LANG=C.UTF-8` → ungültiger Sprach-Tag → `RangeError` | hoch, **gemessen** | F: Fehlerzustand (`data-ready="error"` + Text), Laden wiederholbar, ungültige Sprache abfangen; e2e bricht bei `error` sofort mit der Meldung ab |
| A2 | `session.rs:1041–1078` `set_view_filter`, `:1171–1216` `open_view` | Kette unter Lesesperre kompiliert, später geschrieben: zwei Tabs einer Datei können dauerhaft einen anderen Filter zeigen als die UI | mittel | F: `mutate`-Mutex; Rust-Test mit zwei Threads und Verzögerung zwischen Kompilieren und Schreiben |
| A3 | `dashboard.ts:383/400`, `report_db.rs:454/470` | `open_report`/`close_report` vertauscht beim Tabwechsel zwischen zwei Dashboard-Tabs einer Datei: sichtbares Dashboard ohne Builder | mittel | F: Zähler im `ReportDb` |
| A4 | `mcp-tools.ts:573–596` `withReport` | Schließt das Dashboard des Nutzers bzw. einer parallelen MCP-Abfrage (kein Wettlauf, Logik) | mittel | F: derselbe Zähler |
| A5 | `merge.rs:1005` | `load()` setzt am Ende immer `Status::Live`; `Rotated`/`Truncated` gehen verloren, wenn dazwischen kein Update fällig war. Lässt `merge_integration.rs:580, 601` in den Timeout laufen | mittel | F: Status vor dem `Live` einmal senden; Test ohne Fix rot |
| A6 | `ruler-logic.ts:268–284`, `session.rs:1599–1616`, `overview.rs:226–240` | Lineal-Klick: Suche vorwärts ohne Obergrenze. Klick auf den unteren Teil eines Stacktrace-Balkens springt zum nächsten Fehler dahinter; ab 64 K Zeilen (Abschnitt > 1 Zeile) verfehlt die Suche eine Fehlerzeile vor der Eimergrenze. `0fbb388` deckt nur Abschnitt = 1 Zeile | hoch (kleine Dateien mit Stacktraces) | F: ab Abschnittsanfang suchen, Treffer nur bis Eimerende, sonst Kopf des Eintrags; Specs für beide Eingaben |
| A7 | `log-session.service.ts:875` | „Teilen“ im Filter-Tab scheitert mit `unknown view`, wenn der Datei-Tab geschlossen ist (`getLines` ohne `viewId`). Deterministisch, kein Wettlauf | hoch | F: `viewId` mitgeben; Spec |
| A8 | Befehle mit „letzter gewinnt“ (`set_frozen`, `set_keep_on_rotate`, `set_spool_keep`, `set_profile`, `set_custom_profiles`, `set_extract_rules`, `run_report`) | Vertauschte Ausführung lässt den älteren Wert stehen. Heute nur im ms-Fenster erreichbar (Doppelklick, MCP) | niedrig | F über `seq` (Abschnitt 1), je ein Rust-Test |
| A9 | `settings-dialog.ts:548, 586` | Zwei schnelle Löschklicks: Das erste Profil ist wieder da (Liste aus altem Stand gebaut) | niedrig–mittel | F: Aufrufe verketten; Spec |
| A10 | `log-session.service.ts:290–316` `close` | Später `set_filter` nach dem Schließen zeigt `unknown view` als Fehlermeldung | niedrig | F: Fehler eines geschlossenen Tabs schlucken |
| A11 | `mcp-tools.ts:714–763` `wait_for_lines` | Verborgene Ansicht zählt gegen die 8 Tabs; läuft nach dem Schließen der Sitzung bis zum Timeout | niedrig–mittel | F: in der Schleife prüfen, ob die Sitzung noch offen ist. Die Zählung gegen `MAX_VIEWS` bleibt (L), Grenze dokumentieren |
| A12 | `dashboard.ts:376–395` | Nach `await` keine Prüfung auf zerstörte Komponente: Timer läuft weiter, Builder ohne Dashboard | niedrig–mittel | F (fällt mit A3 fast weg) |
| A13 | `log-session.service.ts:746–795`, `:949–963`, `session-state.ts:406–431` | Sprung/Treffer nach `await` ohne Prüfung von `epoch`/`viewGeneration` | niedrig | F: vor und nach dem `await` vergleichen |
| A14 | `toggleFreeze` (Doppeldruck sendet zweimal denselben Wert), `viewport-logic.ts:69` (Daumen eine Zeile vor dem Anschlag), `log-table-view.ts:1152` (Totzone < 2 px), Zeitstrahl „Als Filter“ rundet auf ganze Sekunden | kosmetisch bzw. gewollt | niedrig | L |

### 2.2 Rust-Tests

| # | Datei:Zeile | Test | Muster | Risiko | Plan |
|---|---|---|---|---|---|
| R1 | `report_db.rs:1839, 1847` | `closing_stops_running_queries_and_refuses_new_ones` | 1 | hoch | F: auf `db.readers` warten statt 200 ms |
| R2 | `mcp.rs:291` | `at_most_two_waits_at_a_time` | 1 | hoch | F: `Echo` mit Schranke, auf zwei gesendete Aufrufe warten |
| R3 | `report_db.rs:1494` `quick()` | 5 Tests, die Erfolg erwarten, mit 300 ms Zeitlimit | 4 | mittel–hoch | F: `quick()` nur, wo das Zeitlimit erwartet wird |
| R4 | `merge_integration.rs:536–550` | `a_silent_source_holds_up_the_others_at_most_hold_back` | 4 | hoch | F: `elapsed`-Grenzen weg; die Regel prüft `merge.rs:1682` ohne Uhr |
| R5 | `merge_integration.rs:478–486` | `live_lines_wait_for_each_other_and_late_ones_are_counted` | 1/4 | hoch | F: im Freeze schreiben, auf `pending_bytes` warten, fortsetzen |
| R6 | `syslog_integration.rs:124–165` | `ten_thousand_udp_messages_arrive_…` | 1/3 | hoch (Linux) | F: nach jedem Schwung auf `received >= sent` warten. Die Prüfung `dropped == 0` bleibt |
| R7 | `sftp_integration.rs:557–572` | `files_of_one_server_share_a_connection_…` | 4 | hoch | F: `idle_close` im Fixture 60 s, die drei Stellen mit Idle-Schließen über einen Test-Sweep |
| R8 | `sftp_integration.rs:422–428` | `live_lines_rotation_truncation_and_no_shell` | 1 | mittel | F: neue Zeile kürzer als der alte Offset, Sleep weg |
| R9 | `tail_integration.rs:107–112` | `write_tail_truncate_rotate` | 2 | niedrig–mittel | F: `counts.error == 1`, `file_size == size` |
| R10 | `tail:205, 256`, `expr:412`, `report:386, 394`, `export:357, 403, 483` | Laden/Filtern großer Dateien mit 10–20 s | 4 | mittel | F: gemeinsamer Helfer, Vorgabe 60 s |
| R11 | `report_integration.rs:397`, `report_db.rs:1640, 1705, 1844, 1852`, `spool.rs:742`, `winevent/event.rs:432`, `fake.rs:393, 535`, `probe.rs:239, 253`, `host.rs:468, 546`, `database/tests.rs:667`, `workspace.rs:219`, `sources/mod.rs:470, 513` | absolute Grenzen von 200 ms bis 15 s | 4 | niedrig–mittel | F: wo ein Zustand den Beweis schon führt, Grenze streichen; sonst Obergrenze gegen Hänger (≥ 10× lokal). `event.rs:432` relativ (64 KB gegen 16 KB) |
| R12 | `report_db.rs:315` `PERMITS` | `at_most_a_few_queries_run_at_once` bremst alle anderen report_db-Tests (prozessweit 6) | 3 | mittel | F: mit R11 entschärft; Test selbst bleibt |
| R13 | `syslog_integration.rs:365–391, 610–622` | Rotationen mit `sleep(30 ms)` je Block; `read_dir`-Stichprobe `<= 3` | 1/3 | niedrig–mittel | F: je Block auf `spooled == sent` warten. Stichprobe: `spool.rs:173` legt die neue Datei vor dem Löschen an → entweder Grenze +1 oder erst löschen (im Fix entscheiden, App-Verhalten) |
| R14 | `syslog_integration.rs:686, 751` | Zustand kann schon vorbei sein; absolute „too slow“-Grenze | 2/4 | niedrig | F: Wait streichen bzw. zwei Quellen mit `evict_after` 60 s und 0 |
| R15 | `fake.rs:422` | wartet auf den flüchtigen Zustand `Reconnecting` | 2 | niedrig–mittel | F: auf `reconnects == 1` warten |
| R16 | `views_integration.rs:433, 447` | `len == heard` nach Sleep | 1 | niedrig | F: Inhalt statt Anzahl prüfen |
| R17 | `host.rs:599`, `sources/mod.rs:553`, `merge.rs:1670` | implizite Zeit (Token-Bucket, Zähl-Intervall, `HOLD_BACK`) | 4 | niedrig | F: Uhr übergeben |
| R18 | `sftp:474`, `syslog:264` | Port gleich wieder binden | 3 | niedrig | F: kurze Wiederholschleife |
| R19 | `samples/*.log`, Schlüsseldateien der Tests | Windows-Checkout macht CRLF daraus (kein `.gitattributes`) | Plattform | niedrig | F: `.gitattributes` mit `-text` |
| R20 | Negativprüfungen nach Sleep (tail 656, 688, 786, 837; merge 663; syslog 438; report 319, 460; views 344; database/tests 483, 547; fake 472), `SETTLE` nach `set_frozen` | können nicht fälschlich rot werden | – | – | L, wo das positive Signal schon abgewartet ist; sonst das Signal ergänzen (`pending_bytes`) |

### 2.3 e2e (`scripts/e2e/scenario.js` = S, `run.mjs` = H) und Vitest

| # | Ort | Schritt | Muster | Risiko | Plan |
|---|---|---|---|---|---|
| E1 | S:2070 | „template … is drawn“ | App (A1) | hoch | F mit A1 |
| E2 | S:740, 745, 787 | „INFO off“, „WARN+ shows no INFO“, „regex search“ | 2 | hoch | F: `actAndWait` mit Generation der Ansicht |
| E3 | S:1169–1176 | „E goes to the first error“ | 1+2 | hoch | F: Zähler der Sprünge als Hook |
| E4 | S:1494 | „worst event loop lag“ > 250 ms wirft | 4 | hoch | **Rückfrage nötig:** Das ist ein Leistungstest im normalen Lauf. Vorschlag: Grenze bleibt lokal, in der CI (`CI=true`) wird der Wert nur berichtet. Das schwächt die Prüfung in der CI ab |
| E5 | S:1662, 3108, 3174, H:522 | `sleep`, dann `expectsettings` einmal gelesen | 1 | hoch | F: im Harness bis 5 s wiederholen (wie `expectspool`) |
| E6 | S:963–979 | „a drag keeps its marked text …“ | 5 | **gemessen** (Container unter Last, Abschnitt 3) | F: Ursache in Phase 3 klären (Frame der Tabelle gegen Frame des Tests) |
| E7 | S:1521–1537, 1579–1594 | Freeze: `sleep(300)`, dann Gleichheit bzw. „zeichnet nichts“ | 1+3 | mittel | F: vor dem Freeze Generation + nicht ladend abwarten; Negativprüfung über `holds()` |
| E8 | S:2250, 1798, 1857, 1896, 798 | einmal gelesen nach anderem Signal | 3 | mittel | F: pollen |
| E9 | S:2856, 2841, 2953, 2407, 2536 | `sleep(40/50)`, dann Klick | 1 | mittel | F: auf `!disabled` bzw. sinkende Tab-Zahl warten |
| E10 | S:1212 | Lineal-Klick per Pixel | 5 | mittel | F mit A6 |
| E11 | S:1979, H:310 | 20 s bzw. 8 s Grenzen | 4 | mittel | F: 60 s/20 s als Obergrenze gegen Hänger |
| E12 | S:3022–3039 | „changed host key“ | 5 (nicht belegt) | mittel | F: Fehlertext ausgeben, beobachten |
| E13 | S:1515 `tail.check` (kein Platzhalter beim Live-Tail) | Invariante unter Last | 4 | mittel | L: Das ist die Zusage aus `displayed-lines.ts`. Zähler in der Meldung ausgeben |
| E14 | S:804, 1292, 357, 2917, 2447, 2766 und Pixelstellen | Scheintreffer oder nur unter Extremlast | 2/3/5 | niedrig | F, wo `actAndWait` direkt passt; sonst L |
| V1 | `timeline-logic.spec.ts:182` | Sommerzeit-Test hängt an der Zeitzone des Rechners | – | niedrig, nicht flaky | F: `TZ=Europe/Berlin` für `npm test` |
| V2 | übrige 56 Specs | nur 0-ms-Timer und Fake-Timer mit Aufräumen | – | – | L |

Helfer (Phase 2):

- **Rust:** `test_support::wait_until(what, || cond)` (Vorgabe 60 s, `LC_TEST_TIMEOUT` in Sekunden) mit Variante, die
  den Zustand in die Meldung schreibt; dazu `read_to_end`, `settled`, `saw_update`. Ersetzt die 12 lokalen `wait`.
  Als `tests/support/mod.rs` für die Integrationstests und `#[cfg(test)] mod test_support` in beiden Crates.
- **e2e:** `actAndWait(what, action, condition, { settle })` wirft, wenn die Bedingung vorher schon gilt; `holds(what,
  condition, ms)` für „bleibt so“. Neuer Hook an `app-log-table-view`: `data-epoch`, `data-view-generation`,
  `data-lines`, `data-loading`, `data-jumps`. Geschätzt 250–280 der 436 `waitFor` passen direkt, 40–50 brauchen den
  Hook, rund 25 werden `holds`. Umgestellt werden zuerst die Schritte aus der Tabelle, der Rest schrittweise in
  derselben Phase.

## 3. Messungen

### 3.1 `flaky-hunt` auf macOS (10 Kerne), Ist-Stand vor allen Fixes

`node scripts/flaky-hunt.mjs --runs 20`: 15 Test-Binaries gleichzeitig, je 20 Test-Threads, dazu 10 Prozesse mit
Dauerlast; ein Durchgang rund 100 s. **Kein Durchgang war grün**, vier Tests fielen:

| Fehlschläge / 20 | Test | Meldung | Inventar |
|---|---|---|---|
| 17 | `report_integration` `only_while_open_and_closing_the_session_stops_the_build` | `started.elapsed() < 2 s` (Z. 399) | R11 |
| 9 | `winevent::fake` `closing_cancels_a_hanging_call` | `15.8 s` statt `< 8 s` (`fake.rs:393`) | R11 |
| 3 | `report_db` `rows_and_bytes_are_limited` | `time limit of 0.3 s exceeded` (`quick()`) | R3 |
| 1 | `syslog_integration` `the_spool_rotates_and_stays_within_its_limit` | `epoch 0` nach 600 Meldungen (Z. 408) | R13 |

- Alle vier standen im Inventar, drei davon nur als „niedrig–mittel“. Die Einschätzung aus dem Lesen unterschätzt also
  absolute Zeitgrenzen; R11 rückt in der Reihenfolge nach vorn.
- `closing_cancels_a_hanging_call`: 15,8 s sind mehr als die 10 s, die der Fake höchstens hängt. Entweder stand der
  Test-Thread selbst so lange, oder das Schließen wartet länger als der Hänger. Das wird in Phase 3 zuerst geklärt
  (möglicher App-Befund im Wächter-Thread, `winevent/follow.rs:103`), bevor die Grenze angefasst wird.
- Die als „hoch“ eingestuften R1, R2, R4–R7 fielen in 20 Durchgängen nicht. Sie bleiben im Plan (das Fenster ist aus
  dem Code belegt), sind aber auf dieser Maschine seltener als gedacht.
- Rohdaten liegen nicht im Repo (Scratch-Ordner); der Lauf ist mit dem Befehl oben wiederholbar.

### 3.2 e2e im Linux-Container (Ubuntu 22.04, WebKitGTK, Xvfb)

Image und Volumes aus PR #1 (`lc-linux-e2e`, `lc-w`, `lc-target`, `lc-npm`). Unterschied zur CI gefunden: Der Container
hat `LANG` leer, die GitHub-Runner setzen `LANG=C.UTF-8`.

- **Mit `-e LANG=C.UTF-8`, ruhige Maschine: Der Dashboard-Befund ist nachgestellt.** `FAIL timeout: template „Einträge
  je Level“ is drawn`, davor mehrfach `info rejection: NumberFormat@[native code]` und `console: ERROR
  NumberFormat@[native code]`. Das ist der `RangeError` aus `new Intl.NumberFormat(navigator.language)` beim Laden von
  uPlot (A1). Der Schritt davor mit dem Kreisdiagramm braucht uPlot nicht und läuft durch, wie in der CI. Damit ist
  A1 kein Wettlauf, sondern ein Fehler der App für jeden Nutzer mit `LANG=C.UTF-8` unter Linux; in der CI fiel er nur
  deshalb „manchmal“ auf, weil frühere Läufe vorher an anderer Stelle rot wurden.
- **Mit `LANG=C.UTF-8` und gleichzeitiger Last** (der macOS-Lauf aus 3.1 lief parallel): `FAIL timeout: a drag keeps
  its marked text and the selected entry` (E6), noch vor dem Dashboard. Ein Lauf, also ohne Häufigkeit.
- Hinweis zum Anhang des Prompts: `COPYFILE_DISABLE=1 git ls-files … | tar …` setzt die Variable nur für `git`. Die
  `._*`-Dateien landen trotzdem im Volume (Build scheitert an `capabilities/._default.json`). Richtig ist
  `git ls-files … | COPYFILE_DISABLE=1 tar …`.

### 3.3 `flaky-hunt` im Linux-Container

Gleicher Befehl, 10 Kerne der Docker-VM; ein Durchgang 32 s. **Kein Durchgang war grün:**

| Fehlschläge / 20 | Test | Meldung | Inventar |
|---|---|---|---|
| 20 | `syslog_integration` `ten_thousand_udp_messages_arrive_with_levels_and_fields` | Timeout bei `7807 lines`, `received: 7807, dropped: 0` | R6 |
| 20 | `syslog_integration` `the_spool_rotates_and_stays_within_its_limit` | `epoch 0` nach 600 Meldungen | R13 |
| 16 | `report_db` `rows_and_bytes_are_limited` | `time limit of 0.3 s exceeded` | R3 |

- Gegenprobe ohne Last (`--load 0 --threads 4 --serial`, je 3 Durchgänge): Syslog-Tests und `report_db` grün. Die
  Fehlschläge kommen also von der Last, nicht vom Container.
- R6 bestätigt: Der Kernel verwirft Datagramme, wenn der Empfänger-Thread steht (`syslog.rs` setzt kein `SO_RCVBUF`),
  die App zählt sie nicht (`dropped: 0`). Der Test-Fix (Rückstau im Sender) ist richtig; ein größerer Empfangspuffer
  in der App wäre eine eigene Verbesserung für Nutzer und kommt als Vorschlag in die Roadmap, nicht in diesen Prompt.
- R13 ist unter Linux deutlich häufiger als im Inventar geschätzt (20/20 statt „niedrig–mittel“).
- Die beiden macOS-Spitzenreiter (`only_while_open…`, `closing_cancels_a_hanging_call`) fielen unter Linux nicht.

### 3.4 Noch nicht gemessen

- Windows und die GitHub-Runner (`CI repeat` braucht Commit und Push).
- e2e mehrfach unter Last (bisher ein Lauf).

## 4. Reihenfolge

1. **Phase 2:** Rust-Helfer, e2e-Helfer und Hook, Regeln in `CLAUDE.md` und `prompts/000-arbeitsweise.md`.
2. **App:** A1 (Dashboard) zuerst, weil es jeden Linux-Lauf der CI rot macht, der bis dorthin kommt. Dann A5, A6, A7 (je mit
   Test, der ohne Fix rot ist), dann Mutex + `seq` + Report-Zähler (A2–A4, A8), dann A9–A13.
3. **Rust-Tests** R1–R19: zuerst die gemessenen (R3, R6, R11, R13), dann die übrigen hohen, danach `flaky-hunt` 20×.
4. **e2e** E2–E14.
5. **Nachweis:** `npm run check`, `rust:check-windows`, `e2e` lokal; `flaky-hunt` 20× auf macOS und im Container;
   `CI repeat` (5× je Plattform) und ein normaler Lauf auf dem PR.

## 5. Nur in der CI prüfbar

- Windows überhaupt (lokal nur `rust:check-windows`, nichts läuft): R19, Datei-Sperren (`sources/mod.rs:519`), R13.
- macOS-Runner mit 3 Kernen: Die lokale Maschine hat 10, `flaky-hunt` nähert das nur an.
- A1 ist lokal nachgestellt (3.2); die CI bestätigt nur noch den Fix. Der Container bekommt dafür künftig
  `LANG=C.UTF-8` wie die Runner.
- Für `CI repeat` und den PR braucht es Commit und Push, also die Freigabe.

## 7. Ergebnis (Phasen 2–4)

### 7.1 Nachweis

| Prüfung | Vorher | Nachher |
|---|---|---|
| `flaky-hunt --runs 20`, macOS | 0 von 20 Durchgängen grün | 20 von 20 |
| `flaky-hunt --runs 20`, Linux-Container | 0 von 20 | 20 von 20 |
| e2e im Linux-Container mit `LANG=C.UTF-8` | rot am Dashboard (und einmal am Ziehen) | grün, 516 Schritte |
| `npm run e2e`, macOS | grün | grün, 514 Schritte |
| `npm run check`, `npm run rust:check-windows` | grün | grün |

Auf dem Weg dorthin fielen in den Zwischenläufen noch zwei Dinge auf (je 1 von 20 auf macOS), beide behoben:
`host::too_many_open_sockets_are_turned_away` (Test-Helfer vertrug eine vom Host geschlossene Verbindung nicht) und
`tail_integration::truncation_during_a_freeze…` (Fehler der App, A16).

### 7.2 Befunde der App

| # | Fix | Test, der ohne Fix rot ist |
|---|---|---|
| A1 Diagramm bei `LANG=C.UTF-8` | `chart-loader.ts`: Sprache prüfen und für den Import ersetzen, Laden wiederholbar; `report-chart.ts`: Fehlerzustand `data-ready="error"` mit Text | `chart-loader.spec.ts` („fails without the guard“ zeigt den Fehler); e2e im Container mit `LANG=C.UTF-8` war vorher rot |
| A2 Filter zweier Tabs einer Datei | Sperre `LogSession.order` um Kompilieren und Schreiben | `order_integration.rs` `a_filter_of_a_child_…` (Gegenprobe ohne Sperre: `[0, 2]` statt `[0]`) |
| A3/A4 Dashboard schließt für andere mit | Menge der Nutzer je Sitzung (`open_report_for`/`close_report_for`), Tab bzw. KI-Aufruf als Nutzer, KI lässt die Spalten | `order_integration.rs` `the_dashboard_stays_open_…` |
| A5 Merge verliert `Rotated`/`Truncated` | `merge.rs`: Einmal-Status wird gesendet, bevor `Live` ihn ersetzt | `merge_integration.rs` `a_truncation_is_reported_while_updates_of_another_source_are_running` (ohne Fix 3/3 rot) |
| A6 Lineal-Klick | Treffer nur in den angeklickten Eimern, sonst der Kopf davor | `ruler-logic.spec.ts`, `log-session.service.spec.ts` („stack trace goes to its head“) |
| A7 „Teilen“/Kopieren im Filter-Tab | `viewId` des Tabs mitgeben | `log-session.service.spec.ts` („reads whole entries through the view of the tab“) |
| A8 „letzter gewinnt“ | `seq` aus `call.ts`, `Order::admit` im Backend, Code `superseded` | `order.rs`, `order_integration.rs`, `call-order.spec.ts` |
| A9 Profil-Liste | Änderungen nacheinander (`shared/serial.ts`) | `serial.spec.ts` |
| A10 Fehler eines geschlossenen Tabs | `SessionState.closed`, Aufrufe in der Kette verwerfen | `log-session.service.spec.ts` („closed tab“) |
| A11 `wait_for_lines` nach dem Schließen | Schleife endet mit `tab_not_found` | keiner (nur gelesen) |
| A12 Dashboard während des Ladens ausgeschaltet | `destroyed`, kein Timer, eigene Öffnung schließen | keiner (nur gelesen) |
| A13 veraltete Sprungziele | Ansicht vor und nach dem `await` vergleichen; offener Sprung wird in der neuen Ansicht wiederholt | `log-session.service.spec.ts`, `session-state.spec.ts` |
| A15 **neu:** Schließen einer Sitzung dauerte auf macOS unter Last 3–133 s | `Drop` von `LogSession` beendet die Datei-Watcher auf einem eigenen Thread (nur macOS; `FSEventStream` fragt den überlasteten `fseventsd`) | keiner; gemessen über `closing_cancels_a_hanging_call` und `only_while_open…` (9 bzw. 17 von 20 rot) |
| A16 **neu:** „Bytes warten“ und die Warnung bleiben nach dem Fortsetzen stehen | `tail.rs`, `merge.rs`: `watch_while_frozen` schreibt nicht mehr, wenn inzwischen fortgesetzt wurde | keiner, der gezielt rot wird (Fenster von Mikrosekunden); gefunden von `flaky-hunt` (1 von 20), danach der Test 20× und alles 20× grün |
| Spool | `spool.rs`: älteste Datei wird vor dem Anlegen der neuen gelöscht, nie `max_files + 1` im Ordner | `syslog_integration.rs` `the_spool_rotates_…` (`<= 3` unverändert) |

Bewusst gelassen: A14 (kosmetisch bzw. gewollt). `run_report` behält den Zähler bei Ankunft (Roadmap).

### 7.3 Tests

- **Rust:** alle lokalen Warte-Helfer (12 in den Integrationstests, 7 in den Unit-Tests) laufen über
  `src-tauri/src/test_support.rs`. R1–R19 sind umgesetzt, die Tabellen dazu stehen in den Berichten der Phase; keine
  Prüfung wurde gelockert, kein Test übersprungen. Feste Zeitgrenzen sind durch Zustände ersetzt (Fake zählt
  `hangs_cancelled`, Meldung „cancelled“ statt „time limit“) oder relativ (`a_large_event_is_read_quickly`: 4× Länge
  gegen 1×, `only_while_open…`: Wettlauf gegen eine zweite Sitzung unter gleicher Last).
- **Nahtstellen im Produktivcode nur für Tests:** `counted_at`, `Bucket::take_at` (Uhr übergeben), `Hub::sweep_now`,
  `LogSession::on_compiled` (alle `#[doc(hidden)]` bzw. intern).
- **e2e:** `actAndWait`, `holds`, `readUntil`, Attribute `data-view-generation`/`data-epoch`/`data-lines`/`data-jumps`
  an `app-log-table-view`, `__lcTable.dragged()`. Umgestellt sind die Schritte aus 2.3 (E2–E11) und drei weitere, die
  dabei rot wurden (Suchtext vor „Nächster“ abwarten, Treffer am Zeilenrand, „Vorheriger“). E4: Die Grenze von 250 ms
  gilt lokal, in der CI (`CI` gesetzt) wird der Wert nur berichtet.
- **Nicht gemacht:** Die übrigen rund 400 `waitFor` laufen weiter ohne die Vorprüfung (Roadmap). E12 (geänderter
  Host-Schlüssel) und E13 unverändert. `tests/db_integration.rs` (nur `--ignored`) hat weiter eigene Schleifen.

### 7.4 Offen

- **CI:** Windows und die GitHub-Runner sind nicht gemessen. Nach Commit und Push: Workflow „CI repeat“ starten
  (5× je Plattform, optional `hunt_runs`), danach ein normaler Lauf auf dem PR. Erst dann ist das Ziel des Prompts
  („fünf Läufe in Folge auf allen drei Plattformen grün“) belegt; der Prompt bleibt bis dahin in `prompts/`.
- **Von Hand zu prüfen:** Dashboard mit zwei Tabs derselben Datei, Lineal-Klick auf einen Stacktrace, Tab schließen
  unter macOS (Watcher enden jetzt im Hintergrund).
- **Keine Messung `measure_`:** Einlesen, Filter und Suche sind nicht verändert; die Sperre liegt nur um ändernde
  Befehle.

## 6. Offene Fragen (am 2026-11-10 mit der Freigabe beantwortet: 1–3 ja, 4 offen)

1. Reihenfolge der Befehle wie in Abschnitt 1 (Mutex + `seq` + Report-Zähler)?
2. E4: Leistungsgrenze „event loop lag“ in der CI nur berichten?
3. Umfang: A6, A7, A9–A13 sind Fehler der App, aber keine Ursache für rote CI-Läufe. Hier mit beheben (Vorschlag) oder
   in die Roadmap?
4. Commit und Push auf `fix/ci-stabil`, damit `CI repeat` schon den Ist-Stand auf Windows und den Runnern misst?

## Fortschritt

- [x] Phase 1: Inventare, Mess-Skript, Wiederholungs-Workflow, Plan
- [x] Phase 2: Helfer und Regeln
- [x] Phase 3: Fixes
- [x] Phase 4 lokal: `npm run check`, `rust:check-windows`, `npm run e2e` (macOS), e2e und `flaky-hunt` 20× im Container
- [ ] Phase 4 CI: Workflow „CI repeat“ (5× je Plattform), danach ein normaler Lauf auf dem PR
