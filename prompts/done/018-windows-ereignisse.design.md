# 018 Windows-Ereignisprotokolle – Design und Stand

Status: umgesetzt (Phase 1–6) **auf macOS, ohne echtes Windows**. Autonom entschieden (Freigabe durch den Koordinator:
offene Fragen selbst entscheiden und hier festhalten). Datum: 2026-11-08. Branch `feat/windows-ereignisse`.
Sicherheits-Review durch einen separaten Agenten veranlasst der Koordinator (Schwerpunkte unten).

## Das Plattform-Problem und wie es gelöst ist

Windows lässt sich hier nicht ausführen. Darum:

- **Nur `sources/winevent/api.rs` spricht mit Windows** (`#[cfg(windows)]`). Alles andere ist plattformfrei und auf macOS
  getestet: Konfiguration und Prüfung (`mod.rs`), Level-Tabelle, JSON-Zeile und Escapes (`line.rs`), Event-XML lesen
  (`event.rs`), Bookmark-/Wiederverbinde-Ablauf (`follow.rs`), Provider-Metadaten-Cache (`cache.rs`), Fehlerzuordnung
  inkl. „Zugriff verweigert“ → deutscher Hinweis (`mod.rs::app_error`, `backend.rs::kind`), Passwort/Schlüsselbund.
- `follow.rs` arbeitet gegen den Trait `EventLog`/`EventStream` (`backend.rs`); `fake.rs` (nur Tests) bildet die Regeln der
  echten API nach (Abfrage-Schnappschuss, Abo nach Bookmark, verschwundenes Bookmark, Fehler, hängender Aufruf).
  Die Fluss-Tests laufen über `SessionManager` → Spool → Sitzung (Zeilen, Level, Spalten).
- **Kompilieren für Windows:** `npm run rust:check-windows` (`scripts/check-windows.sh`) = `cargo clippy --all-targets
  -- -D warnings` für `x86_64-pc-windows-msvc` **und** `x86_64-pc-windows-gnu` über die **ganze Crate** (inkl. Tests und
  der `cfg(windows)`-Zweige in `mod.rs`, `commands.rs`, `secrets.rs`, `platform.rs`). Der direkte Versuch scheiterte an
  `ring` (C, `assert.h` fehlt), danach `libsqlite3-sys` und `tauri-winres` (`llvm-rc`). Das Skript setzt für den Check
  Platzhalter ein (C-Compiler, Archiver, `llvm-rc`, `windres` schreiben leere Dateien). **Geprüft wird nur der Rust-Code**
  (Typen, Borrow-Checker, Signaturen gegen `windows-sys` 0.61.2, clippy); C-Code, Linken, Ressourcen und Laufzeit nicht.
  Zusätzlich lief vorher ein kleiner Check-Crate nur mit `backend.rs`, `cache.rs`, `event.rs`, `api.rs` (fand einen
  Borrow-Fehler in `api.rs`, behoben).

## Entscheidungen (statt Anhalten)

| Frage | Optionen | Entscheidung | Grund |
|---|---|---|---|
| Crate | `windows` (Prompt) / `windows-sys` | `windows-sys` 0.61 (schon direkte Abhängigkeit), Features `Win32_System_EventLog`, `Win32_System_Threading`, `Win32_Security` dazu | Gleiche Evt*-API, keine neue Crate, kleiner; `windows` 0.62 wäre nur über Tauri im Baum |
| Mehrfachwahl | eine Abfrage mit `QueryList` / je Kanal eine Quelle | je Kanal eine Quelle und ein Tab (höchstens 8 = `MAX_SOURCES`), Häkchen „zusätzlich zusammenführen“ öffnet einen Merge (006) der Spools nach Zeit | `QueryList` liefert je Kanal nacheinander, nicht nach Zeit; ein Bookmark je Kanal hält Wiederverbinden einfach; Merge und Tabs gibt es schon |
| Profil | `jsonl` / eigenes | eigenes `winevent` (JSON, deutsche Spaltennamen in `fields.rs`), fest von der Quelle gewählt; **nie geraten** (`suggest_profile`, `detect_format` überspringen es), in der Profilliste nur unter Windows (`offered_here`) | Spalten-Vorgabe (Zeit, Level, Provider, Event-ID, Meldung, Rest ausgeblendet) hängt am Profil; ein JSON-Log anderer Herkunft darf sie nicht bekommen; auf macOS keine sichtbare Änderung |
| Level | | Tabelle in `line.rs::app_level`: Audit-Fehler → error, Audit-Erfolg → info (Keyword vor Level), 1 → fatal, 2 → error, 3 → warn, 0/4 → info, 5 Ausführlich → debug, 6–255 → trace | Audit-Ereignisse haben Level 0; ein fehlgeschlagener Zugriff ist das, was man in „Security“ sucht. Debug ist der übliche Filter für „detailliert“ |
| Zeit | UTC wie im XML / lokal | lokal mit ms und Zone (`2026-11-08T10:15:30.123+01:00`) | wie die Ereignisanzeige und der Syslog-Spool; Merge/Zeitstrahl lesen die Zone |
| Benutzer | `LookupAccountSid` / SID | SID, bekannte (SYSTEM, LOCAL/NETWORK SERVICE, …) als Name | Auflösen fragt je neue SID die Domäne; Folgeprompt |
| Ohne Meldungsdatei | | `(keine Meldung) a; b; c` aus den Insertion-Strings bzw. `(keine Meldung) Ereignis N von P` | Prompt; Präfix macht klar, dass das nicht die Meldung ist |
| XML | | Feld `xml`, Vorgabe an (Prompt), abschaltbar im Dialog; Meldung ≤ 32 000, XML ≤ 64 000 Zeichen, dann gekürzt + markiert (`truncated`) | Größe |
| Bestand → live | | Abfrage des Zeitraums (`timediff`), Bookmark je Stapel; Abo `StartAfterBookmark|Strict`; leerer Zeitraum: Bookmark des neuesten Ereignisses (`EvtQueryReverseDirection`), leerer Kanal: `StartAtOldestRecord` | Kein Fenster zwischen Abfrage und Abo, in dem etwas verloren geht |
| Abbruch/Neustart | | Fehler → `Reconnecting` 1, 2, 4 … 60 s, neue Sitzung (`reconnect`), weiter ab dem Bookmark (der Bestand wird nicht neu gelesen); Record-IDs ≤ der letzten werden übersprungen; Bookmark nicht gefunden (`ERROR_NOT_FOUND`) → ab dem ältesten, Zähler `gaps` (Statusleiste „1 Lücke“); `EVT_QUERY_RESULT_STALE` → sofort neu abonnieren | Prompt „keine Lücke, keine Doppel“; ein geleertes Protokoll ist eine echte Lücke und wird gesagt |
| Dauerhafte Fehler | | Zugriff verweigert, Kanal fehlt, Anmeldung abgelehnt, ungültige Abfrage: Zustand „Fehler“ mit Text, kein neuer Versuch | Keine gesperrten Konten, keine Endlosschleife |
| Rechte | | `permission_denied` mit deutschem Text: „„Security“ braucht Administratorrechte oder die Gruppe „Ereignisprotokollleser“ (Event Log Readers); die App fordert keine Rechteerhöhung an.“ Schon in `prepare` (die Bestandsabfrage läuft dort), also im Dialog | Prompt |
| Remote | | Rechner (Name, IPv4/6, `\\srv` erlaubt), Anmeldung „angemeldete Windows-Identität“ (Negotiate, Standard) oder „Benutzer und Passwort“ (`DOMÄNE\name`, `name@domäne`). Dieser Rechner immer mit der eigenen Identität | Prompt |
| Passwort | | nur aus dem Dialog für diesen Aufruf oder aus dem Schlüsselbund von 017 (Konto `winevent:password:<16 Hex aus user@rechner>`), gespeichert nur mit Häkchen und erst nach erfolgreichem ersten Aufruf; „Gespeichertes Passwort vergessen“; im Speicher als `Secret` (Zeroizing) bzw. in `api.rs` als UTF-16-Puffer, der beim Drop überschrieben wird (für Wiederverbindungen) | wie 017 |
| Arbeitsstand | | Quelle `kind: 'source'` mit `winevent`-Konfiguration (ohne Passwort), in der Bestätigung **immer ungehakt** („liest … erst nach Häkchen“), auf macOS/Linux ausgegraut („nur unter Windows“); fehlt ein Passwort, öffnet sich der Dialog vorbefüllt | „a workspace never auto-connects“ |
| Unsichtbar auf macOS/Linux | | Command `winevent_supported` (= `cfg!(windows)`), beim Start einmal gefragt; Art im Dialog „Quelle öffnen“, gespeicherte Quellen auf dem Start-Bildschirm und das Profil nur dann; `open_source`/`winevent_channels` → `unsupported` „… nur unter Windows“ | Prompt |
| Schnellfilter | | Kontextmenü „Gleiche Event-ID (4625)“ auf jeder Zeile eines `winevent`-Tabs (Feld-Bedingung `eventId = …`); Provider/Event-ID sonst über „Filtern nach …“ der Spalten (010) | Prompt |
| Fortschritt | | neuer Zustand `loading` („Lädt Bestand …“), dann `listening`; Zähler „N Ereignisse · gekürzt · Lücken“ | eine Gesamtzahl wäre nur über `EvtGetLogInfo` grob schätzbar |
| Abbruch beim Schließen | | Wächter-Thread ruft bei Stopp `EvtCancel` der Remote-Sitzung; lokale Aufrufe sind kurz (Abo wartet ≤ 200 ms) | ein hängender RPC darf das Schließen nicht blockieren |
| Screenshot | | Mock in `scripts/e2e/mock-ipc.js` (`setup({ windows: true })`, klar als MOCK kommentiert), Bilder `winevent-dialog.png`, `winevent.png`, in README als „mock, taken on macOS“ beschriftet | Windows-Ansicht ist hier nicht echt erzeugbar |
| Kürzel | | keins (über „Quelle öffnen“ `Cmd/Ctrl+Shift+L` → Art) | nur auf einem System sichtbar |
| Farben | | keine neuen Tokens | `npm run contrast` unverändert |

## Sicherheit (Schwerpunkte für das Review)

| Maßnahme | Test |
|---|---|
| Kein Passwort in Konfiguration, Settings, Arbeitsstand, Fehlern, Status; falsches nie im Schlüsselbund, richtiges nur mit Häkchen nach Erfolg | `passwords_are_asked_for_and_kept_only_on_request`, `configs_are_checked` (kein Feld), Vitest (Arbeitsstand mit `password`) |
| Konten im Schlüsselbund ohne Rechner/Benutzer im Klartext, eigener Bereich `winevent:` | `users_domains_and_keychain_accounts` |
| Ereignisinhalt ist Fremddaten: eine Zeile je Ereignis, C0/DEL/C1/Bidi/U+2028/9 escaped, Größen begrenzt | `escapes_keep_one_line_and_hide_nothing`, `long_messages_and_xml_are_cut_and_marked` |
| XML-Leser: begrenzt (256 Werte, 8 000 Zeichen je Wert, Tiefe 32), keine Panik | `values_and_counts_are_bounded`, `garbage_never_panics` (3000 Zufallseingaben) |
| Kein Auto-Verbinden aus einem Arbeitsstand, Remote nur mit Häkchen | Code (`askConfirm`, `checked: false`) |
| Eingaben (Rechner, Benutzer, Kanal, Zeitraum) im Frontend und Backend geprüft | `configs_are_checked`, Vitest |
| Keine Rechteerhöhung, verständlicher Fehler | `a_missing_right_shows_in_the_dialog`, `a_lost_right_stops_with_the_hint`, `errors_say_what_to_do` |
| `unsafe` in `api.rs`: Puffergrößen aus der API, Handles über Drop genau einmal geschlossen, Passwortpuffer volatil überschrieben | nur Review und Windows-Check (kompiliert) |

### Nachträge nach dem unabhängigen Review (keine kritischen/hohen Befunde)

| Befund | Behebung | Test |
|---|---|---|
| M1 `EvtCancel` konnte nach `reconnect` eine schon geschlossene Sitzung treffen | Sitzung und offene Ergebnismengen liegen in einem `Mutex<Active>`; `canceller` bricht nur unter der Sperre ab, `reconnect` schließt die alte Sitzung und `Stream::drop` seinen Handle nur unter derselben Sperre | Windows-Check (kompiliert); Ablauf über `closing_cancels_a_hanging_call` (Fake) |
| M2 `EvtNext` einer Abfrage mit `INFINITE` | `EvtNext` wartet je Aufruf höchstens 1000 ms, bei `ERROR_TIMEOUT` wird das Stopp-Flag geprüft (dann `ERROR_CANCELLED`); `canceller` bricht zusätzlich jede offene Ergebnismenge ab (auch lokal) | Windows-Check; Handtest 6 |
| M3 unbekannte Anmeldefehler endlos wiederholt | 1326, 1327, 1330, 1331, 1385, 1793, 1825, 1907, 1909 = Anmeldung abgelehnt (kein neuer Versuch, Dialog fragt neu); mit Passwort höchstens 3 Versuche bei nicht eingeordneten Fehlern, dann „Fehler“. Zugriff verweigert auf einem **anderen** Rechner: eigener Text (Anmeldedaten falsch oder Konto dort nicht in „Ereignisprotokollleser“/Administrator), nicht der lokale Security-Hinweis | `errors_are_told_apart`, `errors_say_what_to_do`, `with_a_password_unknown_errors_are_not_retried_forever` |
| M4 XML-Leser quadratisch (`chars().count()` je Zeichen) | einmal zählen, dann `take(room)` | `a_large_event_is_read_quickly` (~64 KB in < 200 ms, Debug) |
| L5 Reihenfolge beim Schließen | `Drop for WinLog`: erst der Metadaten-Cache (Provider-Handles), dann die Sitzung | Windows-Check |
| L6 `wide()` konnte beim Wachsen Kopien des Passworts hinterlassen | Puffer einmal in Endgröße angelegt (`with_capacity` + `extend`), `WipedWide` überschreibt ihn beim Drop | `queries_and_strings` (Kapazität = Länge) |
| L7 Ereignis, das `EvtRender` nie darstellen kann, hätte eine Wiederverbinde-Schleife ausgelöst | drei Versuche, dann Platzhalter (`RawEvent.render_error`) → Zeile „(Ereignis nicht lesbar, Fehler N)“ (WARN), gezählt als `rejected` („nicht lesbar“ in der Statusleiste); das Bookmark steht schon dahinter. Die Record-ID ist ohne Rendern nicht verfügbar und fehlt in der Zeile | `an_event_that_cannot_be_rendered_is_a_placeholder_and_does_not_block`, Vitest (Zähler) |
| L8 rohes XML in der Zeile „nicht lesbar“ trotz „XML anhängen“ aus | nur noch, wenn angehängt wird | `times_and_users`, Fluss-Test oben |

## Was geprüft ist und was nicht

**Geprüft (macOS, Apple Silicon):** `cargo test` (Bibliothek 236 → 267, davon 31 für 018 inkl. Review-Nachträge; e2e 391 Schritte),
`npm test` (338 Vitest), `npm run lint`, `npm run build` (Initial 986,56 KB < 1 MB, Dialog lazy 13,7 KB), clippy macOS,
**clippy für `x86_64-pc-windows-msvc` und `-gnu` über die ganze Crate** (nur Rust), e2e: Art unsichtbar, `open_source`
und `winevent_channels` → `unsupported`, kein „Windows-Ereignisse“ auf der Seite.

**Nicht geprüft (nur auf echtem Windows möglich):** dass `api.rs` zur Laufzeit stimmt (Puffergrößen, Fehlercodes wie
`ERROR_NOT_FOUND` bei `EvtSubscribeStrict`, Signal-Event im Pull-Modell, `timediff` in der Abfrage, Formatierung mit
Metadaten, `EvtCancel`), Linken/Ressourcen des Windows-Builds, Remote-Sitzungen (Negotiate, Passwort, Firewall),
Credential Manager, die Dialog-Optik unter WebView2, e2e auf Windows, Leistung bei Millionen Ereignissen.

### Handtest auf Windows (vorgeschlagen)

1. `npm run tauri:dev`; „Quelle öffnen“ → Art „Windows-Ereignisse …“ erscheint; Kanalliste lädt (Application, System,
   Security, Setup zuerst; Filter „powershell“).
2. Application, 24 h → Tab „Ereignisse: Application“, Statusleiste „Lädt Bestand …“ → „Lauscht“, Spalten Zeit/Level/
   Provider/Event-ID/Nachricht, Level-Farben; Detail-Panel zeigt `xml`.
3. Live: `eventcreate /T ERROR /ID 999 /L APPLICATION /SO LogCommanderTest /D "Test Zeile1"` (als Admin) → Zeile < 1 s,
   ERROR; Kontextmenü „Gleiche Event-ID (999)“ filtert.
4. Security als normaler Benutzer → Fehler im Dialog mit dem Hinweis auf Event Log Readers, kein Absturz; als Admin bzw.
   Mitglied → liest, 4624 = INFO, 4625 = ERROR.
5. Ereignis ohne Meldungsdatei (z. B. `eventcreate` mit eigener Quelle ohne Registrierung) → „(keine Meldung) …“.
6. Zeitraum „Alles“ auf System (große Kanäle): Tab bleibt bedienbar, Zähler steigt, Schließen während des Ladens
   < 2 s (Abfrage wartet je `EvtNext` höchstens 1 s). Dasselbe remote mit gezogenem Netzkabel während des Ladens:
   Schließen kommt durch (`EvtCancel` auf Sitzung und Ergebnismenge), kein Absturz.
7. Remote: zweiter Rechner mit Firewall-Regel „Remoteereignisprotokollverwaltung“; erst ohne Regel (Fehlertext), dann
   angemeldete Identität, dann Benutzer/Passwort falsch („Passwort nicht angenommen“, nichts gespeichert) und richtig mit
   „merken“ (Credential Manager: Eintrag `winevent:password:…`), Dialog ohne Passwort erneut → klappt; „vergessen“.
8. Verbindung trennen (Netz aus/Dienst „EventLog“ auf dem Ziel neu starten), Ereignisse erzeugen, Netz an → „Getrennt,
   neuer Versuch …“, danach alle Ereignisse genau einmal (Record-IDs lückenlos). `wevtutil cl Application` während
   der Trennung → Statusleiste „1 Lücke“.
9. Wiederverbinden mehrmals hintereinander (Netz an/aus) und dabei den Tab schließen: kein Absturz (Review M1, Sperre um
   Abbrechen/Schließen). Konto mit abgelaufenem Passwort oder „Anmelden über Netzwerk verweigert“ (1907/1385): sofort
   „Passwort nicht angenommen“, keine Wiederholung (Ereignis 4625 auf dem Ziel nur einmal).
10. Zugriff verweigert remote (Konto ohne „Ereignisprotokollleser“): Text nennt Anmeldedaten/Gruppe dort, nicht den
   lokalen Security-Hinweis.
11. Zwei Kanäle mit „zusammenführen“ → zwei Tabs + Merge-Tab nach Zeit. Arbeitsstand speichern/öffnen → Eintrag ungehakt.
12. `cargo test` unter Windows (die Fluss-Tests mit `fake.rs` laufen auch dort).

## Fortschritt

- [x] Rust: `sources/winevent/` (mod, backend, cache, event, line, follow, api [Windows], fake [Tests]), Profil `winevent`,
  Spaltennamen, `SourceKind::Winevent`, `SourceState::Loading`, `SourceStatus.gaps`, `scoped_account`, `Hub::secret_store`,
  Commands `winevent_supported`, `winevent_channels`, `forget_winevent_secret`
- [x] Review-Nachträge M1–M4, L5–L8 (siehe Sicherheit), Windows-Check erneut grün
- [x] Rust-Tests: 31 neue (Unit + Fluss über Spool/Sitzung: Bestand → live, Wiederverbinden ohne Lücke/Doppel, geleertes
  Protokoll = Lücke, leerer Zeitraum, verlorenes Recht, hängender Aufruf wird abgebrochen)
- [x] Windows-Check: `npm run rust:check-windows` grün (msvc + gnu, clippy `-D warnings`, nur Rust)
- [x] Frontend: Dialog „Windows-Ereignisse“ (lazy), Art im Quellen-Dialog, Tab-Symbol ⊞, Statusleiste, Start-Bildschirm,
  Spalten-Vorgabe, Kontextmenü „Gleiche Event-ID“, Arbeitsstand, Settings (gespeicherte Quellen)
- [x] Vitest `winevent-logic.spec.ts`
- [x] e2e: Unsichtbarkeit und `unsupported` auf macOS; Mock + Screenshots (beschriftet)
- [x] Doku (README, CLAUDE.md, architecture, roadmap)
- [ ] Handtest und Windows-CI (siehe oben), e2e auf Windows
