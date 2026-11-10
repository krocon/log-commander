# Produktseite Log Commander

Statische Seite auf Englisch, fünf HTML-Dateien mit einem gemeinsamen Stylesheet und einem Skript.
**Keine Webfonts, keine Tracker, keine Anfragen an fremde Server, keine Cookies.** Ohne JavaScript bleibt alles
lesbar; das Skript liefert nur Bewegung und die Live-Demo.

| Datei | Inhalt |
|---|---|
| `index.html` | Start: Live-Demo im Hero (simuliertes Log mit Level-Chips, Suche, Freeze, Zeitstrahl, Ruler), Messwerte, Tour mit angeheftetem Fenster, Quellen-Diagramm, KI, Farbschemata, Plattformen |
| `features.html` | alle Funktionen in vier Kapiteln (Read, Find, See, Keep) mit Screenshots |
| `sources.html` | Syslog, SSH/SFTP, Windows-Ereignisse, Datenbanken und ihre Sicherheitsregeln |
| `ai.html` | KI-Steuerung über MCP: Beispiele, 31 Tools in drei Stufen, Einrichtung, Datenschutz |
| `keyboard.html` | alle Kürzel (aus der README erzeugt), Tasten der Widgets, Messwerte, Fragen |
| `site.css`, `site.js` | Design-Tokens der App (dark/light nach System), Bewegung, Demo |
| `img/` | Screenshots als WebP (1600 px), erzeugt aus `docs/screenshots/` |

## Bauen

```bash
node site/build.mjs
```

Erzeugt `img/*.webp` (braucht `cwebp`, z. B. `brew install webp`), `favicon.png`, `img/icon.png` und schreibt die
Kürzel-Tabelle in `keyboard.html` aus dem generierten Block der `README.md`. Mit `--no-images` nur die Tabelle.
Nach neuen Screenshots (`node scripts/screenshots.mjs`) oder geänderten Keymaps erneut ausführen.

## Ansehen und hochladen

Lokal `site/index.html` im Browser öffnen (geht auch über `file://`). Zum Veröffentlichen den **Inhalt** von `site/`
ohne `build.mjs` und `README.md` auf den Webspace kopieren; alle Pfade sind relativ. `og:image` ist ebenfalls relativ
und sollte nach dem Hochladen auf die absolute Adresse gesetzt werden.

## Hinweise

- **Aussagen wie in der README:** Messwerte, Grenzen, Plattformen und „nicht signiert“ stammen von dort. Ändert sich
  die README, die Seite mitziehen.
- **Motion:** Jede Bewegung hat eine Fassung für `prefers-reduced-motion` (die Demo steht dann still und gefüllt).
- **Die Seite als Log:** Jeder Abschnitt hat `data-lv` und `data-title`; daraus baut `site.js` den Ruler am rechten
  Rand (wie der Overview Ruler der App). Neue Abschnitte brauchen dazu eine `id`.
- **Video:** Der Abschnitt „Watch it run“ auf der Startseite zeigt zuerst ein lokales Standbild. Erst der Klick lädt
  den Player von `youtube-nocookie.com` (16:9, auf schmalen Bildschirmen das Short 9:16; IDs in `data-wide` und
  `data-tall`). Ohne JavaScript und über `file://` führt der Klick zu YouTube. Das ist die einzige Stelle mit einem
  fremden Server; der Fuß der Startseite sagt es.
- **Demo:** rein im Browser erzeugt (`liveDemo` in `site.js`), sie liest nichts und sendet nichts.
