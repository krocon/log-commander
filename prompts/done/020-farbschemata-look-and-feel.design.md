# Design 020: Farbschemata (Look and Feel)

- **Status:** Phase 1 umgesetzt, Phase 2 (Editor, Import, Export) offen (`docs/roadmap.md`)
- **Datum:** 08.11.2026
- **Branch:** `feat/farbschemata`
- Marc hat die Prompts zur autonomen Abarbeitung freigegeben: Wo Prompt oder 000 einen Haltepunkt vorsehen, ist hier
  entschieden und begründet.

## Entscheidungen

| Frage | Optionen | Entscheidung | Grund |
|---|---|---|---|
| Phase 2 jetzt? | (a) mitbauen, (b) Folgeschritt | **(b)** | Der Prompt erlaubt es. Editor, zwei Rust-Commands, Store und Import-Prüfung verdoppeln Umfang und Angriffsfläche; Phase 1 mit allen 15 Schemata hat Vorrang. Die reinen Funktionen (`tokenValueOk`, `sanitizeTokens`, `diffTokens`, `checkContrast`) sind schon da und getestet. |
| Bundle (996 von 1000 KB) | (a) Schemata im Startbundle, (b) CSS-Blöcke je Schema, (c) Lazy-Chunk | **(c)** | Die 17 JSON kosten ~33 KB. Der Startbundle kennt nur Ids und Helligkeit (`BUILT_IN_DARK`, Test gegen die Dateien), dark und light brauchen nichts zu laden (sie sind `styles.css`). Ein anderes Schema lädt vor dem Zeigen des Fensters. Farbparser, Katalog und Logik liegen ebenfalls im Lazy-Chunk; für eigene Level-Farben reicht im Startbundle ein Regex. |
| Budget trotzdem knapp | Budget anheben, Code verschieben | **Bedingungsdialog der Seitenleiste per `@defer`** | Der eager Teil (ThemeService, Modelle) kostet ~5 KB. `condition-dialog` (12,6 KB) war der einzige Dialog, der noch eager geladen wurde. Ergebnis 989,49 KB statt 996,27 KB. Budget unverändert. |
| `--bg-app` aus files-and-folders | `--color-bg` (Prompt), `--color-list-bg` | **`--color-list-bg`** | `--color-bg` ist dort der Rahmen hinter den Panels, die Log-Fläche entspricht der Liste (One Dark: Editor `#282c34`). Rest der Abbildung wie im Prompt. |
| Level- und Inline-Farben | von Hand je Schema, abgeleitet | **abgeleitet aus Icon-/Usage-Farben (Palette des Originals), plus Rezept von Hand** | 15 Schemata × 75 Tokens von Hand wären fehleranfällig. `scripts/theme-from-fnf.mjs` liest die Palette in ein Rezept (`scripts/theme-recipes.json`), von Hand nachbearbeitet (FATAL, Solarized-Text, Crimson-Fläche, Piggy), dann alle Tokens. |
| Kontrast | zur Laufzeit, beim Erzeugen | **einmalig beim Erzeugen** | Prompt: „ohne Korrektur zur Laufzeit“. Verfehlt ein Vordergrund sein Paar, wird er zu Weiß/Schwarz verschoben; ist er die Lesefarbe (`--text`, FATAL-Text), der Hintergrund. Ein Test hält Dateien = Rezepte. |
| Rahmen bei „System folgen“ | immer erzwingen (files-and-folders), System überlassen | **`dark = null` → `set_theme(None)`** | Ein erzwungenes Erscheinungsbild legt `prefers-color-scheme` der WebView fest, „System folgen“ würde dann einen Systemwechsel nicht mehr sehen. Das Schema folgt demselben System, Rahmen und Schema passen also. Signatur daher `set_window_chrome(color, dark: Option<bool>)`. |
| Fensterrahmen-Farbe | `--bg-panel`, `--bg-app` | **`--bg-app`** | Hintergrund beim Vergrößern ist die Log-Fläche. |
| Start ohne Blitz | – | `visible: false`, erster `set_window_chrome` nach dem Laden der Einstellungen zeigt das Fenster, Rust-Thread zeigt es nach 1 s sicher; `tauri-plugin-window-state` ohne `VISIBLE` | Wie im Prompt. Im e2e-Lauf startet das Fenster sichtbar (`e2e.rs`), damit ein späteres `show()` es nicht nach vorn holt. |
| Menü | „Ansicht ▸ Farbschema …“ | **View ▸ „Colour Scheme…“** (`CmdOrCtrl+Alt+T`) | Das native Menü ist durchgehend englisch (File → Open… usw.). |
| Kürzel | `Cmd/Ctrl+Alt+T` | wie Prompt, geprüft gegen README, `app.ts`, `log-table-view.ts`, `toolbar.ts`, 021 | Frei. Erkannt über `event.code === 'KeyT'`, weil Alt unter macOS `key` ändert (†). |
| Einstellungsdialog | Select mit allen Schemata, Knopf | **Name + Knopf „Farbschema wählen …“** öffnet den Picker | Ein Select ohne Vorschau wäre ein zweiter, schlechterer Picker. |
| Toolbar „◐“ | weiter zyklisch, Picker | **öffnet den Picker** | Drei Zustände reichen bei 17 Schemata nicht. |
| Canvas neu zeichnen | Effekt auf `applied`, vorhandener Observer | **vorhandener `MutationObserver`** auf `data-theme`/`style` (Ruler, Zeitstrahl, Dashboard) | Jede Änderung des ThemeService, auch die Vorschau, setzt `style` auf `<html>`. Kein zweiter Mechanismus. |
| Neustart im e2e | Neustart, Store prüfen | **Store prüfen** (`expectsettings` im Harness liest `settings.json`) | Ein Neustart des Fensters würde das Szenario neu laden. Was im Store steht, gilt nach dem Neustart (Migration getestet). |
| Grafikpaare neu | – | `--accent` auf `--bg-panel`, `--lv-error-edge` auf `--lv-error-bg` (3:1) | wie Prompt; dark/light bestehen ohne Änderung. |

## Messwerte

- Startbundle: vorher 996,27 KB, nachher 989,49 KB (Budget 1 MB unverändert). Lazy: Schemata ~33 KB, Katalog/Logik
  9 KB, Picker 16 KB.
- Kontrast: 32 Textpaare, 83 Grafikpaare in dark, light und 15 weiteren Schemata, alle grün ohne Laufzeitkorrektur.
- Einlesen, Filter, Suche nicht berührt: kein `measure_` nötig.

## Fortschritt

- [x] Modelle, Katalog, Logik, Farbparser mit Specs (`core/theme/`)
- [x] `contrast-pairs.json`, `check-contrast.mjs` über alle Schemata, Fixture-Test, dark/light-Gleichheit
- [x] `theme-from-fnf.mjs` + Rezepte + Test, 15 Schemata
- [x] `ThemeService`, Migration `theme` → `themeSelection`, `SettingsService` abgegeben
- [x] `set_window_chrome` (Rust, Test auf Nicht-Hex), unsichtbarer Start, Menüpunkt
- [x] Picker, Vorschaubild, Einstieg Toolbar/Menü/Kürzel/Einstellungen
- [x] Screenshots (Picker, je Schema ein Bild), e2e-Schritte, Doku
- [ ] Phase 2: Editor, Import, Export (offen)
- [ ] Von Hand: Sichttest jedes Schemas mit `npm run demo:log`, Rahmen auf macOS, kein Blitz beim Start mit hellem
      Schema, Menüpunkt, Wechsel des System-Erscheinungsbilds bei „System folgen“
