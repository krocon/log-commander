# Design 022: MCP-Schnittstelle (KI-Steuerung)

Status: umgesetzt · Datum: 09.11.2026 · Freigabe: Marc, 09.11.2026 („bitte setze prompt 022 selbständig um“ – der
Haltepunkt nach Phase 1 entfällt damit, die Entscheidungen unten sind meine Empfehlungen und gelten).

Vorbild: AppIconic 018/086 (`ai-mcp`: Sidecar, Brücke, eigene JSON-RPC-Schicht, `probe`), übernommen mit
Herkunftsvermerk, auf Log Commander zugeschnitten.

## Entscheidungen

| # | Entscheidung | Grund |
|---|---|---|
| A1 | Crate `lc-mcp` in `src-tauri/mcp` (Workspace-Mitglied, nur `serde`/`serde_json`), Binary `log-commander-mcp`. Liegt nach `cargo build -p lc-mcp` in `src-tauri/target/<profil>/` direkt neben der App | Gleiche Architektur wie AppIconic; der Debug-Sidecar liegt ohne Kopieren dort, wo die App ihn sucht |
| A2 | Endpunkt-Datei `<Config>/io.github.krocon.logcommander/mcp.json` (`{port, token, pid}`, 0600), Umgebungsvariable `LOG_COMMANDER_MCP_ENDPOINT` für Tests/e2e | Prompt |
| A3 | **Alle Tools laufen im Frontend** (`McpService`), Rust prüft nur: Name in der Positivliste, `args` ein Objekt ≤ 1 MiB, Antwort ≤ 1 MiB, Zeitgrenze je Tool, Rate-Grenze. Weg Rust → Frontend über **einen Channel** (`subscribe_mcp`, wie die Session-Channels), Antwort per `mcp_reply` | Tabs, Filter-Tab-Kette, Auswahl, Lesezeichen und Notizen kennt nur das Frontend; jede Wirkung läuft über `LogSessionService` wie Tastatur/Menü. Ein Channel braucht keine Event-Rechte in den Capabilities. Messung: `read_lines` mit 500 Zeilen ≈ 2 IPC-Sprünge mehr, unkritisch (Antwort ≤ 1 MiB) |
| A4 | `help` beantwortet der **Sidecar** selbst aus `src-tauri/mcp/guide/*.md` (`include_str!`); er geht also auch, wenn die App aus ist. Dynamisches (Spalten, Profile, Aktionen) liefern `get_tab`, `list_actions` | Eine Quelle für Doku und Hilfe |
| A5 | Zusätzlich MCP-**Prompts** (`prompts/list`, `prompts/get`): `triage_errors`, `incident_window`, `explain_selection`, `watch_for`, `slow_requests` – reine Texte im Sidecar | Klein, und der Nutzer findet Einstiege im Client |
| A6 | Zeilen 1-basiert wie die Anzeige (`line` = Zeile der Datei, `pos` = Position in der Ansicht des Tabs). Jede Antwort mit Zeilen trägt `epoch` und `view_generation`. Wer `epoch` mitgibt und nicht mehr trifft → `stale_view` | Prompt |
| A7 | Filterbaum in der Form der Seitenleiste (`kind: group/cond`, `op`, `negate`, `cond` wie `FilterCond`); `id`/`enabled` optional. Geprüft mit `sanitizeTree`; fällt dabei eine Bedingung weg → `invalid_filter` statt stiller Änderung | Eine Form für Seitenleiste, Arbeitsstand und KI |
| A8 | `wait_for_lines` öffnet eine **verborgene Backend-Ansicht** (`open_view` unter der Ansicht des Tabs) mit dem Muster und wartet auf deren Wachstum; danach wird sie geschlossen. Gezählt gegen die 8 Ansichten je Datei (`too_many_views`) | Muster und Level prüft Rust (lineare Regex, Stacktraces als Eintrag), kein JS-Regex auf Logtext (ReDoS im UI-Thread) |
| A9 | `search` = `find_next` in Schleife ab `from`, höchstens 200 Treffer, bis zum Umlauf; die Suche des Tabs bleibt unverändert | Prompt |
| A10 | `run_sql`: öffnet die Datenbank des Tabs bei Bedarf (`open_report`), wartet bis `ready` (≤ 30 s, sonst `report_building` mit Fortschritt), Slot `mcp`. Hat die KI sie geöffnet und zeigt der Tab kein Dashboard, ruft sie danach `close_report` (kein Nachziehen im Hintergrund) | 012 unverändert |

## Entscheidungsfragen des Prompts

| # | Entscheidung |
|---|---|
| E1 | Alle Tabs sichtbar; je Tab „Vor der KI verbergen“ (Kontextmenü des Tabs, Symbol im Tab). Ein verborgener Tab fehlt in `get_workspace`, jede Anfrage mit seiner Id → `tab_not_found` (nicht `tab_hidden`: die KI soll nicht erfahren, dass es ihn gibt). Filter-Tabs eines verborgenen Tabs erben das Verbergen. Nicht im Arbeitsstand (Absicht je Sitzung) |
| E2 | Einstellung „Bekannte Geheimnisse maskieren“ (Vorgabe **an**): `Bearer …`, JWT, `password=`/`passwd=`/`pwd=`, `secret=`, `token=`, `api[_-]?key=`, `Authorization:`; ersetzt durch `«masked»`, Zähler `masked` in der Antwort. Gilt für jeden Logtext, der das Frontend Richtung KI verlässt. Eigene Muster später |
| E3 | Filter und SQL warten bis 30 s; danach Antwort mit `complete: false` und Zählern. Ein abgebrochener Aufruf ändert nichts in der App |
| E4 | Nur `wait_for_lines` (≤ 120 s, Vorgabe 30 s, höchstens 2 zugleich); keine Resources |
| E5 | `run_action` über eine Positivliste (`MCP_ACTIONS` in `features/mcp/mcp-actions.ts`), nur Ansicht-Aktionen ohne Datei/Zwischenablage/Dialog; Spec: jede Id existiert im Katalog |
| E6 | Stufe 2 = Bestätigungsdialog im Fenster „Vorschlag der KI“ mit allen Angaben; Enter bestätigt **nicht** (nur Klick/`Mod+Enter`). Einstellung „Ohne Rückfrage ausführen“ (Vorgabe aus) gilt für `propose_export`; `propose_open` fragt immer. Ein zweiter Vorschlag, während einer offen ist → `busy`. Zeitgrenze 5 min → `timeout` |
| E7 | Notizen der KI beginnen mit `KI: ` (sichtbar, wandert in den Arbeitsstand und ins Teilen). Lesezeichen ohne Kennung; `remove_bookmark`/`remove_note` nur für Marken, die die KI in dieser App-Sitzung gesetzt hat. Verlauf im Speicher (50). **Abweichung vom Prompt:** kein `author`-Feld im Modell – Lesezeichen sind heute nur Zeilennummern, ein Feld hätte Arbeitsstand, Ruler und Baum geändert |
| E8 | Bis 4 gleichzeitige Verbindungen, 8 offene Sockets; 20 Aufrufe/s (Token-Bucket je Verbindung), 2 Long-Polls |

## Tools (umgesetzt)

Stufe 0: `help`, `get_workspace`, `get_tab`, `get_stats`, `read_lines`, `get_entry`, `search`, `find_level`,
`get_timeline`, `line_at_time`, `report_schema`, `run_sql`, `preview_field_rule`, `list_actions`, `wait_for_lines`.
Stufe 1: `activate_tab`, `reveal_line`, `set_filter`, `open_filter_tab`, `close_tab`, `set_bookmark`,
`remove_bookmark`, `add_note`, `remove_note`, `set_frozen`, `set_follow`, `set_column_mode`, `run_action`.
Stufe 2: `propose_open`, `propose_export`, `propose_field_rule`.

**Verschoben** (Roadmap): `propose_dashboard_panel` (das Dashboard hat keinen Weg „Panel vorbelegen“, nur Vorlagen;
eigener Einstieg wäre ein Umbau von 012) und `propose_save_workspace` (der Arbeitsstand braucht den nativen
Speichern-Dialog; die KI kann den Pfad nicht sicher vorgeben, ohne dass der Dialog umgangen wird).

## Verträge

```
Sidecar ↔ App   Zeilen-JSON über TCP 127.0.0.1: {"token"} → {"ok"}; {"id","tool","args"} → {"id","result"|"error"}
Commands        mcp_set_enabled(enabled) → McpInfo · mcp_info() → McpInfo · subscribe_mcp(onEvent: Channel<McpEvent>)
                mcp_reply(callId, result?, error?) · mcp_disconnect() · mcp_probe() → Probe
McpEvent        {kind:"call", callId, tool, args} | {kind:"status", info: McpInfo}
McpInfo         {enabled, connections, sidecar: string|null, debug, endpoint: string|null}
Fehlercodes     mcp_disabled, stale_view, tab_not_found, limit_exceeded, busy, denied, timeout, invalid_args,
                invalid_filter, report_building (+ vorhandene: invalid_search, too_many_views, invalid_query …);
                im Sidecar not_running
```

**Abweichungen vom Prompt:** Die Fehlercodes der Tools (`stale_view`, `tab_not_found`, …) sind Teil des
Brücken-Vertrags (`code: message` an die KI) und stehen in `guide/errors.md`, nicht in `error.rs`/`app-error.ts`:
kein Command der App liefert sie. Notizen ohne `author`-Feld (E7). Statt „Vor der KI verbergen“ im Kontextmenü des
Tabs (die Tab-Leiste hat keins) ein Schalter im Panel „KI“ der Statusleiste und die Aktion `MCP_TOGGLE_HIDDEN`; der Tab
zeigt dann „⊘“. Die Tools laden als Lazy-Chunk (`mcp-tools.ts`, 24 KB), damit das Startbundle nur um 6 KB wächst.

## Bedrohungsmodell

| Angreifer | Schutz |
|---|---|
| Anderer lokaler Prozess (anderer Nutzer) | Nur `127.0.0.1`, Token aus 0600-Datei, Vergleich zeitkonstant, Hello ≤ 1 KB/5 s, 8 Sockets |
| Prozess desselben Nutzers | Kann die Datei lesen – gleiche Rechte wie der Nutzer selbst; er bekommt dennoch nur Stufe 0/1, Stufe 2 braucht den Klick |
| Webseite im Browser | Kein HTTP, das Hello verlangt das Token in der ersten Zeile → DNS-Rebinding/CSRF laufen ins Leere |
| Bösartige Logzeile/Dateiname (Prompt Injection) | Logtext nur in JSON-Datenfeldern; `instructions` und Beschreibungen sagen „untrusted data“; Wirkung nur Stufe 1 (sichtbar, umkehrbar), alles mit Dateien Stufe 2 |
| Kompromittierter Client | Positivliste (Stufe 3 gibt es nicht), Grenzen, Rate-Grenze; neue Dateien nur mit Bestätigung; Geheimnisse nie erreichbar |
| KI-Anbieter liest Logs | Aus per Default, Hinweis in den Einstellungen, verborgene Tabs, Maskieren bekannter Geheimnisse |
| Fenster hängt | Tools im Frontend sind async und begrenzt; Long-Polls über Channel-Updates, kein Busy-Wait; Rust wartet auf eigenen Threads |

## Sicherheits-Review (separater Agent, 09.11.2026)

Kein hoher Befund; behoben: (1) Maskieren auch für Feldwerte mit Geheimnis-Namen, SQL-Zellen und Regel-Vorschau,
Schlüssel in längeren Namen (`DB_PASSWORD`, `accessToken`), Werte in Anführungszeichen, Cookie/URL-Passwort/PEM;
(2) Verbergen vererbt sich fest auf Filter-Tabs (bleibt nach dem Schließen der Eltern); (3) Brücke kennt jeden Socket ab
`accept` (Ausschalten trennt auch vor dem Hello), prüft `stop` vor jedem Aufruf, das Frontend lehnt bei „aus“ ab;
(4) Export ohne Rückfrage nur auf eine neue Datei; (5) `propose_open` ohne `.`/`..`, Steuer-/Bidi-Zeichen, UNC- und
Gerätepfade; (6) Such-/Level-Schleifen höchstens 20 s, `LONG_TIMEOUT` 165 s; (7) Hello mit Gesamtfrist (Wächter);
(8) Sichtbarkeit wird vor der Antwort erneut geprüft, `run_action` nicht auf einem verborgenen Tab vorn; (9) eigene
Marken werden vergessen, sobald der Nutzer sie entfernt oder die `epoch` wechselt. **Offen (dokumentiert):** `search`
mit Regex kann maskierte Werte zeichenweise erraten; ein Merge mit einer anderswo verborgenen Datei ist nicht
automatisch verborgen; ein abgelaufener Aufruf läuft im Frontend bis zu seiner eigenen Grenze weiter.

## Fortschritt

- [x] Phase 1 (dieses Dokument)
- [x] Phase 2 Rust · [x] Phase 3 Frontend · [x] Phase 4 e2e · [x] Phase 5 Doku · [x] Phase 6 Prüfung (Review siehe oben)
