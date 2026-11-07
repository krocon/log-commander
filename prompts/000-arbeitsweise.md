# Prompt 000: Gemeinsame Arbeitsweise für alle Feature-Prompts

> Gilt für alle Prompts in `prompts/`. Jeder Feature-Prompt beschreibt nur, was für sein Feature dazukommt; Reihenfolge und
> Voraussetzungen stehen in seinem Kopf. **Zuerst diese Datei lesen, dann den Feature-Prompt.** Bei Widersprüchen gilt der
> Feature-Prompt, wenn er ausdrücklich abweicht, sonst diese Datei.

---

## 1. Vor dem Start

- `CLAUDE.md` vollständig lesen, dazu `docs/architecture.md`, `docs/roadmap.md` und bei Farben `docs/themes.md`.
- **Voraussetzungen prüfen:** Der Kopf des Prompts nennt, was vorher umgesetzt sein muss. Erledigtes liegt in
  `prompts/done/`. Fehlt etwas: anhalten und fragen, nicht nebenbei mitbauen.
- Prüfen, ob es schon einen Stand gibt (Branch, `prompts/NNN-<slug>.design.md`, abgehakte Punkte im Prompt).
- Toolchain: `node -v` ≥ 22, `npm -v`, `cargo -V` (stable). Dann `npm install` und einmal `npm run check`. Ist etwas schon vor
  dem Start rot, ist das ein eigener Befund für den Bericht und wird nicht stillschweigend mitrepariert.
- Arbeit auf einem Branch `feat/<slug>` bzw. `fix/<slug>` von `main`. **Kein Commit, kein Push, kein Release ohne Rückfrage.**
- Taskliste mit einem Eintrag je Phase führen.

## 2. Phasen

| Phase | Ergebnis | Haltepunkt |
|---|---|---|
| 1 | Bestand gelesen, Entscheidungen klar, bei Bedarf Design-Dokument oder Spike | 🛑 nur, wenn der Prompt es verlangt |
| 2 | Rust: Tests zuerst, dann Umsetzung | |
| 3 | Frontend: Specs zuerst, dann Umsetzung | |
| 4 | Ende-zu-Ende in der echten App | |
| 5 | Doku | |
| 6 | Abschlussprüfung und Bericht | Commit nur nach Rückfrage |

Kleine Features legen Phasen zusammen. Reine Frontend-Features lassen Phase 2 aus.

### Phase 1: Bestand prüfen und entscheiden

- Die im Prompt genannten Code-Stellen lesen. Die Zeilenangaben dort sind Stand des Schreibens: Stimmen sie nicht mehr, die
  Stelle suchen und im Bericht vermerken.
- Für jede offene Frage im Prompt: Optionen, Empfehlung, Begründung. Was der Prompt schon entschieden hat, nicht neu aufrollen,
  außer der Code widerlegt eine Annahme. Dann anhalten und fragen.
- **Verträge zuerst:** Rust-Commands (Name, Parameter, Rückgabe, Fehlercodes, Channels), passende DTOs in `model.rs` und
  `log.models.ts`, Fehlercodes in `error.rs` und `app/core/errors/`, Tastenkürzel, ARIA-Rollen.
- Verlangt der Prompt einen Spike oder ein Design-Dokument (`prompts/NNN-<slug>.design.md` mit Status, Datum, Entscheidungen,
  Messwerten, Abschnitt „Fortschritt“): **danach anhalten** und die Freigabe abwarten.

### Phase 2: Rust

- Logik in Modulen ohne Tauri, nur `commands.rs` und `lib.rs` kennen Tauri. Commands bleiben dünn, Datei-Arbeit über
  `blocking` (`spawn_blocking`), nie auf dem Async-Runtime-Thread.
- **Der Text liegt nicht im Speicher.** Neue Daten je Zeile nur, wenn sie wirklich nötig sind. Der Index hat 16 Byte je Zeile,
  jede Erweiterung braucht eine Begründung und eine Messung.
- Lange Arbeit als Hintergrund-Job wie `run_filter`: abbrechbar über eine Generation, Fortschritt über `SessionUpdate`,
  Schreibsperre nur kurz. Der Tail darf nie auf einen Job warten.
- Tests mit `tempfile`, Helfer aus `tests/tail_integration.rs` (`open`, `append`, `wait`). Pflichtfälle, sofern sie das Feature
  berühren: UTF-8 mit Umlauten und Emoji, UTF-16, CRLF, ANSI, sehr lange Zeile, Zeile ohne Ende, leere Datei, Rotation
  (behalten und neu), Truncation, gelöschte Datei, Freeze. Plattformspezifisches mit `#[cfg(...)]`.
- Leistung: Wo Einlesen, Filter oder Suche betroffen sind, `measure_`-Test vorher und nachher
  (`cd src-tauri && cargo test --release --test tail_integration -- --ignored --nocapture measure_`), Werte in den Bericht.
- `npm run rust:fmt`, `npm run rust:lint`, `npm run rust:test` grün.

### Phase 3: Frontend

- Backend nur über `LogApi`, `invoke()` nur in `app/core/backend/call.ts`.
- Zoneless, `OnPush`, Signals, Standalone. Zustand je Tab in `SessionState`, Aktionen im `LogSessionService`, Einstellungen im
  `SettingsService` (neue Felder mit Vorgabe in `mergeSettings`, damit alte Dateien weiter laden).
- **Reine Logik in eigene Dateien mit Spec** (wie `viewport-logic.ts`, `displayed-lines.ts`, `filter-logic.ts`), Komponenten
  zeichnen nur.
- Tastatur: Ist Prompt 021 umgesetzt (`src/app/core/actions/`), kommen neue Kürzel nur als Aktion im Katalog mit
  Default in den Keymaps je OS, nie als eigener `keydown`-Handler. Davor: `onKey` in `log-table-view.ts` hängt am `document`, neue
  fokussierbare Bereiche mit eigenen Pfeiltasten dort ausnehmen, neue Kürzel gegen die vorhandenen prüfen (`README.md`,
  `log-table-view.ts`, `app.ts`, `toolbar.ts`).
- **Barrierefreiheit:** sichtbarer Fokus, jede Funktion per Tastatur, Dialoge mit `role="dialog"`/`aria-modal`, Fokus
  zurückgeben, Zustände mit `aria-pressed`/`aria-expanded`, Information nie nur über Farbe.
- Texte der Oberfläche auf Deutsch, Code und Kommentare auf Englisch. Logdaten sind Fremddaten: nie per `innerHTML`.
- Farben nur als Tokens in `src/styles.css`, für dark **und** light (siehe `docs/themes.md`), danach `npm run contrast`.
- `npm run format:check`, `npm run lint`, `npm test`, `npm run build` grün.

### Phase 4: Ende-zu-Ende

- `npm run e2e` (Debug-Build, echtes Backend, echte Datei). Neue Akzeptanzkriterien in `scripts/e2e/scenario.js`, ohne
  bestehende Prüfungen abzuschwächen. Neue Commands auch in `scripts/e2e/mock-ipc.js` (Screenshots).
- Sichttest von Hand: `npm run demo:log` und `npm run demo:app` (5000 Zeilen/s mit Rotation), hell und dunkel, schmales Fenster.
- Nicht abgedeckt durch `npm run e2e` und nur von Hand prüfbar: native Dialoge, Menü, Datei-Drop aus dem Finder, Zwischenablage.
  Was nicht geprüft werden konnte, steht ausdrücklich im Bericht.

### Phase 5: Doku

- `README.md` (Funktionen, Kürzel), `CLAUDE.md` (Entscheidungen, Grenzen, Layout, Befehle), `docs/architecture.md`
  (Entscheidungen, neue Abhängigkeiten mit Begründung), `docs/roadmap.md` (umgesetzt/offen), `docs/themes.md` bei neuen Tokens.
- Sichtbare Änderungen: Screenshots mit `npm run build` und `node scripts/screenshots.mjs` erneuern.
- **Fertige Prompts nach `prompts/done/` verschieben** (Auftrag, `*.design.md`, zugehörige Bilder; `git mv`). In `prompts/`
  liegen nur offene Prompts.

### Phase 6: Abschlussprüfung

```bash
npm run check
```

```bash
npm run e2e
```

Bei Sicherheitsrelevantem (Netz, Zugangsdaten, Nutzer-SQL, fremde Dateiformate) zusätzlich ein Review durch einen
separaten Agenten, der den Code nicht geschrieben hat. Die Schwerpunkte nennt der Feature-Prompt.

**Abschlussbericht** (kurz, konkret): Was wurde geändert, in welchen Dateien? Welche Befehle liefen tatsächlich, welche Checks
sind grün? Messwerte vorher/nachher. Probleme und Einschränkungen, auch nicht geprüfte Plattformen und Handprüfungen. Abweichungen
vom Prompt mit Grund. Nächster Schritt.

## 3. Definition of Done (zusätzlich zu der des Feature-Prompts)

- [ ] Design oder Spike freigegeben, falls der Prompt einen verlangt 🛑
- [ ] `npm run check` und `npm run e2e` grün
- [ ] Bei Eingriffen in Einlesen, Filter oder Suche: `measure_` nicht schlechter, Werte im Bericht
- [ ] Tastatur und Fokus geprüft, hell und dunkel angesehen, `npm run contrast` grün
- [ ] Doku aktuell, Prompt nach `prompts/done/` verschoben
- [ ] Kein Commit, kein Push ohne Rückfrage
