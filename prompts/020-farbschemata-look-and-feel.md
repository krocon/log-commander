# Prompt 020: Farbschemata umschalten (Look and Feel)

> Start in neuer Sitzung: „Lies `prompts/000-arbeitsweise.md` und führe `prompts/020-farbschemata-look-and-feel.md` aus.“
> Unabhängig von den anderen Prompts. Wer danach Canvas-Teile baut (007, 012, 014), hängt sich an `ThemeService.applied`.
> Vorbild: files-and-folders-tauri (`/Users/marckronberg/WebstormProjects/files-and-folders-tauri`), dort zuerst lesen:
> `src/app/core/theme/` (`theme.service.ts`, `theme.models.ts`, `builtin-themes.ts`, `theme-logic.ts`, `tokens.ts`),
> `src/app/features/themes/` (Picker, Vorschaubild, Editor), `docs/themes.md` sowie die Design-Dokumente
> `prompts/done/013-themes-farbschemata.design.md` und `prompts/done/070-theme-picker.design.md`.
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

Statt nur „Hell/Dunkel/System“ wählt man ein **Farbschema** aus einer Galerie mit Vorschaubildern: neben dark und light
etwa One Dark, True Black, Solarized Light, Matrix, Amber oder C64. Pfeiltasten zeigen ein Schema sofort an, `Enter` behält
es, `Esc` kehrt zurück. „System folgen“ nimmt je ein wählbares helles und dunkles Schema. In Phase 2 kommen eigene Schemata
dazu: bearbeiten, importieren, exportieren.

## Was übernommen wird und was nicht

| files-and-folders | Hier | Grund |
|---|---|---|
| Schema = `{ id, name, dark, tokens }` als JSON in `core/theme/themes/` | übernehmen | Bewährt, lesbar, gleiche Form für eingebaute und eigene Schemata. |
| Auswahl `{ mode: system \| fixed, theme, light, dark }` | übernehmen | „System folgen“ mit eigenem Paar ist der Grund, warum man mehrere Schemata will. |
| `ThemeService`: Tokens inline auf `<html>`, `data-theme`, `color-scheme`, `meta theme-color`, Vorschau-Signal | übernehmen | Ein Ort für alles, was ein Schema sichtbar macht. |
| Fensterrahmen per Rust (`set_window_chrome`: `set_theme` + `set_background_color`) | übernehmen | Sonst bleibt die Titelleiste unter macOS im falschen Hell/Dunkel. |
| Picker mit Vorschaubildern aus Tokens, Filter, Live-Vorschau | übernehmen, Bild zeigt Log-Zeilen statt Dateiliste | Kernstück des Wunsches. |
| Editor, Import, Export eigener Schemata | Phase 2 | Nützlich, aber doppelt so viel Arbeit wie der Rest. |
| Alte Designs (`classic-…`), automatische Kontrast-Korrektur, Format `--fnf-*` | **nicht** übernehmen | Gibt es hier nicht. Schemata erfüllen den Kontrast ohne Korrektur zur Laufzeit. |
| `themes.json` über eigene Rust-Commands | **nicht**: `tauri-plugin-store` wie die übrigen Einstellungen | Es gibt schon einen Store. Prüfen und Bereinigen passiert im Frontend (siehe Fallen). |
| Aktionssystem, Menü-Radio-Einträge über `ActionService` | angepasst: ein Menüpunkt öffnet den Picker | Ein Aktionssystem gibt es hier nicht. Radio-Einträge im nativen Menü wären ein eigener Umbau von `lib.rs`. |

## Entscheidungen

| Thema | Entscheidung | Warum |
|---|---|---|
| Basis | `src/styles.css` bleibt die Quelle für **dark** und **light**. Andere Schemata enthalten nur Abweichungen und werden je nach `dark` aus der passenden Basis ergänzt | Kein zweiter Ort für die Grundwerte. Ein Token, den ein Schema vergisst, ist nie leer. |
| Tokens | Katalog `core/theme/tokens.ts` mit Gruppe, deutschem Namen und Art (`color` oder `font`). `--font-mono` und `--font-ui` dürfen je Schema anders sein (Matrix, Amber: Monospace überall) | Ein Ort für Editor, Prüfung und Vollständigkeitstest, wie in files-and-folders. |
| Kontrast | Paare in **einer** Datei `core/theme/contrast-pairs.json` mit Schwelle (Text 4,5, Grafik 3). `scripts/check-contrast.mjs` liest sie **und** alle Schemata, ein Vitest prüft dasselbe | Heute stehen die Paare nur im Skript. Editor und Import brauchen sie im Frontend. |
| Eigene Level-Farben | `colorOverrides` bleibt und liegt über jedem Schema | Wer nur ERROR anders will, soll kein ganzes Schema anlegen müssen. |
| Herkunft | Farbwerte fremder Themes nur als Werte, Herkunft und Lizenz in `docs/themes.md` | Wie in files-and-folders, keine Dateien der Originale im Build. |

## Eingebaute Schemata

Ziel ist die Liste aus files-and-folders ohne die alten Designs: One Dark, One Dark Vivid, True Dark, True Black, True Light,
Matrix, Amber, Solarized Light, Mystico C64, Crimson, Rainglow Bold, Earthsong, Legacy, Heroku, Piggy.

- **Abbilden:** Ein einmaliges Skript `scripts/theme-from-fnf.mjs <fnf-theme.json>` übersetzt die Tokens von
  files-and-folders (`--color-bg`, `--color-surface`, `--color-text`, `--color-muted`, `--color-accent`, `--color-selection`,
  `--color-search-hit`, `--color-danger*`, `--color-list-*`) auf die Tokens hier (`--bg-app`, `--bg-panel`, `--text`,
  `--text-dim`, `--accent`, `--row-selected`, `--hit-*`, `--danger`). Mit Test, wie `rainglow-theme.test.mjs` dort.
- **Level- und Inline-Farben gibt es dort nicht.** Sie kommen aus der Palette des Originals, die `docs/themes.md` von
  files-and-folders nennt: Fehler aus dem Rot, Warnung aus Gelb oder Orange, Debug aus Cyan, Trace aus dem gedämpften Text,
  Zeit, Zahl, String, ID, URL aus den Syntaxfarben. Getönte Flächen für WARN, ERROR und FATAL von Hand abstimmen. Das ist der
  eigentliche Gestaltungsteil: Jedes Schema im Sichttest mit `npm run demo:log` ansehen, nicht nur rechnerisch prüfen.
- **Reihenfolge:** zuerst ein Satz von sechs (One Dark, True Black, True Light, Solarized Light, Matrix, Amber), Picker und
  Prüfung damit fertig bauen, dann den Rest. Rainglow lässt sich mit `scripts/rainglow-theme.mjs` aus files-and-folders als
  Vorlage erzeugen.
- Abweichungen vom Original wegen Kontrast werden je Schema in `docs/themes.md` festgehalten, wie dort.

## Phase 1: Auswahl und Picker

1. **Modelle und Logik** in `src/app/core/theme/`: `theme.models.ts`, `builtin-themes.ts`, `tokens.ts`, reine Funktionen in
   `theme-logic.ts` (ergänzen aus der Basis, Wert prüfen, Farbe auflösen inkl. `var(--…)`, Kontrast). Specs dazu.
2. **Basiswerte im Frontend:** Für Vorschaubilder und Prüfung braucht das Frontend dark und light als Werte. Nicht von Hand
   doppeln: Ein Build-Schritt oder ein Test liest die `@theme`-Blöcke aus `styles.css` und vergleicht sie mit
   `themes/dark.json` und `themes/light.json`. Abweichung ist ein roter Test.
3. **`ThemeService`** (Root): `selection`, `systemDark` (aus `matchMedia`, live), `preview`, `active`, `applied`. `apply` setzt
   nur Tokens aus dem Katalog per `style.setProperty`, entfernt beim Wechsel, was das vorige Schema gesetzt hat, und legt
   danach `colorOverrides` darüber. Dazu `data-theme`, `color-scheme`, `meta theme-color`.
4. **`SettingsService` abgeben:** Er setzt heute `data-theme` und die `--lv-`-Overrides selbst (`settings.service.ts:65` ff.).
   Das wandert in den `ThemeService`, sonst überschreiben sich beide. `Settings.theme` wird zu `themeSelection`. Migration in
   `mergeSettings`: `system` → System folgen mit light/dark, `dark`/`light` → fest.
5. **Fensterrahmen:** Command `set_window_chrome(color, dark)` in `commands.rs` mit `set_theme` und `set_background_color` des
   Fensters `main`, Farbe nur als `#rrggbb` angenommen. Kein Plugin, keine neue Capability nötig.
6. **Picker** `features/themes/theme-picker.ts`: Dialog mit Raster aus Karten, „System folgen“ zuerst, dann dunkle und helle
   Schemata, später „Eigene“. Filter (Wörter in Name, „hell“/„dunkel“), Zähler als `role="status"`. Raster als `listbox` mit
   `aria-activedescendant`. Pfeile und Zeiger setzen `preview`, `Enter`/OK wählt, `Esc`/Abbrechen/Schließen setzt zurück.
   Bei „System folgen“ zwei Auswahlfelder für das helle und das dunkle Schema.
7. **Vorschaubild** `theme-thumb.ts`: Mini-Log aus den Tokens des Schemas, ohne Bilddateien: Toolbar-Streifen, fünf Zeilen
   (TRACE, INFO mit Zeit und Zahl, WARN, ERROR mit Rand, FATAL), eine gewählte Zeile, ein Treffer, Statusleiste. Nur aufgelöste
   `#rrggbb` gelangen als `--thumb-*` in den Stil der Karte.
8. **Einstieg:** Menüpunkt „Ansicht ▸ Farbschema …“ in `build_menu` (`lib.rs`, Event wie `menu-open`), Auswahl im
   Einstellungsdialog (ersetzt das heutige Select), Button in der Toolbar. Kürzel `Cmd/Ctrl+Alt+T`, vorher gegen `README.md`,
   `log-view.ts`, `app.ts` und die offenen Prompts prüfen (`Cmd/Ctrl+Shift+T` ist für 013 vergeben).
9. **Prüfung:** `contrast-pairs.json` mit den heutigen 18 Paaren plus `--accent` als Grafik auf `--bg-panel` (3:1) und
   `--lv-error-edge` auf `--lv-error-bg` (3:1). `check-contrast.mjs` prüft dark und light aus `styles.css` und jedes JSON-Schema
   ergänzt aus seiner Basis. Ausgabe nennt Schema, Paar und Wert. Gleiche Prüfung als Vitest für den Editor.
10. **Screenshots:** `scripts/screenshots.mjs` um den Picker und drei Schemata erweitern, `mock-ipc.js` für den neuen Command.

## Phase 2: Eigene Schemata (Editor, Import, Export)

1. „Bearbeiten …“ aus dem Picker: Dialog mit den Gruppen aus `tokens.ts`, je Token Farbwähler und Textfeld, Vorschau live über
   `preview`, Kontrast-Hinweise je Paar sofort sichtbar, Speichern, Speichern unter, Löschen, Zurücksetzen. Speichern schreibt
   nur die Abweichungen von der Basis (`diffTokens`), damit spätere Korrekturen an dark und light ankommen.
2. Gespeichert im Store unter `themes` (`{ version: 1, themes: [...] }`), höchstens 50 Schemata und 300 Tokens je Schema.
3. **Import:** Öffnen-Dialog, Datei lesen über einen eigenen Command `import_theme(path)` (höchstens 256 KiB, nur
   JSON-Objekt; `tauri-plugin-fs` gibt es bewusst nicht). Das Frontend bereinigt (nur Katalog-Tokens, nur gültige Werte).
   Ausgewählt wird ein Import nur, wenn er alle Paare besteht, sonst mit Liste der Probleme gespeichert.
4. **Export:** Speichern-Dialog (`dialog:allow-save` neu in die Capability), Command `export_theme(path, content)` schreibt
   `<name>.theme.json` mit allen Tokens und überschreibt nie.

## Fallen

- **Werte sind Nutzereingaben** und landen per `setProperty` im Stil. Nur Katalog-Tokens, nur Farben (`#hex`, `rgb()`, `hsl()`,
  `var(--…)` auf Katalog-Tokens), bei Schriften nur Familiennamen. Kein `url(`, kein `;`, kein `}`. Die Prüfung aus
  files-and-folders (`isSafeValue`, `applicableToken`) übernehmen, mit Specs.
- **Start ohne Blitz:** `backgroundColor` in `tauri.conf.json` ist dunkel. Mit hellem Schema blitzt es beim Start. Fenster
  unsichtbar starten (`"visible": false`) und nach dem ersten `apply` zeigen, mit Zeitlimit von 1 s, damit ein Fehler kein
  unsichtbares Fenster hinterlässt. Mit `tauri-plugin-window-state` testen.
- **System folgen und Rahmen:** Das Erscheinungsbild des Fensters bestimmt unter macOS auch `prefers-color-scheme` der WebView.
  Ein umgeschalteter Rahmen schaltet sonst das Schema um, eine Schleife. Lösung wie in files-and-folders,
  `applyWindowChrome` in `theme.service.ts`.
- **Zeichnen auf Canvas** (007, 012, 014) liest Farben per `getComputedStyle`. Ein Effekt auf `ThemeService.applied` muss neu
  zeichnen, auch bei der Vorschau im Picker.
- **Overrides und Vorschau:** Eigene Level-Farben liegen auch in der Vorschau über dem Schema. Im Picker einen Hinweis zeigen,
  wenn welche aktiv sind, sonst wirkt die Vorschau falsch.
- **Tail während der Vorschau:** Pfeiltasten im Picker dürfen die Log-Ansicht nicht bewegen. `onKey` in `log-view.ts:352` nimmt
  `dialog` schon aus, mit dem neuen Dialog prüfen.
- Bundle: 15 JSON-Schemata sind klein, trotzdem `npm run build` vorher und nachher vergleichen.

## Tests

- **Vitest:** jedes eingebaute Schema vollständig nach Ergänzung und besteht alle Paare. dark/light gleich `styles.css`.
  Migration der alten Einstellung `theme`. `ThemeService`: fest, System folgen, Wechsel des Systems, Vorschau und Rücksprung,
  Entfernen alter Tokens, Overrides obenauf. Wertprüfung mit bösartigen Werten. Picker: Filter, Tastatur, `Esc` stellt zurück.
  Phase 2: Speichern nur Abweichungen, Import mit Problemen wird nicht ausgewählt.
- **Skripte:** `scripts/theme-from-fnf.test.mjs`, `check-contrast.mjs` mit einem absichtlich schlechten Schema (Test-Fixture).
- **Rust:** `set_window_chrome` lehnt Nicht-Hex ab. Phase 2: Import-Größe, kein Überschreiben beim Export.
- **e2e:** Picker öffnen, Schema per Pfeil und `Enter` wählen, berechnete Farbe einer ERROR-Zeile entspricht dem Schema, nach
  Neustart noch aktiv, `Esc` stellt zurück.

## Fertig, wenn

- [ ] Phase 1: mindestens sechs Schemata, alle 15 vor Abschluss, `npm run contrast` prüft alle
- [ ] `npm run check` und `npm run e2e` grün
- [ ] Jedes Schema im Sichttest mit laufendem Tail angesehen, Fensterrahmen auf macOS passend, kein Blitz beim Start
- [ ] Phase 2 umgesetzt oder als offener Folgeschritt im Bericht und in `docs/roadmap.md`
- [ ] `docs/themes.md` (Schemata, Herkunft und Lizenz, Abweichungen, Abschnitt „Ein weiteres Theme“ ersetzt), `docs/architecture.md`,
      `README.md`, `CLAUDE.md` (Layout `core/theme/`, `features/themes/`) ergänzt, Screenshots erneuert

Kein Commit ohne Rückfrage.
