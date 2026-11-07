# 016 Spool und Syslog/UDP – Design und Stand

Status: umgesetzt (Phase 1–6), `npm run check` und `npm run e2e` grün (371 Schritte, auch nach den Review-Nachträgen), autonom entschieden (Freigabe durch den Koordinator: offene Fragen selbst entscheiden und
hier festhalten). Datum: 2026-11-07. Branch `feat/spool-syslog-udp`. Sicherheits-Review durch einen separaten Agenten
veranlasst der Koordinator.

## Abweichungen vom Prompt-Text (Stand des Codes)

- `switch_file` steht in `tail.rs` bei Zeile ~466 (nicht 335), `SessionManager::open` bei ~2370 (nicht 808),
  `syslog_pri` in `profile.rs` bei ~45.
- **„PRI-Erkennung greift ohne Änderung“ stimmt nicht:** `detect_syslog_pri` prüfte nur `^<`, mit dem Präfix
  (Empfangszeit, Absender) fand es keine Priorität, und der Kopf des Profils `syslog` (`^Mon dd hh:mm:ss`) machte jede Zeile
  ohne Level zur Fortsetzung. Lösung: `skip_received_prefix` in `level.rs` (greift für Profile mit `syslog_pri`) und ein
  eigenes eingebautes Profil `syslog-received` (siehe Entscheidungen). `timestamp.rs` greift ohne Änderung (ISO am Anfang).
- **Rotation + Gesamtgrenze allein begrenzen den Plattenplatz nicht:** die Sitzung hält rotierte Dateien offen (Segmente),
  eine gelöschte Spool-Datei behält ihren Platz, bis das Handle zu ist. Siehe Entscheidung „Handles“.
- Menüeintrag englisch wie die anderen („Open Source…“), Oberfläche sonst deutsch.

## Entscheidungen

| Frage | Optionen | Entscheidung | Grund |
|---|---|---|---|
| Source-Trait | `fn run(self, writer, stop)` wie im Prompt / mit Vorbereitung | `prepare(config) -> Box<dyn Source>` (bindet/verbindet, Fehler gehen synchron an den Dialog), dann `Source::run(self: Box<Self>, ctx: SourceContext { writer, stop, monitor })` auf eigenem Thread; dazu `kind`, `label`, `config` (ohne Geheimnisse), `profile` | „Port belegt“ muss im Dialog landen, nicht als späterer Status. 017–019 bekommen Verbindungsfehler genauso. |
| Status | Kanal / geteiltes Objekt | `SourceMonitor` (Zustand im Mutex, Zähler atomar), die Sitzung liest ihn beim Bauen jedes Updates (`SessionUpdate.sourceStatus`), die Quelle weckt die Sitzung bei Zustandswechsel sofort, bei Zählern höchstens alle 200 ms (`counted`/`flush`) | Kein zusätzlicher Thread, Zähler kosten nichts je Meldung außer einem Atomic. |
| Gegendruck | blockieren / verwerfen | `SpoolWriter::try_line`: begrenzte Warteschlange (64 K Zeilen und 32 MB), voll = verwerfen und zählen (`dropped`); `line_blocking` (wartet, bis Platz ist oder gestoppt) für ziehende Quellen (017, 019) | Empfang darf nie blockieren (der Kernel verwürfe sonst unsichtbar); ziehende Quellen können langsamer ziehen. |
| Spool-Dateien | | `<cache>/spool/<pid>/source-N/spool.log`, Rotation per Umbenennen in `spool-NNNNNN.log`, neue `spool.log`; Rotationsgröße = Gesamtgrenze/8, höchstens 256 MB (2 GB → 8 × 256 MB); Grenze 64 MB … 8 GB (32 × 256 MB), Settings `spoolLimitMb` | Rotation ist der Fall, den `switch_file` kann; 8 Dateien liegen weit unter `MAX_SEGMENTS`. |
| Handles | gelöschte Datei kürzen / Segmente im Index verwerfen / Neubeginn | Die Spool-Sitzung beginnt neu (wie bei Rotation ohne Behalten), sobald sie so viele Dateien hält wie der Spool behält (`OpenOptions::max_segments`). Spitze ≈ Grenze + eine Datei; im Freeze (Sitzung liest nicht, Spool schreibt weiter) höchstens das Doppelte | Kürzen ließe leere Zeilen stehen; Segmente vorn verwerfen bräuchte neue Zeilennummern, Filterlisten und Zusammenfassungen (wie ein Neu-Leveln mit Textlesen). Bei 2 GB und 50 000 Meldungen/s alle ~5 min, bei üblichen Raten Stunden bis Tage. Im Roadmap als offen. |
| Merge mit Spool | | Erlaubt (der Merge-Dialog bietet offene Tabs an, also auch Quellen); `MergeWorker::limit_segments` begrenzt die Segmente dieser Quelle über die Datei-Identität auf die des Spools, dann mischt der Merge neu | Sonst hielte der Merge bis zu 32 gelöschte Dateien (8 GB). Live-Syslog neben einem App-Log nach Zeit ist nützlich. |
| Spool-Zeile | | `2026-11-07T10:15:30.123+01:00 10.0.0.5 <34>…` (Empfangszeit lokal mit ms und Zone, Absender ohne Port, Meldung); `\n`/`\r` als `\\n`/`\\r`, andere Steuerzeichen (auch ESC, NUL, DEL) und ungültige Bytes als `\\xNN`, Tab bleibt; abschließende `\n`/`\r`/NUL entfernt; über 64 KB an einer Zeichengrenze gekürzt + ` …[gekürzt]` | ESC escapen verhindert eingeschleuste ANSI-Sequenzen; der Port des Absenders ist bei UDP Rauschen. Nach dem Review: `\\` wird verdoppelt (eindeutig), C1/Bidi/U+2028/2029 als `\\u{XXXX}`. |
| Profil | `syslog` erweitern / eigenes | Eigenes `syslog-received` („Syslog (empfangen)“): Kopf `^ISO `, Level aus PRI hinter dem Präfix, sonst Schlüsselwörter; Layouts 5424, 3164, roh mit `sender` (nur IP-förmig), `sent`, `pri`, `host`, `logger`, `pid`, `msgid`, `data`, `message`. Die Quelle legt es fest (`fixed_profile`), Erkennung für einen behaltenen Spool klappt auch beim normalen Öffnen (Muster-Matrix der Samples: 100 %, kein anderes Profil ≥ 80 %) | Das Profil `syslog` für Dateien bleibt unverändert; ein ISO-Kopf allgemein hätte fremde Logs als Syslog erkannt. |
| Adresse | | Standard `127.0.0.1:5514`. Nur IP-Adressen (keine Hostnamen, kein DNS). Nicht-Loopback nur mit `allowRemote` — im Dialog per Häkchen unter einer Warnung, im Backend erneut geprüft (`invalid_source`) | Doppelte Prüfung: auch ein Aufruf am Frontend vorbei bindet nicht still nach außen. |
| Absender-Filter | | Adressen und Netze (CIDR, v4/v6, IPv4-gemappt wird zu IPv4), höchstens 64; abgewiesene Meldungen bzw. TCP-Verbindungen werden gezählt (`rejected`), nichts geschrieben | |
| TCP | Thread je Verbindung / Event-Loop | Thread je Verbindung, höchstens 64 (darüber sofort geschlossen und gezählt), Lese-Timeout 200 ms für den Stopp; `TcpFramer`: Ziffern + Leerzeichen = Octet-Counting (höchstens 9 Ziffern), sonst bis `\n` (CR davor weg, NUL/leere Rahmen übersprungen); über 64 KB: der Rest wird übersprungen, der Strom bleibt im Takt | Ohne `mio`/`tokio` (keine neue Abhängigkeit); Speicher ≤ 64 × 128 KB. |
| Port belegt / Rechte | | `port_in_use` (neuer Code) mit Port in der Meldung; `permission_denied` mit Hinweis auf Ports < 1024; der Dialog sagt das bei Port < 1024 schon vorher | Prompt. |
| Schließen | | `SessionManager::close` stoppt die Quelle sofort (Port frei, Spool geflusht), gelöscht wird beim Drop der Sitzung (nach dem Worker). Beim Beenden der App `close_all` (RunEvent::Exit). Reste toter Prozesse löscht der Start (`SpoolRoot::prepare`, nur Spool-Dateien) | Port frei auch, wenn eine Abfrage oder ein Export die Sitzung noch hält. |
| Behalten | | „Spool behalten“ (Dialog und Statusleiste) schreibt sofort eine Marke `keep` (übersteht Absturz); beim Schließen wandert der Ordner nach `spool/kept/<Zeit>-<Label>/`, scheitert das (Windows, offen), bleibt er mit Marke stehen. „Speichern unter …“ = Export-Dialog aus 015 | Behaltenes soll auffindbar sein; nur Kopieren per Export ist der Weg an einen Ort nach Wahl. |
| Gespeicherte Quellen | | Settings `savedSources` (höchstens 20, ohne Duplikate, nur geprüfte Konfigurationen, Port 0 nie), im Dialog als Chips „Zuletzt“, auf dem Start-Bildschirm als Liste; ein Klick öffnet den Dialog vorbefüllt (nicht direkt starten) | Lauschen ist ein Seiteneffekt, die Konfiguration soll vor dem Start sichtbar sein. |
| Arbeitsstand (015) | | Neue Art `kind: 'source'` mit `source` (Konfiguration, ohne Geheimnisse), Tabs und Filter; keine Lesezeichen/Notizen (gelten nur für diesen Spool). Version bleibt 2: ältere Versionen verwerfen den Eintrag und zählen ihn. Beim Öffnen in der Bestätigungsliste („startet Syslog-Empfang auf …“); eine Quelle, die über diesen Rechner hinaus lauscht, wird aus einem Arbeitsstand **nie** gestartet (ausgegraut, im Bericht) | Ein fremder Arbeitsstand darf keinen Port nach außen öffnen. |
| Kürzel | | `Cmd/Ctrl+Shift+L` (auch Menü File → Open Source…) | Gegen README-Tabelle, `app.ts`, `log-table-view.ts`, `toolbar.ts` geprüft: frei. |
| Farben | | keine neuen Tokens (Warnung in `--lv-warn-fg`, wie die Statusleiste sie schon nutzt; Symbol `⇣` in `--accent`) | `npm run contrast` unverändert grün. |

## Sicherheit (Netz-Eingabe)

| Maßnahme | Test |
|---|---|
| Standard nur Loopback, Remote nur mit `allowRemote` (Frontend und Backend) | `only_loopback_without_the_explicit_choice`, `the_default_binds_loopback_only`, `remote_listening_needs_the_explicit_choice`, `source-logic.spec`, e2e (Warnung, Start erst nach Häkchen) |
| Keine Hostnamen / kein DNS | `listen_address` (`localhost` abgelehnt), `isIpAddress` |
| Nachricht ≤ 64 KB (UDP-Puffer 64 KB, TCP-Framer), gekürzt und markiert (Review ohne kritische/hohe Befunde; Nachträge unten) | `long_messages_are_cut_and_marked`, `tcp_frames_over_the_limit_are_cut_and_the_stream_stays_in_step`, Integration (70 KB über TCP) |
| Eine Meldung = eine Zeile, Steuerzeichen/ungültige Bytes escaped | `messages_become_one_line` (Tabelle), Integration, e2e (`multi line\nsecond line`) |
| Fuzz-artig: 2000 deterministische Zufallseingaben durch Formatierung, `classify` und Framer (beliebige Stückelung), keine Panik, Grenzen gehalten | `garbage_never_panics_and_stays_one_line` |
| Gegendruck: begrenzte Warteschlange, verwerfen und zählen | `a_full_queue_drops_and_counts`, `blocking_lines_wait_and_stop` |
| Spool begrenzt (Rotation, älteste Datei weg, Neubeginn der Sitzung) | `rotates_and_keeps_at_most_max_files`, `the_spool_rotates_and_stays_within_its_limit` (nie mehr als 3 Dateien / 12 KB), `a_merge_holds_no_more_spool_files_than_the_spool_keeps` |
| Absender-Filter, Verbindungsgrenze | `sender_filter`, `the_sender_filter_rejects_and_counts` |
| Port belegt, kein Rest | `a_port_in_use_is_an_error_with_the_port`, `a_port_in_use_is_reported_and_leaves_nothing_behind`, e2e (UDP+TCP auf belegtem Port: Fehler mit Port) |
| Stopp beim Schließen, Port frei, Spool gelöscht | `closing_stops_the_listener_and_deletes_the_spool`, e2e (Datei weg) |
| Keine Verstärkung: es wird nie gesendet (UDP keine Antwort, TCP kein `write`) | Code-Review (kein `send`/`write` auf Sockets in `syslog.rs`) |
| Fremde Konfiguration (Settings, Arbeitsstand) feldweise geprüft | `parseSourceConfig`-Tests, `workspace-model.spec` (Quellen) |
| **Nachtrag Review M1 (Slowloris):** TCP-Verbindung ohne Daten 120 s → geschlossen; angefangener Rahmen (Octet-Count oder Zeile) 30 s ohne Ende → geschlossen, das Gelesene als gekürzte Meldung; höchstens 8 Verbindungen je Absender-Adresse; bei 64 offenen wird die am längsten ruhende (mindestens 5 s ruhig) für die neue geschlossen, sonst die neue abgewiesen. Grenzen in `TcpLimits`, für Tests injizierbar (`with_tcp_limits`) | `idle_tcp_connections_and_unfinished_frames_are_closed`, `tcp_connections_are_capped_per_sender`, `at_the_limit_the_longest_idle_connection_makes_room` |
| **M2 (Escaping):** zusätzlich C1-Steuerzeichen U+0080–U+009F (CSI, OSC, NEL), Bidi-Marken und -Overrides (U+200E/F, U+202A–202E, U+2066–2069) und U+2028/2029 als `\u{XXXX}`; `\` wird `\\`, damit jedes Escape eindeutig ist. Format: `\\`, `\n`, `\r`, `\xNN` (C0 außer Tab, DEL, ungültige Bytes), `\u{XXXX}` (README, CLAUDE.md) | `messages_become_one_line` (je Klasse, Nachbarn wie U+200D, U+2013, U+20AC, U+206A bleiben) |
| **L1:** Verbindungs-Slot über einen Drop-Guard freigegeben (auch bei Panik); Thread-Körper von Quelle, Annahme und Verbindungen in `catch_unwind`, eine Panik setzt den Zustand „Fehler“ statt still zu enden | `a_panicking_connection_thread_frees_its_slot`, `a_panicking_source_shows_an_error` |
| **L2:** Nach einem Fehler setzt der nächste erfolgreiche Empfang bzw. Annahme den Zustand zurück auf „Lauscht“ (`SourceMonitor::recovered`, ohne Sperre je Meldung); scheitert der Start des TCP-Threads, zeigt die Quelle „Fehler: TCP not started“ | `counters_notify_at_most_every_interval` (recovered) |
| **L3:** Spool-Ordner 0700, Spool-Dateien 0600 unter Unix (`create_private_dir`/`create_private_file`, auch `spool/`, `spool/<pid>/`, `spool/kept/`) | `spool_folders_and_files_are_private` |
| **L4 (Gesamtgrenze), Entscheidung:** höchstens 8 Quellen zugleich (`MAX_SOURCES`, sonst `too_large`), damit ist der Plattenplatz aller laufenden Spools ≤ 8 × Grenze (Vorgabe 16 GB, eine globale Byte-Grenze über Quellen hinweg hätte eine Quelle die andere verdrängen lassen); behaltene Spools zählen nicht automatisch, sondern stehen mit Anzahl und Größe in den Einstellungen mit „Löschen“ (`kept_spools`, `delete_kept_spools`, löscht nur Ordner mit reinen Spool-Dateien) | `at_most_eight_sources_at_a_time`, `root_removes_what_dead_processes_left_but_not_kept_spools` (Zählen, Löschen) |
| **L5:** Der Dialog sagt beim Absender-Filter, dass er bei UDP keine Authentifizierung ist (Absender fälschbar) | Sichtprüfung, Screenshot |
| Bundle: Initial wieder unter 1 MB (969 KB) durch `@defer` für Einstellungen, Pfad-, Merge- und Felder-Dialog (der Quellen-Dialog war schon lazy) | `npm run build` ohne Budget-Warnung |
| Logdaten nie per `innerHTML` | unverändert (Tabelle zeichnet Text) |
| Firewall: Loopback fragt nichts; macOS fragt beim ersten Lauschen auf anderer Adresse (unsignierter Build nach jedem Neubau erneut), Windows Defender ebenso | README „Receiving syslog safely“; nur von Hand prüfbar |

## Messwerte (Release, Apple Silicon)

`cargo test --release --test syslog_integration -- --ignored --nocapture measure_` (UDP über 127.0.0.1, Meldungen ~110 Byte):

| | |
|---|---|
| 50 000 Meldungen/s für 4 s | 200 000 von 200 000 angezeigt, 0 verworfen, alles 0,11 s nach dem letzten Senden im Index |
| 100 000 Meldungen/s für 3 s | 300 000 von 300 000, 0 verworfen |
| ein Sender ohne Pause | 120 000/s angeboten, 200 000 von 200 000, 0 verworfen |
| Verzögerung Empfang → Index (Einzelmeldung) | Median 105 ms, max. 114 ms (Flush ≤ 100 ms + Tail) |

`measure_500mb` (`tail_integration`) nach der Änderung: erste Zeilen 31 ms, indiziert 2,30 s, Level-Filter 30 ms, Suche
0,76 s, Baum 1/5/20 Text-Blätter 0,79/0,83/0,95 s, `get_lines` 5000 mit Layout 7,1 ms — im Rahmen der bisherigen Werte
(2,2–2,38 s, 0,7–0,77 s; unter Last gemessen). Einlesen und Filter sind nicht berührt (nur `max_segments` in
`switch_file`, Präfix-Prüfung nur für Profile mit `syslog_pri`).

## Fortschritt

- [x] Rust: `spool.rs`, `sources/mod.rs`, `sources/syslog.rs`, Profil `syslog-received`, `skip_received_prefix`, `OpenOptions` (`source`, `max_segments`, `fixed_profile`, `segment_limits`), `SessionManager::open_source`/`close_all`, Merge-Grenze, Commands `open_source`, `set_spool_keep`, `set_spool_limit`, Fehlercodes `invalid_source`, `port_in_use`, Menü
- [x] Rust-Tests: Unit (Spool, Monitor, Syslog-Tabellen, Framer, Fuzz, Filter, Bind), `tests/syslog_integration.rs` (10 000 UDP-Meldungen mit Level und Spalten, Umbrüche/kaputte Bytes/TCP 70 KB, Stopp und Löschen, Behalten, Port belegt, Remote, Absender-Filter, Rotation/Grenze, Freeze, Merge, Merge-Grenze), Samples-Matrix
- [x] Frontend: Dialog „Quelle öffnen“, Tab-Symbol und Label, Statusleiste (Zustand, Zähler, Spool-Pfad im Titel, Behalten, Speichern unter), Start-Bildschirm, Tab-Leiste, Menü/Kürzel, Settings (gespeicherte Quellen, Spool-Grenze), Arbeitsstand
- [x] Vitest: `source-logic.spec.ts`, Settings, Arbeitsstand
- [x] e2e: Dialog-Vorgaben, Warnung + Häkchen, Port 514-Hinweis, Quelle auf Zufallsport, 301 Meldungen mit Leveln, Mehrzeiler, Port belegt, Tab schließen löscht den Spool
- [x] Doku (README inkl. Sicherheit/Firewall, CLAUDE.md, architecture, roadmap), Screenshots `source-dialog.png`, `syslog.png`
- [ ] Sichttest mit `logger -n 127.0.0.1 -P 5514 …` in der echten App: nicht von Hand gemacht (Marc soll keine Fenster sehen); der e2e sendet echte UDP-Datagramme an die echte App
