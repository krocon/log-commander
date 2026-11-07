# Prompt 019: Logs aus Datenbanken

> Start in neuer Sitzung: „Führe `prompts/019-datenbank-logs.md` aus.“
> Voraussetzung: 016 (Spool und `Source`). Spike mit Halt in Phase 1 wegen der Treiber.
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

Anwendungen schreiben Logs oft in eine Tabelle. Eine Abfrage auf PostgreSQL, MySQL/MariaDB, SQL Server oder SQLite liefert die Zeilen, neue Zeilen laufen live ein.

## Entscheidungen

| Thema | Entscheidung | Warum |
|---|---|---|
| Weg | Ergebnis als JSON Lines in den Spool aus 016 | Gleiche Begründung wie bei 016 und 018. Spalten der Abfrage werden Spalten der Ansicht (008). |
| Treiber | `sqlx` für PostgreSQL, MySQL und SQLite, `tiberius` für SQL Server | Reines Rust, kein ODBC-Treiber auf dem Rechner nötig. OLEDB gibt es nur unter Windows. **Oracle nicht in V1**, es braucht den Oracle Instant Client. Größe und Build im Spike klären. |
| Live | Abfrage mit fortlaufender Schlüsselspalte (`id` oder Zeit) in Abständen, `WHERE key > :letzter` | Funktioniert auf allen vier Datenbanken. Trigger und Benachrichtigungen (`LISTEN`) wären je Datenbank eigener Code. |
| Rechte | Die Verbindung ist schreibgeschützt, wo es die Datenbank erlaubt, und die Abfrage muss ein `SELECT` sein | Ein Log-Viewer darf keine Daten ändern, auch nicht versehentlich. |

## Phase 1: Spike, dann anhalten 🛑

Binärgröße mit den Treibern, Build auf drei Plattformen, Verbindung mit TLS zu den vier Datenbanken in Docker. Ergebnis als `prompts/019-datenbank-logs.design.md`,
**dann anhalten und entscheiden lassen**, ob alle Treiber oder nur ein Teil kommen.

## Phase 2: Umsetzung (nach Freigabe)

1. `sources/database.rs`: Verbindung, `SELECT` mit Platzhalter für den letzten Schlüssel, Abstand einstellbar (Standard 2 s), Stapel von höchstens 10.000 Zeilen je Abfrage.
   Zeilen nach Schlüssel geordnet in den Spool, eine JSON-Zeile je Datensatz. Werte: Zeit ISO 8601, Zahlen als Zahl, Binärdaten als Hinweis statt Inhalt, Text mit Escapes.
2. **Prüfung:** Abfrage vor dem Start mit `LIMIT 0` bzw. `TOP 0` ausführen. Schlüsselspalte muss im Ergebnis sein und sortierbar. Mehrere Anweisungen ablehnen. Verbindung
   mit Leserechten (`SET TRANSACTION READ ONLY`, `ApplicationIntent=ReadOnly`, `default_transaction_read_only`, SQLite `mode=ro`). Zeitlimit je Abfrage.
3. **Schlüssel ohne Eindeutigkeit** (Zeit mit gleichen Werten): `>=` mit Merken der Schlüssel am Rand, sonst gehen Zeilen verloren oder kommen doppelt. Test dafür.
4. **Zugangsdaten** wie in 017 im Schlüsselbund, Verbindungsangaben ohne Passwort in den Settings. TLS standardmäßig an, Zertifikatsprüfung abschaltbar nur mit Warnung.
5. Verbindungsabbruch: neu verbinden mit wachsendem Abstand, ab letztem Schlüssel weiter.

## Frontend

1. Quelle „Datenbank“ im Dialog aus 016: Art, Host, Port, Datenbank, Benutzer, Anmeldung, Abfrage (mit Vorlage „Tabelle wählen“, die die Abfrage erzeugt), Schlüsselspalte,
   Zeitspalte, Level-Spalte (für das JSON-Profil umbenannt auf `level`), Abstand, Startpunkt (alle Zeilen oder letzte N).
2. Vorschau der ersten 20 Zeilen vor dem Öffnen.
3. Tab „db:schema.tabelle“, Statusleiste mit letzter Abfrage und Dauer.

## Tests

- **Rust, rein:** Umwandlung der Werte, Ablehnung von Nicht-`SELECT`, Logik für den Schlüssel am Rand.
- **Integration** (`--ignored`, Docker für PostgreSQL, MySQL, SQL Server, SQLite immer): Erstabruf, neue Zeilen, gleiche Zeitstempel, Abbruch, Schreibversuch scheitert.
- **e2e:** mit SQLite-Datei aus den Tests, ohne Netz.

## Nicht in diesem Prompt

Oracle, ODBC und OLEDB, Schreiben, `LISTEN`/Change-Streams, Abfragen über mehrere Datenbanken.

## Fertig, wenn

- [ ] Design freigegeben, Tests oben grün, `npm run check` und `npm run e2e` grün
- [ ] Keine Schreibanweisung erreicht die Datenbank, durch Tests belegt
- [ ] `README.md`, `CLAUDE.md`, `docs/roadmap.md` ergänzt, neue Abhängigkeiten im Bericht
- [ ] Sichttest, sonst im Bericht als offen genannt

Kein Commit ohne Rückfrage.
