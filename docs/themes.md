# Farben und Themes

Log Commander hat zwei Themes, **dark** und **light**, und lässt die Level-Farben in den Einstellungen anpassen. Alle Farben
stehen als Design-Tokens an einer Stelle: `src/styles.css`. Komponenten verwenden nur `var(--…)`, nie feste Farbwerte.

## Aufbau von `src/styles.css`

```css
/* @theme dark */
:root { --bg-app: #14171c; … }
/* @end */

/* @theme light */
:root[data-theme='light'] { --bg-app: #fbfbfc; … }
/* @end */

:root { --font-ui: …; --font-mono: …; --radius: 5px; }   /* ohne Farbe, gilt für beide */
```

- **dark** ist der Grundwert auf `:root`, **light** überschreibt ihn über `data-theme='light'`.
- Die Blöcke zwischen `/* @theme <name> */` und `/* @end */` liest `scripts/check-contrast.mjs`. Jeder Farb-Token steht in
  **beiden** Blöcken als sechsstelliger Hex-Wert, sonst bricht die Prüfung ab.
- Werte ohne Farbe (Schriften, Radius) stehen außerhalb der Blöcke.

## Auswahl des Themes

Einstellung `theme`: `system` (Standard), `dark`, `light`. Der `SettingsService` setzt `data-theme` auf `<html>`. Bei
`system` folgt er `prefers-color-scheme` und reagiert auf Änderungen zur Laufzeit. Der Fensterhintergrund vor dem Start
(`backgroundColor` in `tauri.conf.json`) ist der dunkle Wert von `--bg-app`, damit beim Öffnen nichts weiß aufblitzt.

## Tokens

| Gruppe | Tokens | Wofür |
|---|---|---|
| Flächen | `--bg-app`, `--bg-panel`, `--bg-raised`, `--bg-hover`, `--bg-gutter`, `--border` | Fenster, Leisten, Menüs, Hover, Zeilennummern, Linien |
| Text | `--text`, `--text-dim` | Normaler und gedämpfter Text |
| Akzent und Status | `--accent`, `--accent-text`, `--danger`, `--ok` | Fokus, aktive Elemente, Primär-Button, Fehler, Erfolg |
| Auswahl und Treffer | `--row-selected`, `--hit-bg`, `--hit-text`, `--hit-current-bg`, `--hit-current-text` | Gewählter Eintrag, Suchtreffer, aktueller Treffer |
| Level | `--lv-<level>-fg`, `--lv-<level>-bg` für `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `unknown`; dazu `--lv-info-badge`, `--lv-error-edge` | Zeilenfarbe je Level, Markierung am Zeilenrand |
| Inline-Tokens | `--tok-time`, `--tok-number`, `--tok-string`, `--tok-id`, `--tok-url` | Hervorhebung in der Zeile (`highlight.ts`) |

Beide Zellen einer Zeile tragen die Klasse `lv-<LEVEL>` (`table-logic.ts`). `log-table-view.css` setzt daraus Vorder- und
Hintergrund. FATAL ist als
einziges Level eine kräftige Fläche mit weißem Text, ERROR und WARN haben eine getönte Fläche und eine Markierung am Rand.

## Kontrast (WCAG AA)

`npm run contrast` prüft in beiden Themes jedes Paar aus `PAIRS` in `scripts/check-contrast.mjs` auf mindestens 4,5:1: alle
Level-Paare, Text auf Flächen, Treffer, Inline-Tokens auf dem Info-Hintergrund und `--accent-text` auf `--accent`. Die Prüfung
läuft als erster Schritt in `npm run check`.

- Wird ein neues Vordergrund/Hintergrund-Paar gebraucht, gehört es in `PAIRS`. Ein Token ohne Paar wird nicht geprüft.
- Grafische Elemente ohne Text (Ruler-Marken, Diagramme) brauchen 3:1 zum Hintergrund. Die Prüfung kennt das noch nicht. Wer
  solche Tokens einführt, ergänzt eine zweite Liste mit Schwelle 3.
- Farbe ist nie die einzige Information: Level steht als Wort in der Zeile, Zustände haben Text oder Symbol.

## Eigene Level-Farben

In den Einstellungen lassen sich die Tokens aus `COLOR_TOKENS` (`settings.models.ts`) überschreiben: Text, Hintergrund,
Badge und Rand der Level. Gespeichert wird `colorOverrides` (Token-Name ohne `--` → CSS-Farbe), der `SettingsService` setzt sie
als Inline-Style auf `<html>`, und zwar nur Tokens mit Präfix `lv-`.

- Overrides gelten für **beide** Themes. Wer zwischen hell und dunkel wechselt, behält dieselbe Farbe.
- Sie werden nicht auf Kontrast geprüft, es ist die Wahl des Nutzers. Der Dialog hat je Token einen Farbwähler, die Wirkung
  ist sofort in der Log-Ansicht dahinter zu sehen.
- „Farben zurücksetzen“ leert `colorOverrides` ganz, danach gelten wieder die Werte aus `styles.css`.

## Ein Token hinzufügen

1. In **beide** Blöcke von `src/styles.css` eintragen, mit sinnvollem Wert für dark und light.
2. Paar in `PAIRS` von `scripts/check-contrast.mjs` ergänzen, wenn Text darauf steht.
3. `npm run contrast`, dann beide Themes ansehen (Sichttest oder `node scripts/screenshots.mjs`, das `dark.png` und
   `light.png` erzeugt).
4. Soll der Token einstellbar sein: in `COLOR_TOKENS` aufnehmen. Präfix `lv-`, sonst ignoriert der `SettingsService` ihn.

## Ein weiteres Theme

Geplant mit `prompts/020-farbschemata-look-and-feel.md` (Schemata als JSON, Picker, nach dem Vorbild von files-and-folders).
Bis dahin gilt: Dafür müssten `check-contrast.mjs` (erwartet genau zwei Blöcke), `ThemeChoice` und
`mergeSettings` (`settings.models.ts`), die Auswahl im Einstellungsdialog und die Bestimmung von `data-theme` im
`SettingsService` erweitert werden. Ein neues Theme definiert alle Farb-Tokens und besteht alle Paare ohne Korrektur zur
Laufzeit. Übernommene Farben fremder Themes: Herkunft und Lizenz hier in einer Tabelle festhalten.
