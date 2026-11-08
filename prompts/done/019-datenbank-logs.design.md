# 019 Logs aus Datenbanken – Spike, Design und Stand

Status: Spike erledigt, **alle vier Treiber freigegeben** (autonom entschieden, Vorgabe des Koordinators: einen Treiber nur
weglassen, wenn er zusammen über ~15 MB Binärzuwachs bringt oder native Client-Bibliotheken/OpenSSL braucht), Phase 2–6
umgesetzt. Datum: 2026-11-08. Branch `feat/datenbank-logs`. Sicherheits-Review durch einen separaten Agenten veranlasst der
Koordinator (Schwerpunkte unten).

## Spike (Phase 1)

### Aufbau

- Server in Docker Desktop 29.8 (nur `127.0.0.1`, Wegwerf-Passwörter, danach entfernt): `postgres:17-alpine`,
  `mysql:8.4`, `mariadb:11.4`, `mcr.microsoft.com/mssql/server:2022-latest` (linux/amd64, auf Apple Silicon emuliert).
  TLS mit einem eigenen Wegwerf-CA und Server-Zertifikat (`CN=localhost`, SAN `localhost`, `127.0.0.1`); SQL Server
  zuerst mit seinem selbstsignierten Zertifikat, dann über `mssql.conf` (`tlscert`, `tlskey`, `forceencryption`) mit dem
  eigenen.
- Spike-Programm (Scratch-Ordner) mit Features je Treiber: Verbindung mit Zertifikatsprüfung ohne CA (muss scheitern) und
  mit CA, TLS in Gebrauch (`pg_stat_ssl`, `Ssl_cipher`, `encrypt_option`), `SELECT` umhüllt mit Schlüssel und Limit,
  Schreibversuch in Read-only-Sitzung/-Transaktion, zweite Anweisung im prepared statement, Zeitlimit, `set_config` gegen
  `BEGIN READ ONLY`. Release-Profil wie die App (`lto = "thin"`, `codegen-units = 4`, `strip`).
- Die Integrationstests der Umsetzung laufen gegen dieselben Server (`scripts/db-test-servers.sh`, `--ignored`).

### Messwerte (Apple Silicon, macOS)

| | Ergebnis |
|---|---|
| **Fassade `sqlx`** | **nicht baubar** neben `rusqlite` 0.41: sie nennt `sqlx-sqlite` (libsqlite3-sys ≤ 0.37) auch ohne Feature `sqlite`, Cargo lässt keine zwei `links = "sqlite3"` zu. Lösung: `sqlx-core` + `sqlx-postgres` + `sqlx-mysql` direkt (= 0.9.0). SQLite über `rusqlite` (wie vorgegeben) |
| Binär Spike, Grundlinie (tokio + rustls/ring + chrono) | 0,53 MB |
| + PostgreSQL (sqlx) | 3,10 MB (+2,57) |
| + MySQL (sqlx) | 2,56 MB (+2,04) |
| + beide sqlx | 3,45 MB (+2,93) |
| + SQL Server (tiberius 0.13, rustls) | 4,64 MB (+4,11; aws-lc-rs eingeschlossen) |
| + alle drei | 6,04 MB (+5,51) |
| **App Release macOS arm64** | **17 135 760 → 22 441 072 Byte (+5,31 MB)**, Build 2 min 25 s statt 1 min 10 s |
| Build Linux | **geprüft** in Docker `rust:1-bookworm` (aarch64): Spike mit allen vier Treibern 7,89 MB, `ldd` nur libc/libm/libgcc_s |
| Build Windows | `npm run rust:check-windows` grün (clippy msvc + gnu, ganze Crate inkl. aws-lc-sys-Buildskript mit Platzhalter-Compiler). Gelinkt nicht geprüft. Begründet: reines Rust + ring (wie 017) + aws-lc-sys (bringt vorgebaute NASM-Objekte für x86_64-msvc mit, CMake nicht nötig), keine Systembibliothek |
| TLS PostgreSQL | ohne CA `invalid peer certificate: UnknownIssuer`, mit CA ok (36 ms), `pg_stat_ssl.ssl = true` |
| TLS MySQL 8.4 / MariaDB 11.4 | ohne CA abgelehnt, mit CA ok (8 / 7 ms), `TLS_AES_256_GCM_SHA384` |
| TLS SQL Server 2022 | selbstsigniert: Prüfung scheitert (`UnsupportedCertVersion`), mit eigenem Zertifikat ohne CA `UnknownIssuer`, mit CA ok (176 ms, emuliert), `encrypt_option = TRUE`; ohne Prüfung verschlüsselt ok |
| SQLite (rusqlite, `SQLITE_OPEN_READ_ONLY`) | Schreiben: „attempt to write a readonly database“ |
| Schreibschutz PostgreSQL | `default_transaction_read_only`: INSERT abgelehnt; prepared statement mit 2 Anweisungen abgelehnt; `statement_timeout` greift; `set_config('transaction_read_only','off')` in `BEGIN READ ONLY` abgelehnt |
| Schreibschutz MySQL/MariaDB | `SET SESSION TRANSACTION READ ONLY` und `START TRANSACTION READ ONLY`: INSERT abgelehnt (1792); 2 Anweisungen = Syntaxfehler; `max_execution_time` / `max_statement_time` beenden `SLEEP` nach 2 s |
| Schreibschutz SQL Server | `ApplicationIntent=ReadOnly` **wirkt nicht** auf einem einzelnen Server (INSERT ging durch, nur Replikate einer AG); in `BEGIN TRAN … ROLLBACK` bleibt nichts; parametrisierte Abfrage (`sp_executesql`) nimmt mehrere Anweisungen an |

### Entscheidung Treiber

**Alle vier kommen:** PostgreSQL und MySQL/MariaDB über die `sqlx`-Unter-Crates, SQL Server über `tiberius` 0.13,
SQLite über das vorhandene `rusqlite`. Zusammen +5,3 MB (Richtwert 15 MB), keine native Client-Bibliothek, kein
OpenSSL. Einziger Wermutstropfen: `tiberius` 0.13 verlangt rustls mit aws-lc-rs (gebündeltes C wie ring, ~1,5 MB);
`tiberius` 0.12 hätte stattdessen rustls 0.21 (veraltet, zweite rustls-Version) gebracht. Ring wird als Prozess-Provider
gesetzt (`driver::install_crypto`), sodass alle Verbindungen dieselbe Kryptografie nutzen.

## Entscheidungen (statt Anhalten)

| Frage | Entscheidung | Grund |
|---|---|---|
| Platzhalter | Kein Platzhalter in der Nutzerabfrage: die App umhüllt `SELECT * FROM (<abfrage>) lc WHERE lc.key >= ? ORDER BY lc.key LIMIT n` (SQL Server `TOP (n)`); ORDER BY/LIMIT/OFFSET/FETCH/TOP oben werden abgelehnt | Ordnung und Grenze gehören der App; in einer Unterabfrage kann keine Anweisung beginnen; die Prüfung bleibt einfach |
| Prüfung „nur SELECT“ | `sql::check_select`: Tokenizer je Dialekt (Strings mit `''`, `E'…'`/MySQL-Backslash, `N'…'`, `$tag$`, Namen in `""`/`` ` ``/`[]`, Kommentare `--`, `/* */` verschachtelt bei PG/MSSQL, `#` bei MySQL, MySQL `/*! … */` abgelehnt), erstes Wort SELECT/WITH, kein `;` dazwischen, Klammern ausgeglichen, verbotene Wörter (INSERT, UPDATE, DELETE, MERGE, INTO, DROP, ALTER, CREATE, EXEC, CALL-artige, OPENROWSET/OPENQUERY, WAITFOR, ATTACH, PRAGMA, BEGIN/COMMIT, `NEXT VALUE FOR`, …), höchstens 64 KB | Erste Wand; „LIMIT 0“-Prüfung allein hätte Schreiben in CTEs (PG) oder Zweitanweisungen (MSSQL) nicht verhindert. Häufige Spaltennamen (`comment`, `handler`, `load`) bleiben erlaubt |
| Schreibschutz auf dem Server | PG: `default_transaction_read_only=on`, `statement_timeout`, `standard_conforming_strings=on` als Startoptionen, jede Anfrage in `BEGIN READ ONLY … ROLLBACK`. MySQL: `SET SESSION TRANSACTION READ ONLY`, `time_zone='+00:00'`, sql_mode ohne `ANSI_QUOTES`/`NO_BACKSLASH_ESCAPES`, Zeitlimit, jede Anfrage in `START TRANSACTION READ ONLY … ROLLBACK`. SQL Server: `ApplicationIntent=ReadOnly`, `LOCK_TIMEOUT`, `QUOTED_IDENTIFIER ON`, jede Anfrage in `BEGIN TRANSACTION … IF @@TRANCOUNT > 0 ROLLBACK`. SQLite: `SQLITE_OPEN_READ_ONLY` (= `mode=ro`, ohne URI, die ein Pfad erweitern könnte), `query_only`, Authorizer aus `report_db.rs`, Limits, Progress-Handler | Prompt; der Spike zeigte, dass `ApplicationIntent` allein nichts schützt. sql_mode und standard_conforming_strings: Strings enden dort, wo die Prüfung sie enden lässt |
| Prüfung vor dem Start | `Probe` = prepare (PG, MySQL, SQLite) bzw. `WHERE 1 = 0` (SQL Server); Schlüsselspalte muss im Ergebnis sein (exakt, sonst eindeutig ohne Groß-/Kleinschreibung) und Zahl, Text, Datum oder Zeit; Zeit- und Level-Spalte müssen vorkommen; höchstens 200 Spalten | Prompt („LIMIT 0“); prepare führt nichts aus |
| Gleiche Schlüssel | `>=` und `value::Edge`: Multimenge der Hashes der geschriebenen Zeilen mit dem letzten Schlüssel, Limit = 10 000 + Randgröße (alle Randzeilen kommen sicher zuerst), bekannte werden übersprungen; über 100 000 Zeilen mit einem Schlüssel → einmal `>` und `gaps` + 1 | Prompt Punkt 3; mit Limit allein könnten bei vielen gleichen Zeiten Zeilen fehlen |
| Startpunkt | „letzte N“ (Vorgabe 1000, bis 1 000 000): Schlüssel der N-neuesten Zeile (`ORDER BY key DESC OFFSET N-1`), ab ihm `>=`; „alle Zeilen“: erster Stapel ohne Bedingung. Aufholen ohne Pause, solange Stapel voll sind (Zustand „Lädt Bestand …“) | Prompt |
| Werte | `timestamp`/`level` zuerst (umbenannt), dann die Spalten der Abfrage; Kollision → `name_2`; Zeit mit Zone lokal mit ms und Offset, ohne Zone ohne Offset; Zahlen als JSON-Zahl, NUMERIC/DECIMAL/MONEY unverändert (PG-Binärformat selbst dekodiert), NaN/∞ als Text; Bool; Binär „(binär, N Byte)“; JSON-Spalten als String; UUID/XML als Text; unbekannte Typen „(Typ X)“ bzw. UTF-8-Text (Enums); Text escaped wie 016/018 (C0, DEL, C1, Bidi, U+2028/9 als `\uXXXX`), 32 000 Zeichen, Zeile 256 KB, Stapel 32 MB | Prompt; Fremddaten |
| Profil | `jsonl` fest (`Source::profile`) | Spalten der Abfrage werden Spalten der Ansicht (008), Level aus `level` |
| Zeitlimit | 30 s je Anfrage auf dem Server (wo möglich) und in der App (`tokio::time::timeout`), Verbinden 20 s; Schließen des Tabs bricht ab (Stopp-Signal im `select!`, SQLite über den Progress-Handler) | Ein hängender Server darf das Schließen nicht blockieren |
| Wiederverbinden | 1, 2, 4 … 60 s (`Reconnecting`), Spalten neu geprüft (geändert → Fehler „Tab neu öffnen“), ab letztem Schlüssel und Rand; abgelehnte Anmeldung → `Error`, kein neuer Versuch | Prompt; keine gesperrten Konten |
| Zugangsdaten | wie 017/018: Dialog oder Schlüsselbund (`db:password:<16 Hex aus engine:user@host:port/db>`), gespeichert nur mit Häkchen nach Erfolg, „vergessen“, im Speicher als `Secret` nur solange die Quelle läuft. SQL Server nur SQL-Anmeldung | Prompt; Windows-Anmeldung an SQL Server bräuchte `winauth`/SSPI |
| TLS | Vorgabe „mit Zertifikatsprüfung“ (Systemzertifikate + optionale CA-Datei), wählbar „ohne Prüfung“ und „ohne TLS“ jeweils mit sichtbarer Warnung im Dialog; im Arbeitsstand steht die Warnung in der Bestätigung | Prompt; interne Server haben oft eigene CAs |
| Arbeitsstand | Konfiguration ohne Passwort und ohne CA-Datei (fremder Pfad), **immer ungehakt** („fragt … ab (erst nach Häkchen)“); Passwort/Zertifikat/Abfrage-Fehler öffnen den Dialog vorbefüllt | „a workspace never auto-connects“ |
| Tab, Statusleiste | `db:schema.tabelle` (erste Tabelle nach FROM oben), sonst `db:datenbank`; Statusleiste „N Zeilen · letzte Abfrage HH:MM:SS (12 ms)“ (`SourceStatus.polledAtMs`, `latencyMs`); Symbol ⛁ | Prompt |
| „Tabelle wählen“ | Command `db_tables` (information_schema bzw. `sqlite_schema`, höchstens 2000, App-SQL in derselben Read-only-Transaktion), Auswahl schreibt `SELECT * FROM "schema"."tabelle"` (Namen je Dialekt gequotet) | Prompt |
| Vorschau | Command `db_preview`: dieselbe Prüfung und Verbindung wie das Öffnen, die ersten 20 Zeilen als Spool-Zeilen; der Dialog zeigt sie als Tabelle (Text, nie Markup) und schlägt Zeit-/Level-Spalte aus üblichen Namen vor | Prompt |
| Abstand | Vorgabe 2 s, 0,5 s – 1 h | Prompt |
| Kürzel | keins (über „Quelle öffnen“ `Cmd/Ctrl+Shift+L` → Art „Datenbank“) | Vier Arten teilen sich den Dialog |
| Farben | keine neuen Tokens | `npm run contrast` unverändert |

## Sicherheit (Schwerpunkte für das Review)

| Maßnahme | Test |
|---|---|
| Nur ein SELECT, verbotene Wörter und Funktionen, Strings/Kommentare/Namen wie der Dialekt (siehe Nachträge) | `sql::tests::*` (u. a. versteckte Anweisung hinter `'a'''`, `'a\\'` in PG gegen MySQL, verschachtelte Kommentare, `/*! */`, Klammer-Ausbruch für SQL Server) |
| Datenbank schreibt nicht, auch wenn die Prüfung umgangen würde | `sqlite_is_never_written` (Authorizer/read-only gegen DELETE, INSERT, DROP, ATTACH, PRAGMA, TEMP TABLE, load_extension; Datei byte-gleich); `db_integration` je Server: Funktion `wr()` mit INSERT im SELECT scheitert (PG, MySQL, MariaDB), eingeschleuste Zweitanweisung am Prüfer vorbei: abgelehnt (PG, MySQL) bzw. zurückgerollt (SQL Server), Zeilenzahl unverändert; e2e: `expectdbcount` |
| Kein Passwort in Konfiguration, Settings, Arbeitsstand, Fehlern, Status; falsches nie im Schlüsselbund | `passwords_are_asked_for_and_kept_only_on_request`, `configs_are_checked`, Vitest (`parseDbConfig` ignoriert `password`), `db_integration` (Fehlertext ohne Passwort) |
| Werte sind Fremddaten | `values_become_json`, `long_texts_and_lines_are_cut_and_marked`; Dialog zeigt Vorschau per Interpolation |
| TLS geprüft | `db_integration`: ohne Test-CA → „Zertifikat … nicht anerkannt“, mit CA ok (alle vier Server) |
| Kein Auto-Verbinden aus einem Arbeitsstand | Code (`askConfirm`, `checked: false`), CA-Datei wird beim Speichern und Laden verworfen (Vitest) |
| Zeitlimit/Abbruch | `sqlite_errors_and_stop` (endlose rekursive CTE endet beim Stopp) |
| Anmeldung abgelehnt → kein Wiederholen | `a_refused_login_is_not_retried` |

### Nachträge nach dem unabhängigen Review

| Befund | Behebung | Test |
|---|---|---|
| #1 MySQL: `--` ist nur vor Leerraum/Steuerzeichen/Ende ein Kommentar (`--1` = `- -1`), `#` war Namenszeichen (`x#` beginnt aber einen Kommentar); Ausbruch `SELECT 1 AS id--1) lc INTO OUTFILE '…' #` ging durch | Tokenizer je Dialekt: `--` in MySQL nur mit folgendem Leerraum/Steuerzeichen/Ende, `#` nie Namenszeichen außer SQL Server; Zahlen enden vor Buchstaben (`1INTO`); `OUTFILE`, `DUMPFILE` verboten; Liste verbotener Funktionen (`LOAD_FILE`, `GET_LOCK`, `lo_export`/`lo_import`, `pg_read_file`, `pg_ls_dir`, `pg_terminate_backend`, `pg_cancel_backend`, `dblink*`, Advisory Locks, `set_config`, `pg_notify`, `xp_*`, …), auch als gequoteter Name | `dialect_lexing_finds_breakouts`; Docker `mysql_never_writes_files`, `mariadb_never_writes_files` |
| #1 Gegenprobe Server | **`START TRANSACTION READ ONLY` stoppt `INTO OUTFILE` nicht** (MySQL 8.4 und MariaDB 11.4 als root: Datei geschrieben); ein Konto nur mit SELECT: „Access denied; you need … the FILE privilege“, keine Datei. Ebenso PostgreSQL: **`BEGIN READ ONLY` stoppt `lo_export` nicht** (als postgres: Datei geschrieben); Rolle nur mit SELECT: „permission denied for function lo_export“. Folge: Empfehlung eines Nur-Lese-Kontos im Dialog und README, Tests halten das Verhalten fest | `postgres_lo_export`, `*_never_writes_files` (prüfen beides) |
| #2 gespeichertes Passwort ging auch an eine Arbeitsstand-Abfrage mit abgeschalteter TLS-Prüfung | Konto im Schlüsselbund enthält den TLS-Modus (`…#verify`); genutzt werden nur Passwörter, die mit diesem oder einem schwächeren Modus gespeichert wurden; „vergessen“ löscht alle. Die Bestätigung eines Arbeitsstands zeigt die Abfrage (eine Zeile, ≤ 500 Zeichen) | `passwords_are_asked_for_and_kept_only_on_request` (verify gespeichert → noVerify/off fragen neu; off gespeichert → verify nutzt es), Vitest `workspaceQuery` |
| #3 riesige Werte wurden vor dem Budget ganz kopiert | Binär nur Länge (`&[u8]`), Text als `&str`/Bytes und vor dem Kopieren auf 32 001 Zeichen gekürzt (`value::text`, `text_bytes`) in allen vier Treibern; die Treiber halten eine Zeile trotzdem ganz im Speicher (dokumentiert) | `huge_values_are_copied_only_as_far_as_the_line_takes` |
| #4 Nicht-ASCII-Zeichen gehören in PostgreSQL/MySQL/SQLite zu Namen | Namenszeichen je Dialekt (jedes Nicht-ASCII-Zeichen in PG, MySQL, SQLite) | `dialect_lexing_finds_breakouts` (`€$$) lc FOR UPDATE --$$`) |
| #5 Restrisiken und SQL Server | README „Reading databases safely“: was mit privilegiertem Konto bleibt (unbekannte Funktionen, CLR, erweiterte Prozeduren, Dateien, Sitzungen, Sperren). SQL Server: `LOCK_TIMEOUT` gesetzt, bei Abbruch/Zeitlimit wird die Verbindung geschlossen; gemessen: die laufende Abfrage ist **nach 0,2 s** aus `sys.dm_exec_requests` verschwunden | `sql_server_stops_after_disconnect` |

## Was geprüft ist und was nicht

**Geprüft (macOS, Apple Silicon):** Rust-Tests (Bibliothek 268 → 288, davon 20 für 019), `db_integration` gegen
PostgreSQL 17, MySQL 8.4, MariaDB 11.4, SQL Server 2022 (Docker, TLS mit Test-CA): alle vier grün; Vitest; Windows-Check
(clippy msvc + gnu); Linux-Build des Spikes in Docker; e2e mit der SQLite-Quelle (siehe Bericht).

**Nicht geprüft:** gelinkter Windows-Build und Laufzeit unter Windows (aws-lc-sys, Credential Manager), Linux-Build der
ganzen App, Azure SQL / RDS / Cloud SQL mit echten Zertifikatsketten, sehr große Tabellen (Millionen Zeilen) gegen
echte Server, SQL Server mit Windows-Anmeldung (nicht unterstützt), Handtest der Dialog-Optik hell/dunkel.

### Handtest (vorgeschlagen)

1. `sh scripts/db-test-servers.sh up`, App starten, „Quelle öffnen“ → Datenbank → PostgreSQL `localhost:15432`,
   `postgres`, Passwort aus dem Skript, CA-Datei `${TMPDIR}/lc-db-test/ca.pem`, „Tabelle wählen“, Vorschau, Öffnen.
2. `docker exec lc-dbtest-pg psql -U postgres -c "INSERT INTO logs (ts, level, msg) VALUES (now(), 'ERROR', 'x')"` →
   Zeile < 3 s, ERROR. Container neu starten → „Getrennt, neuer Versuch …“, danach weiter ohne Doppel.
3. TLS „ohne Prüfung“ → Warnung im Dialog; Arbeitsstand speichern/öffnen → Eintrag ungehakt mit Warnung, Passwort fragt.
4. Hell und dunkel, schmales Fenster.

## Fortschritt

- [x] Spike: Größen, TLS zu allen vier Servern, Schreibschutz, Linux-Build, Windows-Check
- [x] Rust: `sources/database/` (mod, sql, value, driver, follow, pg, mysql, mssql, sqlite, fake, tests),
  `SourceKind::Database`, `SourceStatus.polledAtMs`, Commands `db_preview`, `db_tables`, `forget_db_secret`
- [x] Tests: Unit (Prüfung, Werte, Rand, Konfiguration, Passwort) + Fluss über Spool/Sitzung (Fake) + SQLite echt;
  `tests/db_integration.rs` (`--ignored`, Docker) für PostgreSQL, MySQL, MariaDB, SQL Server
- [x] Frontend: Dialog „Datenbank“ (lazy), Art im Quellen-Dialog, Tab-Symbol, Statusleiste, Start-Bildschirm,
  Arbeitsstand, gespeicherte Quellen; Vitest `database-logic.spec.ts`
- [x] e2e: SQLite-Quelle (Tabelle wählen, Abwehr schreibender Abfragen, Vorschau, live, gleiche Zeiten, DB unverändert)
- [x] Mock + Screenshots `database.png`, `database-dialog.png`; Doku (README, CLAUDE.md, architecture, roadmap)
- [ ] Handtest (siehe oben), Windows-/Linux-Build der App
