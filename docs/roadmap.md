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
- Zeitstrahl / Fehler-Histogramm (Prompt 014): Streifen über dem Log mit den Einträgen der ganzen Datei über die Zeit,
  gestapelt nach Level, Ausfälle schraffiert, Band des sichtbaren Bereichs; Klick springt zur Zeit, Ziehen markiert
  ein Zeitfenster „Als Filter“ (Zeit-Bedingung im Filterbaum des Tabs) oder zum Hineinzoomen, Mausrad zoomt, `Z`;
  Perzentil-Achse gegen Ausreißer

- Export, Arbeitsstand und Teilen (Prompt 015): Export der Auswahl, Ansicht oder Datei als TXT, CSV (RFC 4180, Schutz vor
  Formeln) oder JSON Lines mit Spalten, als Hintergrund-Job mit Fortschritt und Abbruch; Notizen (`Shift+M`) in Gutter,
  Ruler und Detail-Panel; Arbeitsstand `.lcw` mit Dateien, Merges, Filter-Tabs samt Baum, Lesezeichen und Notizen als Anker,
  Layout; fehlende Dateien suchen oder überspringen; Teilen als Markdown oder Jira

- Quellen ohne Datei und Syslog-Empfang (Prompt 016): Spool im Cache-Ordner, den die Sitzung wie eine Datei verfolgt
  (alle Funktionen inklusive Freeze, Export, Merge, Dashboard); Syslog über UDP (RFC 3164/5424) und TCP (RFC 6587),
  nur lokal ohne ausdrückliche Wahl, Absender-Filter, Zähler (empfangen, verworfen, gekürzt, abgewiesen), Spool
  behalten oder löschen, gespeicherte Quellen, Quellen im Arbeitsstand; Grundlage für 017–019
- Remote über SSH (Prompt 017): Logdatei auf einem Server per SFTP-Polling in den Spool (`russh`, reines Rust),
  Rotation/Truncation erkannt (offener Handle gegen Pfad), Erstabruf „letzte 50 MB“ oder ganz, Wiederverbinden bis 60 s,
  eine Verbindung je Server, Ordner-Browser, Hosts aus `~/.ssh/config`; Host-Schlüssel gegen `known_hosts` mit
  Bestätigung des Fingerabdrucks, geänderter Schlüssel = Abbruch; Agent, Schlüssel mit Passphrase, Passwort,
  Geheimnisse nur auf Wunsch im Schlüsselbund; im Arbeitsstand ohne Geheimnis und ohne Auto-Verbinden
- Windows-Ereignisprotokolle (Prompt 018, nur Windows): Kanal lokal oder remote (`EvtOpenSession`, angemeldete
  Identität oder Passwort aus Dialog/Schlüsselbund) als JSON Lines in den Spool, Bestand des Zeitraums, dann Abonnement
  ab Bookmark, Wiederverbinden ohne Lücke/Doppel, Level-Tabelle inkl. Audit, Provider-Metadaten-Cache, Spalten-Vorgabe,
  „Gleiche Event-ID“; auf macOS/Linux unsichtbar. **Ungeprüft auf echtem Windows** (siehe
  `prompts/done/018-windows-ereignisse.design.md`)
- Logs aus Datenbanken (Prompt 019): PostgreSQL, MySQL/MariaDB (`sqlx`), SQL Server (`tiberius`), SQLite
  (`rusqlite`, schreibgeschützt) als JSON Lines in den Spool; ein geprüftes `SELECT`, von der App als Unterabfrage mit
  Schlüssel, Ordnung und Stapel (10 000) umhüllt; Polling `key >= letzter` mit gemerkten Zeilen am Rand (gleiche Zeiten
  ohne Verlust/Doppel); lesend auf allen Datenbanken (Read-only-Sitzung/-Transaktion, SQL Server immer Rollback);
  Zeitlimit 30 s; TLS mit Prüfung als Vorgabe; „Tabelle wählen“, Vorschau 20 Zeilen, Tab `db:schema.tabelle`, letzte
  Abfrage und Dauer in der Statusleiste; Wiederverbinden 1–60 s ab letztem Schlüssel; Passwort wie 017; im Arbeitsstand
  ohne Passwort/CA-Datei und ohne Auto-Verbinden
- Farbschemata (Prompt 020, Phase 1): 17 Schemata (dark, light, One Dark, One Dark Vivid, True Dark/Black/Light, Matrix,
  Amber, Solarized Light, Mystico – C64, Crimson, fünf Rainglow), Picker mit Vorschaubildern, Filter und Live-Vorschau
  (`Cmd/Ctrl+Alt+T`, Toolbar, Ansicht-Menü, Einstellungen), „System folgen“ mit wählbarem Paar, Fensterrahmen passend,
  Start ohne Blitz, Kontrastprüfung aller Schemata (`npm run contrast`, Vitest)
- Aktionen, Keymaps und Kürzel-Editor (Prompt 021): 50 Aktionen mit stabilen Ids, Default-Keymap je OS, ein Dispatcher
  (Geltungsbereich global/Ansicht/Suchfeld), Editor mit Suche, Aufnehmen, Konflikt- und Reserviert-Hinweis, Zurücksetzen
  (`Cmd/Ctrl+Shift+K`, `?` als Übersicht, Hilfe-Menü, Einstellungen); eigene Belegung im Settings-Store; Menü-Kürzel folgen
  der Keymap; Tooltips zeigen die aktuelle Belegung; README-Tabelle aus den Keymaps erzeugt und geprüft
- KI-Steuerung über MCP (Prompt 022): Sidecar `log-commander-mcp` für Claude Code, Claude Desktop, Cursor; 31 Tools in
  drei Stufen (lesen, Ansicht steuern, vorschlagen mit Bestätigung im Fenster), `help` mit Konzepten, Filterbaum, SQL,
  Rezepten, Grenzen und Fehlercodes, MCP-Prompts; aus per Default, Tabs vor der KI verbergen, bekannte Geheimnisse
  maskiert, Verlauf und „KI trennen“ in der Statusleiste, Einrichtungszeilen und Verbindungstest in den Einstellungen

## Offen

**KI-Steuerung (Nachfragen zu 022):** `propose_dashboard_panel` (Dashboard mit vorbelegtem Panel), Arbeitsstand
speichern als Vorschlag (braucht einen Weg am nativen Dialog vorbei, der den Pfad sichtbar bestätigt), eigene
Maskier-Muster, MCP-Resources mit `resources/updated` statt `wait_for_lines`, Einrichtung von Claude Desktop/Cursor per
Knopf mit Diff wie AppIconic 086, Handtest mit Claude Desktop und unter Windows/Linux, Signierung des Sidecars mit den
Apple-Secrets prüfen.

**Nach Prompt 021:** Befehlspalette (der Katalog bringt Namen, Gruppen und Kürzel schon mit), Import/Export einer Keymap
(zu 015; streng prüfen, wie `mergeKeymap` + `resolveKeymap`), Kürzel für Profile und gespeicherte Filter, Keymap-Vorlagen
(„VS Code“, „less“), Akkorde im Editor aufnehmen (der Dispatcher kann sie schon).

**Farbschemata, Phase 2 von Prompt 020:** eigene Schemata bearbeiten (Editor mit Gruppen aus `tokens.ts`, Live-Vorschau,
Kontrast-Hinweise je Paar, Speichern nur der Abweichungen über `diffTokens`), im Store unter `themes` (höchstens 50
Schemata, 300 Tokens), Import über einen eigenen Command `import_theme` (256 KiB, Bereinigung mit `sanitizeTokens`,
ausgewählt nur ohne Kontrastprobleme) und Export `export_theme` (`dialog:allow-save` ist schon da). Die reinen
Funktionen dafür (`tokenValueOk`, `sanitizeTokens`, `diffTokens`, `checkContrast`) gibt es schon. Dazu ein
„Solarized Dark“ als Partner für Solarized Light.

**Dateien:** Rotierte Archive als durchgehende Timeline, `.gz`/`.zip`/`.zst` lesen, Ordner/Glob
beobachten, `stdin`/Pipe-Modus.

**Remote (Nachfragen zu 017):** Bastion-Hosts (`ProxyJump`), Host-Zertifikate (`@cert-authority`), Kerberos/GSSAPI,
Ordner mit Glob auf dem Server beobachten, FTP/FTPS als eigene Quelle, SCP-Erstabruf (heute über SFTP), mehrere
Schlüsseldateien nacheinander probieren, Sichttest gegen echte Server (Linux-Distributionen, Windows-OpenSSH) und
Windows-Build samt Pageant/OpenSSH-Agent von Hand prüfen.

**Windows-Ereignisse (Nachfragen zu 018):** Handtest und Windows-CI (Lesen von Application, `eventcreate` live,
Bookmark nach Neustart, Security ohne Rechte, Remote mit Passwort), e2e auf Windows, `.evtx` direkt öffnen (eigener
Parser), SIDs in Namen auflösen (`LookupAccountSid`), Bookmark über einen App-Neustart (behaltener Spool), Kanal-Abfrage
mit eigener XPath, mehrere Kanäle als eine Abfrage (`QueryList`).

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
Tortendiagramme, Lesezeichen und Notizen als Liste.

**Overview Ruler (Nachfragen zu 007):** Treffer der Suche im Ruler (im Highlight-Modus nur mit Textscan, eigener
Hintergrund-Job), Anzahlen je Marke im Tooltip (heute Level und Zeilenbereich, die Zusammenfassung kennt nur Bits),
Ziehen im Ruler, Mini-Vorschau beim Hover, eigene Regex-Marker. Zähler je Abschnitt statt Bits, damit die Dichte auch
über 1 Mio. Zeilen nicht sättigt (heute Anteil der Abschnitte mit dem Level, siehe Nachtrag in
`prompts/done/007-overview-ruler.design.md`).

**Filter:** Query-DSL (`level:ERROR AND NOT "x"`) auf dem Ausdruck aus 010, Bedingungen des Baums als Highlight-Farben,
Filter-Vorlagen teilen, eigene Regex-Marker. Nachfragen zu 010: Zeit-Bedingung je Quelle beim Merge, Zeilenbedingungen über eine Truncation hinweg.

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

**Zeitstrahl (Nachfragen zu 014):** „nur Ansicht“ (die Zusammenfassung der Filterliste trägt keine Zeiten),
Zeitzone/Versatz je Datei beim Merge, Ausfälle innerhalb eines Abschnitts genauer als auf eine Probe (heute jeder
32. Kopf), Lücken im Ruler (007) zeigen, Zeitbereich des Zeitstrahls mit dem Dashboard teilen.

**Analyse:** Trace-ID-Isolation, Gruppierung gleicher Meldungen, Diff zweier Dateien.

**Export und Arbeitsstand (Nachfragen zu 015):** PDF, Export als Excel-Datei, Notizen mit Markdown, Arbeitsstand
automatisch beim Beenden, Filter geschlossener Eltern-Tabs im Arbeitsstand (das Frontend kennt nur ihre Beschriftung),
Zoom des Zeitstrahls im Arbeitsstand, Spalten-Layout nur für den Arbeitsstand
statt in den Settings, Plugin-Schnittstelle.

**Quellen (Nachfragen zu 016):** Syslog über TLS (RFC 5425), GELF, Fluentd/Forward, Weiterleiten an andere Server,
Empfang im Hintergrund ohne offenes Fenster, Rate-Grenze je Absender, Ansicht beim Überlauf des Spools ohne
Neubeginn (bräuchte ein Verwerfen der ältesten Segmente im Index), behaltene Spools im Start-Bildschirm.

**Datenbanken (Nachfragen zu 019):** Oracle (Instant Client), ODBC/OLEDB, `LISTEN`/Change-Streams statt Polling,
Windows-Anmeldung an SQL Server (Kerberos/NTLM), Client-Zertifikate, Abfragen über mehrere Datenbanken, Textschlüssel mit
Groß-/Kleinschreibung-unabhängiger Sortierung genau (heute können Zeilen, die sich nur darin unterscheiden, am Rand doppelt
kommen), Sichttest gegen echte Server und Windows-/Linux-Build von Hand.

**Plattform:** Signierung einrichten (Secrets, siehe `.github/workflows/release.yml`), UI-Sprachen.
