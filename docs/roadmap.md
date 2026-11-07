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

## Offen

**Dateien:** Rotierte Archive als durchgehende Timeline, `.gz`/`.zip`/`.zst` lesen, Merge-View nach Zeitstempel, Ordner/Glob
beobachten, Remote-Logs über SSH, `stdin`/Pipe-Modus.

**Struktur:** Im Detail-Panel vorheriger/nächster Eintrag, Felder eines Eintrags als Tabelle, YAML/SQL formatieren;
Filtern aus der Kopfzeile (010), fixierte Spalten, eigene Felder aus der Nachricht (011),
Layout je Quelle beim Merge (006), einklappbare Stacktraces, Zeilenumbruch als Folgezeilen fester Höhe (eine Logzeile belegt
mehrere Tabellenzeilen; braucht eine Zeilen-zu-Bildschirmzeilen-Liste im Backend, neu je Breite und Schrift).

**Seitenleiste:** verschachtelte Filter als Baum (010), Thread/Logger als Knoten und Statistik-Zeilen (011),
Zeitfilter (006/014), Tortendiagramme, Lesezeichen und Notizen.

**Filter:** Feld-Filter (Klasse, Thread, Mandant), Query-DSL (`level:ERROR AND NOT "x"`), Zeitfenster, eigene Regex-Marker,
persistente Lesezeichen und Notizen.

**Alarme:** Schwellenwert-, Muster- und Heartbeat-Trigger; Desktop-Benachrichtigung, E-Mail, Webhooks, Incident-Tools.

**Analyse:** Trace-ID-Isolation, Fehler-Histogramm, Gruppierung gleicher Meldungen, Diff zweier Dateien.

**Export:** CSV/JSON/TXT/PDF, Workspace speichern und teilen, Plugin-Schnittstelle.

**Plattform:** Signierung einrichten (Secrets, siehe `.github/workflows/release.yml`), UI-Sprachen.
