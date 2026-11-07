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
| Splitter | `--splitter-bg`, `--splitter-grip`, `--splitter-hover-bg` | Leiste, Griff in der Mitte, Hover/Ziehen (`shared/splitter.ts`) |
| Quellen (Merge) | `--src-1` … `--src-8`, Klasse `src-N` setzt `--src` | Streifen im Zeilenrand, Chips, Dialog, Baum und Statistik (Prompt 006); ab der neunten Quelle wiederholt, der Dateiname unterscheidet |
| Overview Ruler | `--ruler-bg`, `--ruler-band`, `--ruler-band-edge`, `--ruler-fatal`, `--ruler-error`, `--ruler-warn`, `--ruler-bookmark`, `--ruler-selection` | Leiste rechts (Prompt 007): Fläche, Band des sichtbaren Bereichs und seine Kanten, Level-Balken (FATAL und ERROR in der linken Spur, WARN in der rechten, Länge = Dichte), Lesezeichen (auch das Fähnchen `⚑` im Zeilenrand), Auswahl. Der Canvas liest sie per `getComputedStyle`, bei Themewechsel neu |
| Dashboard | `--chart-1` … `--chart-8`, `--chart-lv-<level>` (unknown, trace, debug, info, warn, error, fatal), `--chart-grid` | Reihen der Diagramme (Prompt 012), Reihen je Level in kräftigen Varianten der Level-Farben, Gitterlinien. Achsentext `--text-dim`, Fehler `--danger` auf `--bg-panel`. Der Canvas liest sie per `getComputedStyle`, bei Themewechsel neu |
| Inline-Tokens | `--tok-time`, `--tok-number`, `--tok-string`, `--tok-id`, `--tok-url` | Hervorhebung in der Zeile (`highlight.ts`) |

Alle Zellen einer Zeile (Rohansicht: Nummer und Text, Spaltenansicht: jede Spalte) tragen die Klasse `lv-<LEVEL>` (`table-logic.ts`). `log-table-view.css` setzt daraus Vorder- und
Hintergrund. FATAL ist als
einziges Level eine kräftige Fläche mit weißem Text, ERROR und WARN haben eine getönte Fläche und eine Markierung am Rand.

Filter-Tabs (Prompt 013) nutzen vorhandene Tokens: gestrichelte Linie und `↳` in `--text-dim` vor einem Tab, der den Tab
links von ihm weiter filtert.

## Kontrast (WCAG AA)

`npm run contrast` prüft in beiden Themes jedes Paar aus `PAIRS` in `scripts/check-contrast.mjs` auf mindestens 4,5:1: alle
Level-Paare, Text auf Flächen, Treffer, Inline-Tokens auf dem Info-Hintergrund und `--accent-text` auf `--accent`. Die Prüfung
läuft als erster Schritt in `npm run check`.

- Kopfzeile und Spaltenmenü der Spaltenansicht (Prompt 009) nutzen vorhandene Tokens (`--text` auf `--bg-panel`,
  `--bg-raised` und `--bg-hover`, `--text-dim` auf `--bg-raised`, Linien `--border`); diese Paare stehen in `PAIRS`.
- Das Detail-Panel (Prompt 004) nutzt ebenfalls nur vorhandene Tokens: Text und Inline-Tokens (`--tok-*`) auf `--bg-app`,
  JSON/XML-Farben aus denselben `--tok-*` (Schlüssel und Tags `--tok-url`, Strings `--tok-string`, Zahlen `--tok-number`,
  Attribute und Literale `--tok-id`, Satzzeichen und Kommentare `--tok-time`), Kopf auf `--bg-panel`, Level-Badge aus den
  Level-Paaren. Die Paare auf `--bg-app` stehen in `PAIRS`; der Splitter hat keinen Text.
- Wird ein neues Vordergrund/Hintergrund-Paar gebraucht, gehört es in `PAIRS`. Ein Token ohne Paar wird nicht geprüft.
- Grafische Elemente ohne Text brauchen 3:1 zum Hintergrund (WCAG 1.4.11). Dafür gibt es `GRAPHIC_PAIRS` mit Schwelle 3:
  der Griff der Splitter (`--splitter-grip`) auf der Leiste, im Hover und auf `--bg-app`/`--bg-panel`, `--accent` als
  Griff beim Ziehen, und die Level-Punkte der Statistik in der Seitenleiste auf `--bg-panel`. Die Leiste selbst hebt sich
  nur leicht ab, erkennbar ist sie am Griff; die Trefferfläche reicht 5 px über die 6 px breite Leiste hinaus.
- Quellfarben (Prompt 006): `--src-1` … `--src-8` sind Grafik (Streifen, Farbfeld) und stehen in `GRAPHIC_PAIRS` gegen
  `--bg-gutter`, `--row-selected`, `--bg-panel` und `--bg-raised`. Text in ihnen gibt es nicht, die Quelle steht immer als
  Name daneben.
- Overview Ruler (Prompt 007): alle Marken (`--ruler-fatal`, `-error`, `-warn`, `-bookmark`, `-selection`) stehen in
  `GRAPHIC_PAIRS` gegen `--ruler-bg` und `--ruler-band` (Marken liegen auch im Band), dazu die Kante des Bands gegen
  `--ruler-bg` und das Lesezeichen gegen `--bg-gutter` und `--row-selected`. Der Ruler hat keinen Text; welches Level eine
  Marke ist und wie dicht, sagt der Tooltip. Die Balken sind immer voll deckend (Dichte über die Länge, nicht über
  Transparenz), damit die geprüften Kontraste auch für dünn besetzte Stellen gelten. `--ruler-fatal` hell ist ein
  gedecktes Violett (`#7e3a8c`, vorher `#a21caf`): Es liegt in dichten Logs neben `--ruler-error` und soll dort nicht
  schreien.
- Dashboard (Prompt 012): `--chart-*` und `--chart-lv-*` stehen in `GRAPHIC_PAIRS` gegen `--bg-panel` (Panelfläche),
  `--danger` auf `--bg-panel` in `PAIRS`. Gitterlinien (`--chart-grid`) sind Zierde und werden nicht geprüft. Jede
  Reihe steht mit Namen und Wert in der Legende, Kreisstücke mit Name, Wert und Anteil daneben.
- Seitenleiste (Prompt 005): aktuelle Datei mit `--text` auf `--row-selected` (in `PAIRS`), sonst vorhandene Tokens.
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
