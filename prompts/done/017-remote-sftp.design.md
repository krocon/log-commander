# 017 Entfernte Logs über SSH/SFTP – Spike, Design und Stand

Status: Spike erledigt, Bibliothek entschieden (`russh` + `russh-sftp`), Phase 2–6 umgesetzt. Autonom entschieden (Freigabe
durch den Koordinator: Spike selbst entscheiden, nur anhalten, wenn keine Bibliothek tragfähig ist). Datum: 2026-11-07.
Branch `feat/remote-sftp`. Sicherheits-Review durch einen separaten Agenten veranlasst der Koordinator.

## Spike (Phase 1)

### Aufbau

- Server: `alpine:3.20` mit OpenSSH 9.7 (`openssh-server`, `internal-sftp`) in Docker Desktop 29.8, Port
  `127.0.0.1:2222`, Benutzer `test` mit Passwort, Host-Schlüssel ed25519 (fest, aus dem Spike-Ordner). Testdateien
  `/var/log/app/app.log` (UTF-8 mit Umlauten und Emoji) und `big.log` (202 MB Base64-Zeilen). Dockerfile und Schlüssel lagen
  nur im Scratch-Ordner; alle Schlüssel waren Wegwerf-Schlüssel (`ssh-keygen` im Temp-Ordner): ed25519 mit Passphrase, RSA
  3072 ohne, ed25519 für einen **eigenen** `ssh-agent` (Socket im Temp-Ordner). Der Agent des Nutzers wurde nur lesend
  angefragt (`ssh-add -l`: Exit 2, auf diesem Rechner unter `SSH_AUTH_SOCK` kein Agent erreichbar).
- Zwei Spike-Programme mit gleichem Ablauf: `known_hosts` (leer, falscher Schlüssel, richtiger), Passwort (richtig/falsch),
  Schlüssel mit Passphrase (richtig/falsch/fehlt), RSA-Schlüssel, Agent, `stat`, `read` ab Offset, `fstat`, `readdir`,
  50 × `stat` (Latenz), 202 MB lesen (Durchsatz), letzte 50 MB ab Offset. Release-Profil wie die App (`lto = "thin"`,
  `codegen-units = 4`, `strip`).
- Die Integrationstests der Umsetzung laufen zusätzlich gegen denselben Container (`#[ignore]`, Anleitung unten).

### Messwerte (Apple Silicon, macOS, Loopback)

| | `russh` 0.64.1 + `russh-sftp` 3.0.1 | `ssh2` 0.9.5 (libssh2 1.11, `vendored-openssl`) |
|---|---|---|
| known_hosts: unbekannt / geändert / bekannt | `Ok(false)` / `Err(KeyChanged { line: 1 })` / `Ok(true)`, eigener Handler entscheidet vor der Anmeldung | `NotFound` / `Mismatch` / `Match` (nach dem Handshake, vor der Anmeldung) |
| Fingerabdruck SHA256 | `key.fingerprint(Sha256)` → `SHA256:heN9…` | nur Roh-Hash (32 Byte), Base64 selbst |
| Passwort | ok, 21 ms inkl. Verbindung; falsch = `success() == false` | ok, 20 ms; falsch = Fehler -18 |
| Schlüssel mit Passphrase | ok; ohne Passphrase `KeyIsEncrypted`, falsche `cryptographic error` (unterscheidbar) | ok; falsche Passphrase = „Unsupported private key format“ (nicht unterscheidbar) |
| RSA 3072 | ok, `rsa-sha2-512` ausgehandelt | ok |
| Agent (eigener `ssh-agent`) | ok (`AgentClient::connect_env`) | ok (`userauth_agent`) |
| `stat` / `fstat` / `readdir` / `read` ab Offset | ok / ok / ok / ok (Umlaute, Emoji) | ok / ok / ok / ok |
| `stat`-Latenz (Mittel aus 50) | 0,45 ms | 0,44 ms |
| Durchsatz 202 MB | **204 MB/s** (0,99 s, Read-ahead in `russh-sftp`) | 187 MB/s (1,08 s) |
| letzte 50 MB ab Offset | 0,24 s | – |
| Inode in `stat` | nein (SFTP v3 hat keinen), dafür uid/gid/mtime (s) | nein |
| Binär (Spike, gestrippt) | 3,79 MB (Grundlinie mit tokio 0,58 MB → +3,2 MB) | 3,84 MB (OpenSSL statisch, libz dynamisch) |
| Build macOS | 20 s (sauber) | 36 s (baut OpenSSL aus den Quellen, braucht Perl) |
| Build Linux | **geprüft** in Docker `rust:1-bookworm` (rustc 1.99.1): 3,94 MB | **geprüft**: 4,68 MB (OpenSSL vendored) |
| Build Windows | nicht geprüft (kein CI hier). Begründet: reines Rust + `ring` (MSVC-tauglich, vorgenerierter Assembler); dasselbe Gespann (`russh` 0.64, `russh-sftp` 3, `keyring-core` + `windows-native-keyring-store`) baut im CI von files-and-folders-tauri auf `windows-latest` (Lauf vom 2026-11-06 grün, der vom 2026-11-07 kompiliert und scheitert an einem fremden Test) | nicht geprüft. libssh2 nutzt dort WinCNG statt OpenSSL; WinCNG kann kein ed25519 (häufigster Schlüsseltyp), sonst OpenSSL für Windows mitbauen (Perl, NASM) |
| Agent unter Windows | `connect_named_pipe(\\.\pipe\openssh-ssh-agent)` und `connect_pageant()` vorhanden (nicht geprüft) | Pageant ja, OpenSSH-Agent-Pipe erst in neueren libssh2 (nicht geprüft) |
| Modell | async (tokio, in Tauri schon im Baum), Abbruch per `select!`/Timeout | blockierend, Timeout nur je Session |
| Shell/Exec | nur, wenn man einen Kanal dafür öffnet (wir öffnen nur das Subsystem `sftp`) | ebenso |

In der echten App (Release, gleiches Profil, macOS arm64) wächst die Binärdatei von 13,70 MB auf 17,00 MB (+3,30 MB).

### Entscheidung Bibliothek

**`russh` + `russh-sftp`.** Beide sind tragfähig (Host-Schlüssel sauber prüfbar, alle Anmeldearten, Linux-Build geprüft).
Den Ausschlag geben: kein C und kein OpenSSL (Windows ohne Perl/NASM, ed25519 auch unter Windows), unterscheidbare Fehler
bei der Passphrase (der Dialog kann „falsche Passphrase“ sagen), SHA256-Fingerabdruck fertig, Read-ahead (schneller beim
Erstabruf), Abbruch und Zeitgrenzen über tokio (beim Schließen eines Tabs wartet nichts auf einen hängenden Server), Agent
inkl. Windows-Pipe und Pageant, und dasselbe Gespann läuft schon in files-and-folders-tauri (gleicher Autor, Windows-CI).
`ssh2` wäre reifer im Protokoll, kostet aber OpenSSL-Builds und hat auf Windows die ed25519-Lücke.

## Entscheidungen (Phase 2–5)

| Frage | Entscheidung | Grund |
|---|---|---|
| Schlüsselbund | `keyring-core` 1 + je OS der Store (`apple-native-keyring-store`, `windows-native-keyring-store`, `dbus-secret-service-keyring-store` mit `crypto-rust`) statt `keyring` 3 | `keyring` 4 ist in genau diese Teile zerlegt; dieselben Versionen laufen in files-and-folders-tauri. Ohne Schlüsselbund (Linux ohne Secret Service): Geheimnis nur für die Sitzung |
| Konto im Schlüsselbund | Dienst `io.github.krocon.logcommander`, Konto `sftp:password:<16 Hex>` bzw. `sftp:passphrase:<16 Hex>` (SHA-256 über `user@host:port` bzw. den Pfad der Schlüsseldatei) | Host und Benutzer stehen nicht im Klartext in den Metadaten des Schlüsselbunds (die sind ohne Entsperren lesbar) |
| Wann gespeichert | nur mit Häkchen „Im Schlüsselbund merken“ und erst nach erfolgreicher Anmeldung; „Vergessen“ im Dialog löscht | ausdrückliches Opt-in; ein falsches Passwort landet nie im Schlüsselbund |
| Geheimnis im Speicher | `Secret` (Zeroizing, `Debug` = `***`, kein `Serialize`), solange die Verbindung lebt, für Wiederverbindungen | sonst müsste jede Wiederverbindung nachfragen; mit dem Schließen der letzten Datei des Servers gelöscht |
| Host-Schlüssel | `~/.ssh/known_hosts` (nur gelesen) und eigene Datei `<App-Konfig>/known_hosts` (0600); unbekannt → Fehler `host_key_unknown` mit Typ und SHA256, der Dialog zeigt ihn, „Vertrauen und verbinden“ sendet den Fingerabdruck mit, das Backend vergleicht ihn mit dem **gerade gesehenen** und trägt ihn erst dann ein. Geändert (auch: anderer Typ als der eingetragene) → `host_key_changed` mit Datei und Zeile, **kein Weg vorbei** | Prompt; Bestätigung bindet an genau diesen Schlüssel (kein TOCTOU). Logik und Tests aus files-and-folders-tauri (Review 034) übernommen |
| `~/.ssh/config` | eigene Teilmenge: `Host` (Muster `*`, `?`, `!`), `HostName`, `User`, `Port`, `IdentityFile` (`~`, `%d`, `%u`, `%h`, `%r`, `%%`), `Include` (relativ zu `~/.ssh`, `*` im Dateinamen, Tiefe 5). `Match` wird samt Block übersprungen (nie ausgewertet, also nie `exec`), `ProxyCommand`, `ProxyJump`, `LocalCommand`, `KnownHostsCommand` werden **nie** ausgeführt; ist für den Host `ProxyJump`/`ProxyCommand` gesetzt, sagt der Dialog „nicht unterstützt“ | Kein Befehl aus einer Konfigurationsdatei läuft je. Erster Wert gewinnt wie bei OpenSSH |
| Nur SFTP | Es wird nur das Subsystem `sftp` angefordert, nie `exec`/`shell`/PTY/Forwarding; kein Agent-Forwarding | Prompt (kein Shell-Zugang nötig) |
| Erkennung Rotation | Der Handle bleibt offen; je Runde `fstat(handle)` und `stat(path)`. Unterscheiden sie sich, wird `fstat` wiederholt: gleich → nur geschrieben, ungleich zweimal hintereinander → anderer Inode = Rotation. Dann wird die alte Datei über den Handle **zu Ende gelesen**, der Spool rotiert, die neue Datei ab 0. Pfad weg → weiter über den Handle (wie `tail -F`), taucht er wieder auf = Rotation | SFTP v3 liefert keinen Inode. Der offene Handle ist genauer als Größe+mtime (mtime nur in Sekunden) und verliert bei Rotation keine Zeilen |
| Truncation | gleiche Datei, Größe < Offset → Rest der Teilzeile schreiben, Spool rotieren, ab 0 | Prompt („im Spool nachgebildet“); die Spool-Sitzung behält alte Zeilen (`keep_on_rotate`) |
| Spool-Zeile (Abweichung von 016) | Bytes über `LineSplitter` (LF/CRLF, UTF-16, Kodierung aus den ersten 64 KB der Datei), dekodiert, ANSI-Farbsequenzen entfernt (wie die lokale Anzeige), dann mit dem Escaping aus 016 (C0, DEL, C1, Bidi, U+2028/9) über `escape_controls_into`, das aber `\` und SOH stehen lässt; über 1 MiB gekürzt und markiert | Fremddaten wie bei Syslog, aber Kodierungen und farbige Logs sollen lesbar bleiben; Zeitstempel und Level stehen am Zeilenanfang wie in der Datei, das Profil wird wie bei einer lokalen Datei erkannt |
| Teilzeile | bleibt im Puffer; nach 2 s ohne Wachstum der Datei als Zeile geschrieben (eine spätere Fortsetzung wird dann eine eigene Zeile), bei Rotation, Truncation und Stopp sofort | Der Spool kann keine Zeile ersetzen; ohne das bliebe die letzte Zeile einer Datei ohne `\n` unsichtbar |
| Erstabruf | Vorgabe „letzte 50 MB“ (dann ab der nächsten Zeilengrenze), wählbar „ganze Datei“ oder 1–10 000 MB; Fortschritt als `pendingBytes` in `sourceStatus` | Prompt |
| Polling | Vorgabe 500 ms, 200–60 000 ms im Dialog; je Runde höchstens 8 MB lesen, damit Stopp und Status nicht warten | Prompt |
| Gegendruck | `SpoolWriter::line_blocking` (ziehende Quelle) | aus 016 vorgesehen |
| Wiederverbinden | 1, 2, 4 … bis 60 s, Zustand `reconnecting` mit Sekunden bis zum nächsten Versuch; danach ab dem gemerkten Offset, kleinere Datei = Truncation. Host-Schlüssel wird bei jeder Verbindung neu geprüft (geändert → Fehler, kein weiterer Versuch) | Prompt |
| Verbindung teilen | `Pool` je `user@host:port`: Dateien eines Servers teilen eine SSH-Verbindung und eine SFTP-Sitzung; der Ordner-Browser nutzt sie ebenso. Ohne Nutzer wird sie nach 60 s geschlossen | Prompt |
| Laufzeit | eigener tokio-Runtime mit 2 Threads (`remote::runtime`), jeder Aufruf mit Zeitgrenze 20 s; die Quelle selbst ist ein Thread wie bei 016 | Tauri-Runtime bleibt frei, Stopp wartet höchstens eine Runde |
| Settings und Arbeitsstand | `SftpConfig` = Host, Port, Benutzer, Pfad, Anmeldeart, Schlüsseldatei (nur Settings), Startpunkt, Intervall — nie ein Geheimnis. Ein Arbeitsstand speichert keine Schlüsseldatei; beim Öffnen steht die Remote-Datei **ungehakt** in der Bestätigungsliste („verbindet mit … erst nach Häkchen“). Angehakt wird ohne Geheimnis verbunden (Agent, Schlüsselbund); braucht es eine Bestätigung des Host-Schlüssels oder ein Passwort, öffnet sich der Dialog vorbefüllt mit dieser Frage | 015/016: fremde Arbeitsstände sind nicht vertrauenswürdig; ohne Häkchen keine Verbindung (auch nicht die IP-Adresse oder Agent-Schlüssel an einen fremden Server) |
| Reihenfolge Host-Schlüssel/Passwort | Fehlt das Passwort, wird erst verbunden und der Host-Schlüssel geprüft, dann aufgelegt und nach dem Passwort gefragt | Niemand tippt ein Passwort für einen unbekannten oder geänderten Server |
| Abgelehnte Anmeldung beim Wiederverbinden | kein neuer Versuch, Zustand „Fehler“, Zeilen bleiben | Wiederholte Fehlversuche sperren Konten (fail2ban) |
| Kürzel | `Cmd/Ctrl+Shift+H` (Menü File → Open Remote File…, Tab-Leiste „Remote …“, Start-Bildschirm, „Quelle öffnen“ → Art) | gegen README, `app.ts`, `log-table-view.ts`, `toolbar.ts` geprüft; `Cmd+Shift+R` wäre im WebView „Neu laden“ |
| Farben | keine neuen Tokens (Warnrahmen `--lv-warn-fg`, Fehler `--danger`), `npm run contrast` grün | |
| Fehlercodes | neu: `host_key_unknown`, `host_key_changed`, `auth_failed`, `secret_required`, `connection_failed`, `unsupported`; Details (Typ, Fingerabdruck, Datei, Zeile, welche Art Geheimnis) im Feld `remote` des `AppError` | stabile deutsche Texte im Dialog |
| Keine Geheimnisse in Meldungen | Fehlertexte werden im Backend gebaut (Host, Port, Benutzer, Pfad, Code), nie aus Eingaben mit Geheimnissen; Tests suchen das Test-Passwort in Spool, Settings-JSON, Fehlern und Status | Prompt |
| e2e ohne Docker | In Debug-Builds gibt es einen SFTP-Testserver im Prozess (`remote::testserver`, `russh::server`, nur `cfg(debug_assertions)`), der e2e startet ihn über `e2e_sftp_server` | Der normale e2e braucht keinen Container; Release enthält weder Server noch Command |

## Messwerte der Umsetzung

- Binär (Release): 13,70 → 17,00 MB. Initiales Frontend-Bundle 977,75 KB (unter 1 MB), Dialog als Lazy-Chunk 19 KB.
- Einlesen, Filter, Suche nicht berührt (`tail.rs`, `indexer.rs` unverändert; im Spool nur die Nachricht `Rotate`),
  daher kein `measure_` nötig.
- Erstabruf: 3 MB / 1 MB-Start im Integrationstest < 1 s gegen den Server im Prozess; Spike: 202 MB in 0,99 s.

## Sicherheit und Tests

| Maßnahme | Test |
|---|---|
| Unbekannter Host-Schlüssel nur mit genau diesem Fingerabdruck, Eintrag in eigene Datei (0600), Nutzer-Datei nur gelesen | `an_unknown_host_key_needs_the_confirmed_fingerprint`, `trust::known_unknown_changed`, e2e |
| Geänderter Schlüssel / anderer Typ: Abbruch, auch mit Fingerabdruck, keine Anmeldung | `a_changed_host_key_is_refused_even_with_a_fingerprint` (0 Logins), `another_key_type_than_recorded_is_a_change`, Docker-Test, e2e (kein Knopf) |
| Host-Schlüssel vor dem Passwort | `an_unknown_host_key_needs…` (ohne Passwort → `host_key_unknown`), e2e |
| Geheimnis nur auf Häkchen und nach erfolgreicher Anmeldung im Schlüsselbund, falsches nie | `passwords_are_asked_for_and_kept_only_on_request`, `a_key_with_a_passphrase` |
| Kein Geheimnis in Spool, Settings-Ordner, known_hosts, Fehlern, Status, Descriptor | `no_secret_in_spool_settings_errors_or_known_hosts`, `secrets_never_show`, Vitest (Arbeitsstand mit `secret`-Feld) |
| Nur SFTP-Subsystem | Testserver zählt exec/shell/pty/env: 0 (`live_lines_rotation_truncation_and_no_shell`) |
| `~/.ssh/config`: nichts ausgeführt | `match_blocks_and_proxies_are_never_run` |
| Remote-Text escaped | `remote_lines_are_escaped_but_keep_their_text`, Integration (OSC-Sequenz) |
| Wiederverbinden begrenzt, abgelehnte Anmeldung nicht wiederholt | `a_dropped_connection_comes_back…`, `a_refused_login_while_away_is_not_retried_and_says_so` |
| Arbeitsstand verbindet nie selbst, keine Schlüsseldatei | Vitest `remote-logic.spec` (Parser), Bestätigungsliste ungehakt (Code) |
| Eingaben (Host, Benutzer, Pfad, Intervall) geprüft, auch im Backend | `configs_are_checked`, Vitest |
| **Review M1:** eigener known_hosts-Parser (`trust.rs`) statt dem von russh: beliebiger Leerraum, Kommentare/Leerzeilen, Hostnamen klein, Listen, Muster `*`/`?`/`!`, `[host]:port`, gehashte Hosts (`\|1\|salt\|hash`, HMAC-SHA1), Markierungen. `@revoked` mit dem gezeigten Schlüssel → harte Ablehnung (`host_key_changed`, `reason: revoked`), auch wenn er zugleich vertraut ist; eine Zeile für den Host mit unlesbarem Schlüssel, `@cert-authority`, unbekannte Markierung oder eine unlesbare Datei gelten als „eingetragen“ → Ablehnung mit Grund statt „unbekannt“; eine kaputte Zeile verdeckt die übrigen nicht. Gleicher Parser für die eigene Datei; `resolve` schreibt Hostnamen klein | `trust::tests` (Tabs/Mehrfach-Leerzeichen/Kommentare, Groß-/Kleinschreibung und Listen, Muster/Negation, gehasht, `[h]:p`, `@revoked`, `@cert-authority`/kaputte Zeile/unbekannte Markierung, unlesbare Datei, anderer Typ), `resolved_host_names_are_lower_case`, Integration `a_revoked_key_is_refused_even_with_its_fingerprint_and_known`, `user_known_hosts_with_tabs_patterns_and_odd_lines`, Docker-Test erneut grün |
| **L1:** Kanäle, die der Server öffnet (Agent, X11, forwarded/direct TCP und Streamlocal, Session), werden abgelehnt | `the_server_cannot_open_channels_towards_the_app` (0 angenommen, Quelle läuft weiter) |
| **L2:** Agent: zuerst die Schlüssel der `IdentityFile`s (`.pub`), höchstens 6 Versuche | `agent_keys_of_the_identity_files_go_first_and_are_capped`, `agent_login` (ignoriert) |
| **L3:** Ordnerliste: eine Frist von 20 s für alles, eigener SFTP-Kanal, Einträge beim Lesen gedeckelt (je `readdir`-Paket), höchstens 200 Symlinks aufgelöst (Rest ohne Art/Größe) | `listings_are_capped_and_resolve_a_bounded_number_of_links` |
| **INFO:** russh kopiert das Passwort für `authenticate_password` in einen eigenen `String`, der nicht überschrieben wird; unsere Kopie (`Secret`) wird es. Nicht zu ändern ohne Eingriff in russh | dokumentiert (README, hier) |

## Integrationstest gegen OpenSSH (Docker)

```bash
src-tauri/tests/sshd/start.sh   # baut das Image, Wegwerf-Schlüssel in src-tauri/target/sshd-test, nur 127.0.0.1:2222
cd src-tauri && LC_SSHD_TEST=127.0.0.1:2222 cargo test --test sftp_integration -- --ignored --nocapture openssh
src-tauri/tests/sshd/stop.sh    # Container, Image und Schlüssel weg
```

## Fortschritt

- [x] Spike beider Bibliotheken, Messwerte, Entscheidung
- [x] Rust: `remote/` (Hub, Pool, trust, secrets, ssh_config, watch, testserver), `sources/sftp.rs`, Spool-`Rotate`,
  Fehlercodes, Commands `remote_hosts`, `remote_list_dir`, `forget_remote_secret`, `open_source` mit `credentials`, Menü
- [x] Tests: Unit (watch, ssh_config, trust, secrets, sftp), `tests/sftp_integration.rs` (10 gegen Server im Prozess),
  ignoriert: OpenSSH in Docker (grün: live, Rotation, Truncation, Wiederverbinden, geänderter Schlüssel) und Agent mit
  Wegwerf-`ssh-agent` (grün)
- [x] Frontend: Dialog „Remote-Datei“ (lazy), Tab-Symbol ⇅, Statusleiste, Start-Bildschirm, Settings, Arbeitsstand
- [x] e2e: SFTP-Server im Prozess, Host-Schlüssel, falsches/richtiges Passwort, Ordner-Browser, live, Rotation,
  geänderter Schlüssel (388 Schritte)
- [x] Doku, Screenshots `remote.png`, `remote-dialog.png`
- [ ] Nicht geprüft: Build unter Linux (nur Spike) und Windows, Pageant/Windows-Agent, echter Schlüsselbund
  (`LC_KEYCHAIN_TEST=1 cargo test --lib -- --ignored real_keychain`), Sichttest gegen einen echten Server
