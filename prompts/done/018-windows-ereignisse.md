# Prompt 018: Windows-Ereignisprotokolle

> Start in neuer Sitzung: „Führe `prompts/018-windows-ereignisse.md` aus.“
> Voraussetzung: 016 (Spool und `Source`). Nur Windows, auf macOS und Linux unsichtbar.
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

Ereignisprotokolle von Windows (Application, System, Security, eigene Kanäle, lokal und auf einem anderen Rechner) öffnen sich wie eine Datei: live,
mit schneller Filterung und Suche, statt über die langsame Ereignisanzeige.

## Entscheidungen

| Thema | Entscheidung | Warum |
|---|---|---|
| Weg | Ereignisse als JSON Lines in den Spool aus 016 | JSON-Profil, Level-Erkennung (`detect_json`, `level.rs:236`) und Spalten aus 008 funktionieren dann ohne Sonderweg. |
| API | `EvtQuery`/`EvtSubscribe`/`EvtRender`/`EvtFormatMessage` über das Crate `windows` | Offizielle API für Kanäle ab Vista, kann Abonnement und Remote-Sitzungen (`EvtOpenSession`). Kein PowerShell-Aufruf je Ereignis. |
| Felder | `timestamp`, `level`, `provider`, `eventId`, `channel`, `computer`, `task`, `user`, `message` | Deckt das Übliche ab. Das vollständige XML liegt im Detail-Panel (004) über ein zusätzliches Feld `xml`, abschaltbar wegen Größe. |

## Backend

1. `sources/winevent.rs` hinter `#[cfg(windows)]`. `platform.rs` zeigt schon, wie Plattformcode getrennt wird. Auf anderen Systemen gibt `open_source` mit dieser Art
   einen klaren Fehler.
2. **Ablauf:** zuerst Abfrage der vorhandenen Ereignisse ab gewähltem Zeitraum (Standard 24 Stunden), dann `EvtSubscribe` mit Bookmark für neue. Nach einem Abbruch
   ab dem Bookmark fortsetzen, keine Lücke und keine Doppel.
3. **Level:** Windows-Level 1 bis 5 (Kritisch, Fehler, Warnung, Information, Ausführlich) und Audit-Erfolg/-Fehler auf die sieben Level der App abbilden. Mapping als Tabelle mit Test.
4. **Text:** `EvtFormatMessage` braucht die Metadaten des Providers. Je Provider cachen, das ist der teure Teil. Fehlt die Nachrichtendatei, eine Zeile mit den
   Insertion-Strings statt einer leeren Meldung. Zeilenumbrüche im Text als `\n`-Escape im JSON, damit ein Ereignis eine Zeile bleibt.
5. **Rechte:** „Security“ braucht Administratorrechte oder die Gruppe Event Log Readers. Zugriff verweigert: verständlicher Fehler mit diesem Hinweis, kein Absturz.
   Die App fordert keine Rechteerhöhung an.
6. **Remote:** Rechnername und optional Benutzer. Passwort nur über den Schlüsselbund wie in 017, Standard ist die angemeldete Windows-Identität.
7. **Menge:** Ein System-Kanal hat schnell Millionen Ereignisse. Rendern in einem eigenen Thread mit Stapeln, Fortschritt über `source_status`, Abbruch beim Schließen.

## Frontend

1. Quelle „Windows-Ereignisse“ im Dialog aus 016, nur unter Windows: Kanäle als Liste (`EvtOpenChannelEnum`), Mehrfachwahl wird ein Merge (006) oder mehrere Tabs,
   Rechner, Zeitraum, XML anhängen ja/nein.
2. Spalten-Layout (009) für dieses Format mit sinnvoller Vorgabe: Zeit, Level, Provider, Event-ID, Meldung.
3. Mit 010: Filter auf Event-ID und Provider über die Spalten, Schnellfilter „gleiche Event-ID“ im Kontextmenü.

## Tests

- **Rust, rein (alle Plattformen):** Level-Mapping, Umwandeln eines gerenderten Ereignisses (XML aus Testdaten) in die JSON-Zeile, Escapes.
- **Rust, nur Windows (CI):** Lesen von `Application`, eigenes Ereignis schreiben (`ReportEvent` oder `eventcreate`), erscheint live, Bookmark nach Neustart der Quelle.
- **e2e:** auf Windows-CI, sonst im Bericht als offen.

## Nicht in diesem Prompt

`.evtx`-Dateien direkt öffnen (eigener Parser, sinnvoller Folgeprompt), Ereignis-Weiterleitung, Schreiben ins Ereignisprotokoll.

## Fertig, wenn

- [ ] Tests oben grün, `npm run check` grün, Windows-CI grün
- [ ] Auf macOS und Linux keine sichtbare Änderung, Build unverändert
- [ ] `README.md`, `CLAUDE.md`, `docs/roadmap.md` ergänzt
- [ ] Sichttest auf Windows, sonst im Bericht als offen genannt

Kein Commit ohne Rückfrage.
