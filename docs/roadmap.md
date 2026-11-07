# Roadmap

Stand der Anforderungen aus dem Fachkonzept. Die sechs Phasen des Startauftrags sind umgesetzt; der Rest ist Backlog, die
Architektur verbaut nichts davon.

## Umgesetzt

- Live Tail, Autoscroll-Steuerung, Freeze je Tab, Rotation und Truncation, Chunk-basiertes Nachladen
- Format-Erkennung (JSON, Log4j/Logback, nginx/Apache, Syslog), Multi-Line-Blöcke beim Filtern
- Formaterkennung mit Feldern je Zeile (Prompt 008): Layouts für alle Profile, neu Common/Combined Log, W3C/IIS, NLog,
  Java GC, FIX, logfmt; Inferenz für Unbekanntes; Layouts und Vorschau in eigenen Profilen; `timestamp.rs` für 006
- Level-Chips, Volltextsuche mit Regex, Groß-/Kleinschreibung, Match-Highlighting, Farbcodierung nach Level
- Log-Ansicht auf der GuiExpert Table (Prompt 003), feste Zeilenhöhe, kein Umbruch
- Spaltenansicht mit Kopfzeile (Prompt 009) auf der GuiExpert Table: Breite ziehen und per Doppelklick anpassen,
  Reihenfolge ziehen, Spaltenmenü (`Shift+F10`, Rechtsklick), Layout je Profil, Rohansicht per `T`
- Detail-Panel (Prompt 004): ganzer Eintrag der gewählten Zeile ohne Filter und Kürzung, JSON/XML formatiert (eigener
  Tokenizer), Höhe per Splitter, `D` und Doppelklick
- Seitenleiste (Prompt 005): Baum mit Dateien, aktivem Filter (`×` entfernt) und gespeicherten Filtern, Statistik
  „Alle“/„Ansicht“ je Level samt Dateigröße, Klick filtert; Breite und Teilung per Splitter, `Cmd/Ctrl+B`, unter
  900 px automatisch ausgeblendet. Splitter mit sichtbarem Griff
- Dateien zusammenführen (Prompt 006): bis 16 Dateien als ein Tab nach Zeitstempel, Quelle im Zeilenrand (Name und
  Farbe), Quellenfilter als Chips, Quelldateien im Baum und in der Statistik, live mit 1 s Haltepuffer, verspätete
  Zeilen gezählt, „Neu sortieren“

- Verkettete Filter (Prompt 010): Filterbaum in der Seitenleiste mit Gruppen UND/ODER, NICHT, an/aus, Verschieben
  (`Alt+↑/↓`, Ziehen); Bedingungen Text/Regex, Level, Feld, Zeit, Abschnitt zwischen Marken, Zeilen; je Eintrag
  ausgewertet; Schnellwege `I`/Rechtsklick „Filtern auf …“, Zellwert, „Abschnitt ab/bis hier“; gespeicherte Filter mit Baum
- Feld-Extraktion (Prompt 011): Messwerte aus der Nachricht als Spalten (Text, Zahl, Prozent, Dauer, Größe mit
  Einheiten), Vorschläge beim Öffnen als Hinweis, Dialog „Felder“, „Spalte aus Auswahl“ mit Vorschau, Regeln je Format,
  Feld-Bedingungen vergleichen in Basiseinheit (`took > 500 ms`)
- Dashboard und SQL-Timeline (Prompt 012): SQLite je Tab (erst beim ersten Öffnen), eine Zeile je Eintrag mit Zeit,
  Level, Quelle und Zahlenfeldern; Panels mit SQL (Linie, Fläche, Säulen, gestapelt, Kreis, Tabelle, Einzelwert),
  Vorlagen, `bucket()`, Klick springt zur Zeile oder öffnet einen Filter-Tab (013), live alle 5 s, abgesicherte Abfragen
- Filter als eigener Tab (Prompt 013): Drill-down „app.log › ERROR › 4711“, mehrere Ansichten in einer Sitzung, Kind =
  Eltern UND eigener Filter, live; Einstieg über Toolbar, `Cmd/Ctrl+Shift+T`, Baum, Kontextmenü, Dashboard-Säule; Kette
  im Baum und im Tab-Titel; höchstens 8 Tabs je Datei
- Overview Ruler und Navigation (Prompt 007): Leiste rechts mit Fehlern, Warnungen, Lesezeichen, Auswahl und
  sichtbarem Bereich, Klick springt; `E`/`W` nächster Fehler bzw. Warnung, `M`/`N` Lesezeichen (nur im Speicher), `G`
  aus dem Filter ins Gesamtlog und zurück

## Offen

**Dateien:** Rotierte Archive als durchgehende Timeline, `.gz`/`.zip`/`.zst` lesen, Ordner/Glob
beobachten, Remote-Logs über SSH, `stdin`/Pipe-Modus.

**Merge (Nachfragen zu 006):** Zeitversatz je Datei für Hosts mit abweichender Uhr, Zeitzone je Datei (heute gilt ohne
Angabe die lokale Zone), Zeilennummer in der Quelldatei (bräuchte eine Spalte im Index), Merge speichern, exportieren und
in „Zuletzt geöffnet“, Archive und Ordner im Merge, Spalten je Quelle bei verschiedenen Formaten.

**Struktur:** Im Detail-Panel vorheriger/nächster Eintrag, Felder eines Eintrags als Tabelle, YAML/SQL formatieren;
Filtern aus dem Spaltenkopf (Wert der gewählten Zeile; die Zelle kann es schon), fixierte Spalten,
Layout je Quelle beim Merge (006), einklappbare Stacktraces, Zeilenumbruch als Folgezeilen fester Höhe (eine Logzeile belegt
mehrere Tabellenzeilen; braucht eine Zeilen-zu-Bildschirmzeilen-Liste im Backend, neu je Breite und Schrift).

**Felder (Nachfragen zu 011):** mehrere Treffer je Zeile als Liste, abgeleitete Spalten (Formeln), Felder aus Fortsetzungszeilen, Anlegen aus dem
Stacktrace, Regeln je Datei statt je Format.

**Seitenleiste:** Thread/Logger als Knoten und Statistik-Zeilen (011),
Zeitfilter (006/014), Tortendiagramme, Lesezeichen und Notizen.

**Overview Ruler (Nachfragen zu 007):** Treffer der Suche im Ruler (im Highlight-Modus nur mit Textscan, eigener
Hintergrund-Job), Anzahlen je Marke im Tooltip (heute Level und Zeilenbereich, die Zusammenfassung kennt nur Bits),
Ziehen im Ruler, Mini-Vorschau beim Hover, eigene Regex-Marker. Zähler je Abschnitt statt Bits, damit die Dichte auch
über 1 Mio. Zeilen nicht sättigt (heute Anteil der Abschnitte mit dem Level, siehe Nachtrag in
`prompts/done/007-overview-ruler.design.md`).

**Filter:** Query-DSL (`level:ERROR AND NOT "x"`) auf dem Ausdruck aus 010, Bedingungen des Baums als Highlight-Farben,
Zeitfenster per Ziehen im Zeitstrahl (014), Filter-Vorlagen teilen, eigene Regex-Marker, persistente Lesezeichen und
Notizen. Nachfragen zu 010: Zeit-Bedingung je Quelle beim Merge, Zeilenbedingungen über eine Truncation hinweg.

**Dashboard (Nachfragen zu 012):** Teilen und Export (auch PDF), Alarme aus Abfragen, nur die gefilterte Ansicht
auswerten (würde die Filterliste in die Datenbank kopieren), Nachricht als durchsuchbare Spalte (FTS), Abfragen über
mehrere Tabs (dafür gibt es Merge), Panels frei ziehen statt Größenstufen, Zoom/Zeitauswahl im Diagramm als Filter
(014), Tabellen-Panel auf der GuiExpert Table, gruppierte `GROUP BY`-Abfragen
schneller (vorberechnete Minuten, ~1 s je 5 Mio. Einträge heute).

**Filter-Tabs (Nachfragen zu 013):** Tabs verschieben und die Kette dabei behalten, Ketten speichern und wieder öffnen,
eigener Ruler-/Statistikvergleich Eltern gegen Kind, ein Dashboard je Ansicht statt je Datei (heute pausiert das
Schließen des Dashboards in einem Tab den Aufbau auch für die anderen Tabs der Datei), Merge-Ansichten ohne Textlesen
unter der Sperre (heute lesen weitere Ansichten eines Merges den Text beim Schreiben).

**Alarme:** Schwellenwert-, Muster- und Heartbeat-Trigger; Desktop-Benachrichtigung, E-Mail, Webhooks, Incident-Tools.

**Analyse:** Trace-ID-Isolation, Fehler-Histogramm, Gruppierung gleicher Meldungen, Diff zweier Dateien.

**Export:** CSV/JSON/TXT/PDF, Workspace speichern und teilen, Plugin-Schnittstelle.

**Plattform:** Signierung einrichten (Secrets, siehe `.github/workflows/release.yml`), UI-Sprachen.
