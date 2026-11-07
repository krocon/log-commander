# Prompt 017: Entfernte Logs über SSH/SFTP

> Start in neuer Sitzung: „Führe `prompts/017-remote-sftp.md` aus.“
> Voraussetzung: 016 (Spool und `Source`). Spike mit Halt in Phase 1.
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

Eine Logdatei auf einem Linux-Server öffnet sich über SSH/SFTP und läuft live mit, ohne Herunterladen von Hand. Rotation und Truncation auf dem Server
werden erkannt wie lokal.

## Entscheidungen

| Thema | Entscheidung | Warum |
|---|---|---|
| Weg | SFTP-Polling in den Spool aus 016 | Alle Funktionen bleiben, wie bei Syslog. `tail -F` über eine Shell bräuchte Shell-Zugang und ist bei Rotation unzuverlässig. |
| Protokolle | SSH/SFTP und SCP-artiger Erstabruf. FTP und FTPS **nicht** in V1 | FTP überträgt Zugangsdaten unverschlüsselt. FTPS ist selten und hat kein sinnvolles Live-Lesen. Später als eigene Quelle möglich. |
| Bibliothek | Spike zwischen `russh` + `russh-sftp` (reines Rust) und `ssh2` (libssh2, C) | Reines Rust baut auf allen drei Plattformen ohne OpenSSL. `ssh2` ist reifer. Größe, Agent-Unterstützung und Build auf Windows entscheiden. |
| Geheimnisse | SSH-Agent und Schlüsseldateien zuerst, Passwort nur im Schlüsselbund des Systems (`keyring`) | Keine Passwörter in Settings, Arbeitsstand oder Logs. |

## Phase 1: Spike, dann anhalten 🛑

Beide Bibliotheken gegen einen lokalen OpenSSH-Server (Docker, im Bericht beschrieben): Verbindung mit Agent, Schlüssel mit Passphrase, Passwort, `known_hosts`;
`stat` und `read` ab Offset, Durchsatz, Binärgröße, Build auf macOS, Linux und Windows (CI-Lauf oder Begründung). Ergebnis als
`prompts/017-remote-sftp.design.md`, **dann anhalten und entscheiden lassen.**

## Phase 2: Umsetzung (nach Freigabe)

1. **`sources/sftp.rs`:** Schleife wie `follow_file` (`tail.rs:159`), aber über SFTP: `stat` alle 500 ms (einstellbar), neue Bytes ab Offset lesen und in den
   Spool schreiben. Truncation (`size < offset`) und Rotation (anderer Inode aus `stat`, sofern der Server ihn liefert, sonst Größe und Änderungszeit) werden
   im Spool **nachgebildet**: Truncation durch eine neue Spool-Datei, damit der lokale Tailer sie als Rotation sieht. So bleibt `tail.rs` unverändert.
2. **Erstabruf:** große Datei nur ab einer wählbaren Stelle („letzte 50 MB“ als Standard, „ganze Datei“ wählbar). Fortschritt über `source_status`.
3. **Host-Schlüssel:** Prüfung gegen `~/.ssh/known_hosts` und eine eigene Liste. Unbekannter Schlüssel: Dialog mit Fingerabdruck und ausdrücklicher Bestätigung.
   **Geänderter Schlüssel: Verbindung abbrechen, kein „trotzdem“.** Das ist kein Komfortpunkt.
4. **Anmeldung:** Agent (`SSH_AUTH_SOCK`, unter Windows Pageant und OpenSSH-Agent), Schlüsseldatei mit Passphrase (Abfrage, auf Wunsch im Schlüsselbund),
   Passwort (Abfrage, auf Wunsch im Schlüsselbund), Benutzer und Port aus `~/.ssh/config` übernehmen, wenn möglich. Keine Zugangsdaten in Fehlermeldungen.
5. **Verbindungsabbruch:** Neu verbinden mit wachsendem Abstand bis 60 s, Status in der Statusleiste, bisherige Zeilen bleiben. Nach Wiederverbindung ab dem
   gemerkten Offset weiter, bei kleinerer Datei wie Truncation.
6. **Mehrere Dateien desselben Servers** teilen sich eine Verbindung. Ordner durchsuchen im Dialog über `readdir`.

## Frontend

1. Dialog „Remote-Datei“: Host (auch Einträge aus `~/.ssh/config`), Benutzer, Port, Anmeldung, Pfad mit Datei-Browser, Startpunkt. Gespeicherte Verbindungen ohne Geheimnisse.
2. Tab: `host:/var/log/app.log`, Symbol Remote. Statusleiste: Verbindung, Latenz, Bytes.
3. Mit 006: Remote- und lokale Dateien mergen, das funktioniert über den Spool ohne Sonderfall.

## Tests

- **Rust, rein:** Parser für `~/.ssh/config` (Teilmenge), Erkennen von Truncation und Rotation aus `stat`-Folgen.
- **Integration** gegen OpenSSH in Docker (als `--ignored`, mit Anleitung): Live, Rotation, Truncation, Abbruch und Wiederverbindung, geänderter Host-Schlüssel wird abgelehnt.
- **e2e:** nur mit laufendem Server, sonst im Bericht als offen.

## Nicht in diesem Prompt

FTP, FTPS, SCP als eigene Quelle, Sprung über Bastion-Hosts (`ProxyJump`), Ordner mit Glob beobachten (Roadmap), Kerberos.

## Fertig, wenn

- [ ] Design freigegeben, Tests oben grün, `npm run check` grün
- [ ] Kein Geheimnis in Settings, Arbeitsstand, Logs oder Fehlermeldungen, per Suche im Code belegt
- [ ] `README.md` (Anmeldung, Host-Schlüssel), `CLAUDE.md`, `docs/roadmap.md` (Remote über SSH) ergänzt
- [ ] Sichttest gegen einen echten Server, sonst im Bericht als offen genannt

Kein Commit ohne Rückfrage.
