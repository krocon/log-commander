# Prompt 015: Export, Arbeitsstand und Teilen

> Start in neuer Sitzung: „Führe `prompts/015-export-und-arbeitsstand.md` aus.“
> Funktioniert ohne andere Prompts. Mit 008/009 kommen Spalten in CSV und JSON, mit 007 Lesezeichen, mit 010 der Filterbaum dazu.
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

Drei Dinge, die eine Analyse überdauern lassen:

1. **Export** der Ansicht, Auswahl oder ganzen Datei als TXT, CSV oder JSON Lines.
2. **Arbeitsstand** speichern und öffnen: Dateien, Filter, Lesezeichen, Notizen, Spalten. Nach einem Neustart ist alles wieder da.
3. **Teilen** für Tickets: Auswahl samt Kontext als Markdown oder Jira-Markup in die Zwischenablage.

## Entscheidungen

| Thema | Entscheidung | Warum |
|---|---|---|
| Export-Weg | Backend schreibt direkt in die Zieldatei, als Job mit Fortschritt und Abbruch | Ein Export kann Gigabytes groß sein und darf nie als String durch IPC (`copy_lines` hat deshalb 256 MB Grenze, `session.rs:35`). |
| Lesezeichen und Notizen | Verankert über Zeilennummer **plus** Byte-Offset und Prüfsumme der Zeile | Zeilennummern ändern sich, wenn die Datei rotiert oder neu geschrieben wird. Mit der Prüfsumme lässt sich die Zeile wiederfinden oder ehrlich als „nicht gefunden“ melden. |
| Format Arbeitsstand | Eine JSON-Datei `.lcw` mit `version` | Lesbar, versionierbar, und man kann sie ins Ticket hängen. Pfade absolut und zusätzlich relativ zur `.lcw`. |
| Ticketsysteme | Kein API-Zugriff auf Jira oder Trello | Zwischenablage und Datei reichen für das Teilen. Zugangsdaten zu fremden Diensten wären ein eigenes Thema. |

## Backend

1. `export_view(session_id, view, range, format, columns, target_path) -> job_id`, Fortschritt über `SessionUpdate` oder eigenen Channel, `cancel_export`.
   `range`: Auswahl (`first`/`last`), Ansicht, alles. Text über `LineReader` und `display_text`, ganze Zeilen (keine 128-KB-Grenze), in Blöcken in eine
   temporäre Datei daneben, am Ende umbenennen. Abbruch löscht sie.
2. CSV nach RFC 4180 mit Spalten aus 008, Feldern in Anführungszeichen, `\r\n`. JSON Lines mit Schlüsseln der Spalten, `line`, `level`. Ohne 008:
   CSV mit `line,level,text`.
3. `line_anchor(session_id, line) -> Anchor { line, offset, hash }` und `resolve_anchor(session_id, anchor) -> Option<u32>`: Zeile, sonst Suche um den Offset
   und um die Nummer im Umkreis von 10.000 Zeilen nach gleicher Prüfsumme. Prüfsumme über die ersten 256 Bytes.
4. Pfade für Ziel und Arbeitsstand kommen aus dem Dialog des Frontends. Im Backend prüfen, dass das Ziel nicht die offene Logdatei selbst ist.

## Frontend

1. **Export-Dialog:** Bereich, Format, Spalten (falls vorhanden), dann der native Speichern-Dialog. Fortschritt in der Statusleiste mit Abbruch. Kürzel
   `Cmd/Ctrl+Shift+E`.
2. **Notizen:** zu einem Eintrag, kurzer Text. Sichtbar als Symbol in `.mark`, im Ruler (007) und im Detail-Panel (004). Kürzel `Shift+M`. Lesezeichen aus 007 werden
   dauerhaft, indem der Arbeitsstand sie mitnimmt.
3. **Arbeitsstand:** Menü „Arbeitsstand speichern/öffnen“, in der Liste der zuletzt geöffneten Dateien mit eigenem Symbol. Inhalt: Dateien bzw. Merge-Gruppen (006)
   und Quellen (016 bis 019, ohne Geheimnisse), je Tab Filter (Levels, Suche, Baum aus 010), Spalten-Layout, Lesezeichen und Notizen als Anker, Detail- und
   Leistenzustand, aktiver Tab, Scrollposition als Anker. Fehlende Dateien beim Öffnen: Liste mit „Suchen …“ und „Überspringen“, nicht abbrechen.
4. **Nicht gefundene Anker** werden gesammelt angezeigt und bleiben im Arbeitsstand, falls die Datei später wieder passt.
5. **Teilen:** Kontextmenü der Auswahl „Als Markdown kopieren“ und „Als Jira kopieren“: Kopf mit Datei, Zeilen, Zeitraum, aktivem Filter als Text, darunter
   der Text im Codeblock (` ``` ` bzw. `{code}`), Notizen als Liste. Grenze 64 KB mit Hinweis, für mehr gibt es den Export.
6. Reine Funktionen mit Spec: Serialisierung und Migration des Arbeitsstands, Markdown und Jira, Umrechnung der Pfade.

## Fallen

- Zwischenablage: Text kommt asynchron, WebKit lehnt außerhalb einer Geste ab. Die Ausweichlösung in `writeClipboard` (`log-session.service.ts:220`) nutzen.
- Export während des Tails: Endpunkt beim Start festlegen, sonst endet der Export nie.
- Export einer eingefrorenen Ansicht mit `frozenStale`: Hinweis, weil der Text nicht mehr zum Index passen kann.
- Pfade unter Windows, Netzlaufwerke, Sonderzeichen in Dateinamen.
- Lesezeichen und Notizen gehören zur Datei, nicht zum Tab (siehe 013).

## Tests

- **Rust:** Export aller Formate mit Umlauten, UTF-16, Zeilen über 128 KB, CSV-Sonderzeichen, Abbruch hinterlässt nichts, Ziel = Quelle wird abgelehnt.
  Anker: gleiche Datei, Zeilen davor eingefügt, rotiert, geleert. Messung Export 500 MB.
- **Vitest:** Arbeitsstand hin und zurück, Migration einer älteren `version`, Markdown und Jira mit Backticks und `{code}` im Text, relative Pfade.
- **e2e:** Export über den Befehl mit festem Pfad (Dialog nicht abgedeckt, im Bericht nennen), Notiz setzen, Arbeitsstand schreiben, App-Zustand zurücksetzen, laden, alles wieder da.

## Fertig, wenn

- [ ] Tests oben grün, `npm run check` und `npm run e2e` grün
- [ ] Export großer Dateien belastet weder Speicher noch Tail
- [ ] `README.md`, `CLAUDE.md`, `docs/roadmap.md` (Export, Workspace, Lesezeichen und Notizen) ergänzt
- [ ] Sichttest, sonst im Bericht als offen genannt

Kein Commit ohne Rückfrage.
