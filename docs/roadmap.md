# Roadmap

Stand der Anforderungen aus dem Fachkonzept. Die sechs Phasen des Startauftrags sind umgesetzt; der Rest ist Backlog, die
Architektur verbaut nichts davon.

## Umgesetzt

- Live Tail, Autoscroll-Steuerung, Freeze je Tab, Rotation und Truncation, Chunk-basiertes Nachladen
- Format-Erkennung (JSON, Log4j/Logback, nginx/Apache, Syslog), Multi-Line-Blöcke beim Filtern
- Level-Chips, Volltextsuche mit Regex, Groß-/Kleinschreibung, Match-Highlighting, Farbcodierung nach Level

## Offen

**Dateien:** Rotierte Archive als durchgehende Timeline, `.gz`/`.zip`/`.zst` lesen, Merge-View nach Zeitstempel, Ordner/Glob
beobachten, Remote-Logs über SSH, `stdin`/Pipe-Modus.

**Struktur:** Feld-Extraktion und Spaltenansicht (dafür passt die GuiExpert Table, sobald die Zeilenzahl der Ansicht klein
genug ist oder die Tabelle Scroll-Skalierung bekommt), W3C- und Common-Log-Format, einklappbare Stacktraces.

**Filter:** Feld-Filter (Klasse, Thread, Mandant), Query-DSL (`level:ERROR AND NOT "x"`), Zeitfenster, eigene Regex-Marker,
persistente Lesezeichen und Notizen.

**Alarme:** Schwellenwert-, Muster- und Heartbeat-Trigger; Desktop-Benachrichtigung, E-Mail, Webhooks, Incident-Tools.

**Analyse:** Trace-ID-Isolation, Fehler-Histogramm, Gruppierung gleicher Meldungen, Diff zweier Dateien.

**Export:** CSV/JSON/TXT/PDF, Workspace speichern und teilen, Plugin-Schnittstelle.

**Plattform:** Signierung einrichten (Secrets, siehe `.github/workflows/release.yml`), UI-Sprachen.
