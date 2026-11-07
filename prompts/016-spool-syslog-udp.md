# Prompt 016: Quellen ohne Datei (Spool) und Syslog/UDP-Empfang

> Start in neuer Sitzung: „Führe `prompts/016-spool-syslog-udp.md` aus.“
> Legt die Grundlage für 017 (SFTP), 018 (Windows-Ereignisse) und 019 (Datenbanken). Deshalb zuerst.
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

Die App empfängt Syslog- und UDP-Meldungen auf einem Port, speichert sie und zeigt sie live wie eine Datei, mit allem, was es für Dateien gibt.

## Entscheidung: Spool-Datei statt neuem Lesepfad

Jede Quelle ohne Datei schreibt in eine **Spool-Datei** im Cache-Ordner der App, und die Sitzung tailt diese Datei wie jede andere.

- Index, Tail, Rotation, Filter, Suche, Freeze, Export und Merge (006) funktionieren ohne neuen Code. `LineReader` liest über `read_at` aus Dateien,
  das bleibt so.
- Ein eigener Lesepfad je Quelle würde jede Funktion von `tail.rs` und `session.rs` doppelt verlangen.
- Kosten sind Plattenplatz und ein Schritt Verzögerung im Millisekundenbereich. Beides ist für Logs akzeptabel und wird begrenzt.

## Backend

1. **`spool.rs`**, frei von Tauri: `SpoolWriter` schreibt Zeilen (UTF-8, `\n`) gepuffert und mit `flush` mindestens alle 100 ms. Rotation ab 256 MB
   (umbenennen, neu anlegen): Das ist genau der Fall, den `switch_file` (`tail.rs:335`) schon kann. Gesamtgrenze in den Settings, Standard 2 GB, älteste
   Spool-Datei wird gelöscht. Bei `MAX_SEGMENTS` (32) beginnt die Sitzung neu, deshalb Rotationsgröße so wählen, dass die Gesamtgrenze vorher greift.
2. **`sources/mod.rs`:** `trait Source { fn run(self, writer: SpoolWriter, stop: StopToken) }`, ein Thread je Quelle, Status über einen Kanal, der in
   `SessionUpdate.source_status` landet (`connecting | listening | connected | error { message } | stopped`). Sitzung schließen beendet die Quelle und löscht den Spool,
   außer „Behalten“ ist gewählt.
3. **`open_source(kind, config, on_update) -> SessionInfo`:** Spool anlegen, Quelle starten, dann `SessionManager::open` auf dem Spool-Pfad (`session.rs:808`).
   `SessionInfo` bekommt `source: { kind, label }`, damit der Tab nicht den Spool-Pfad zeigt.
4. **Syslog/UDP-Quelle** `sources/syslog.rs`:
   - UDP (RFC 3164 und 5424), TCP mit Octet-Counting und mit `\n`-Trennung (RFC 6587). TLS (RFC 5425) nicht in V1.
   - Jede Meldung wird **eine** Zeile. Zeilenumbrüche in der Meldung als `\n`-Escape, sonst zerfällt sie in Fortsetzungszeilen.
   - Vorangestellt die Empfangszeit (ISO 8601) und die Absenderadresse, danach die Meldung roh. So greifen Syslog-Profil, `timestamp.rs` und PRI-Erkennung
     (`syslog_pri` in `profile.rs:32`) ohne Änderung. Das neue Layout aus 008 für dieses Präfix ergänzen.
   - Unbekannte Bytes ungültiges UTF-8 als `\xNN`, Meldungen über 64 KB gekürzt und markiert.
   - Zähler: empfangen, verworfen, gekürzt.

## Sicherheit und Betrieb

- **Standard: nur `127.0.0.1`**, Port 5514. Lauschen auf allen Schnittstellen nur mit ausdrücklicher Wahl im Dialog und Warnhinweis. Port 514 braucht Root-Rechte,
  der Dialog sagt das, statt zu scheitern.
- **Absender-Filter** (Liste von Adressen oder Netzen) optional. Ohne Filter nimmt der Port alles an, was das Netz erreicht.
- **Last:** Ein Netz kann mehr senden, als die Platte schreibt. Begrenzter Kanal zwischen Empfang und Spool, beim Überlauf verwerfen und zählen, nie Speicher
  unbegrenzt füllen. Ziel 50.000 Meldungen/s ohne Verlust auf einem normalen Rechner messen.
- Firewall-Abfrage von macOS und Windows beim ersten Lauschen: im README erwähnen.
- Port belegt: Fehler im Dialog mit dem Port, kein Absturz.

## Frontend

1. Menü und Start-Bildschirm „Quelle öffnen …“ mit Arten (hier: Syslog/UDP, später 017 bis 019). Dialog: Protokoll, Adresse, Port, Absender-Filter, Behalten.
   Gespeicherte Quellen in den Settings, ohne Geheimnisse.
2. Tab mit Symbol der Quelle und `label` („Syslog :5514“). Statusleiste: Zustand und Zähler, Pfad des Spools im Titel. Freeze hält die Anzeige an, der
   Empfang läuft weiter in den Spool.
3. „Spool behalten“ und „Speichern unter …“ (mit 015: Export).

## Tests

- **Rust:** `SpoolWriter` (Flush, Rotation, Gesamtgrenze), Syslog-Parser als Tabelle (3164, 5424, Octet-Counting, Umbrüche, kaputte Bytes, zu lang), Überlauf zählt.
  Integration: Quelle startet, `UdpSocket` sendet 10.000 Meldungen, Sitzung zeigt alle, Rotation des Spools, Stopp beim Schließen, belegter Port.
- **e2e:** Syslog-Quelle auf zufälligem Port, Meldungen senden, Zeilen und Level sind da, Tab schließen löscht den Spool.
- **Messung:** Meldungen/s ohne Verlust, Verzögerung bis zur Anzeige.

## Nicht in diesem Prompt

TLS-Syslog, Weiterleiten an andere Server, Empfang von GELF oder Fluentd, Dauerbetrieb im Hintergrund ohne offenes Fenster.

## Fertig, wenn

- [ ] Tests oben grün, `npm run check` und `npm run e2e` grün
- [ ] Standard lauscht nur lokal, belegt durch Test
- [ ] `README.md` (Sicherheit, Firewall), `CLAUDE.md` (Entscheidung Spool, Layout `sources/`), `docs/roadmap.md` ergänzt
- [ ] Sichttest mit `logger -n 127.0.0.1 -P 5514 …` oder ähnlich, sonst im Bericht als offen genannt

Kein Commit ohne Rückfrage.
