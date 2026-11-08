# Design 021: Aktionen, Keymaps und Shortcut-Editor

> **Status:** ✅ umgesetzt, 2026-11-08. Die Haltepunkte des Prompts wurden im Auftrag (autonom durch alle Prompts)
> selbst entschieden; Optionen, Entscheidung und Grund stehen unten.
> Kam nach 003–020, daher gehören deren Kürzel mit in den Katalog (50 Aktionen statt der 16 im Prompt).

## Bestand (Inventar vor dem Umbau)

| Stelle | Kürzel | Jetzt |
|---|---|---|
| `app.ts` `onKey` (document) | `Mod+O`, `Mod+Shift+O/E/M/L/H/D/T`, `Mod+W`, `Mod+Tab`/`Mod+Shift+Tab`, `Mod+B`, `Mod+,`, `Mod+Alt+T` | Aktionen (`global`), registriert in `app.ts` |
| `toolbar.ts` `onGlobalKey` (document) + Suchfeld `(keydown)` | `Mod+F`; `Enter`, `Shift+Enter`, `Esc` im Suchfeld | `FOCUS_SEARCH` (`global`), `FIND_NEXT/PREV`, `CLEAR_SEARCH` (`field`) |
| `log-table-view.ts` `onKey` (document) | `Mod+C`, `End`/`F`, `Space`, `P`, `T`, `D`, `Z`, `Home`, `PageUp/Down`, `↑/↓`, `Esc`, `E`/`Shift+E`, `W`/`Shift+W`, `N`/`Shift+N`, `M`/`Shift+M`, `G`, `I`/`Shift+I`, `>`, `<`, `Shift+F10`/`ContextMenu` | Aktionen (`view`), registriert in `log-table-view.ts` |
| `lib.rs` Menü | `CmdOrCtrl+O`, `+Shift+O/M/L/H/E`, `+Alt+T` fest | Menü-Ids = Aktions-Ids, Accelerators aus der Keymap (`set_menu_accelerators`) |
| Lokal (bleibt): `log-tree.ts`, `timeline.ts`, `splitter.ts`, `report-chart.ts`, `column-menu.ts`, `row-menu.ts`, `theme-picker.ts`, Dialoge (`note-dialog`, `dashboard-panel` `Mod+Enter`, `fields-dialog`) | Pfeile, `Enter`, `Space`, `Delete`, `A`, `T`, `N`, `Alt+↑/↓`, `+`/`-`, `Esc` am Element | Element-Handler, keine Aktionen; README-Tabelle „Keys of single widgets“ von Hand |

`rg "'keydown'" src` nach dem Umbau: nur noch `core/actions/action.service.ts` (der eine Capture-Handler). Die übrigen
`(keydown)` hängen an ihren Elementen (Baum, Zeitstrahl, Splitter, Diagramm, Menüs, Dialoge, Editor) und sind lokal.

## Entscheidungen (statt Rückfrage)

| # | Frage | Optionen | Entscheidung | Grund |
|---|---|---|---|---|
| E1 | `Mod+Tab` in `app.ts` vs. README `Ctrl+Tab` | a) `Mod+Tab` überall, b) macOS `Ctrl+Tab`, sonst `Mod+Tab` | b | ⌘Tab erreicht die WebView nie (System). Bisher wirkte `Ctrl+Tab` unter macOS nur, weil `app.ts` Meta und Ctrl gleich behandelte. Unter Windows/Linux ist `Mod+Tab` = `Ctrl+Tab`. |
| E2 | `Ctrl` als ⌘-Ersatz unter macOS (bisher `metaKey || ctrlKey`) | a) beibehalten, b) strenge Notation | b | Die Notation braucht ⌘ und ⌃ getrennt, sonst sind `Ctrl+Tab` und `Mod+Tab` gleich. Abweichung: `Ctrl+O` usw. öffnen unter macOS nichts mehr. Im e2e-Szenario drückten sechs Stellen Meta **und** Ctrl gleichzeitig; dort fällt `ctrlKey` weg (Meta zählt unter Linux/Windows auch als `Mod`). |
| E3 | `?` als zweite Belegung von `OPEN_SHORTCUTS` im Bereich `view`, Lesemodus | a) eine Aktion mit zwei Bereichen, b) zwei Aktionen | b: `OPEN_SHORTCUTS` (`Mod+Shift+K`, `global`, bearbeiten), `SHOW_SHORTCUTS` (`?`, `view`, Übersicht mit „Bearbeiten“) | Der Bereich gehört zur Aktion, und der Modus hängt am Weg. Beide einzeln umbelegbar. |
| E4 | Dialog offen | a) globale Aktionen weiter, b) nichts | b: Fokus in einem `<dialog>` → keine Aktion | Alle Dialoge sind modal (`showModal`); `Mod+W` oder `Mod+F` hinter einem Dialog wäre überraschend. Bisher liefen `app.ts`-Kürzel auch im Dialog – Abweichung, bewusst. |
| E5 | Satzzeichen (`?`, `<`, `>`, `,`) | a) aus `code` wie files-and-folders, b) aus `key` | b, Shift entfällt bei Satzzeichen (`?` = `Shift+?`) | Prompt: „Satzzeichen aus `key`“. `>` ist auf QWERTY Shift+. und auf QWERTZ Shift+<; nur `key` ist auf beiden gleich. Unter ⌥ (macOS) gilt `code`. Folge: `Shift+.` und `.` sind dasselbe Kürzel. |
| E6 | Scrolltasten | Aktionen, wiederholbar | wie Prompt | Kein Widget besitzt sie (Table hat `shortcutActionsDisabled`). |
| E7 | Shift-Varianten (`Shift+T`, `Shift+P`, `Shift+F` …) lösten bisher dasselbe aus (`case 't': case 'T'`) | a) als Zweitbelegung übernehmen, b) weglassen | b | Die Notation unterscheidet Shift; CapsLock geht weiter (`key` `T` ohne Shift → `T`). |
| E8 | `Mod+W` unter macOS | a) reservieren, b) `CLOSE_TAB` behalten | b; das Standard-Menü verliert „Close Window“, neu „File ▸ Close Tab“ mit dem Accelerator aus der Keymap | ⌘W schloss bisher den Tab (README). Ob Menü oder WebView eine Taste zuerst sieht, ist nicht prüfbar ohne Handtest; ohne „Close Window“ kann ⌘W in keinem Fall das Fenster schließen. Fenster: roter Knopf oder ⌘Q. |
| E9 | Doppelt gefeuert (Accelerator + Dispatcher) | a) je OS wissen, wer zuerst fängt, b) entprellen | b: dieselbe Aktion aus `key` und `menu` innerhalb 300 ms läuft einmal | Reihenfolge ist je OS/WebView verschieden und hier nicht prüfbar; so ist beides richtig. |
| E10 | Aufnehmen und Menü-Accelerators | a) Hinweis, b) Accelerators kurz entfernen | beides: `recording` setzt alle Menü-Accelerators auf `null`, Hinweis im Dialog | Prompt-Falle. |
| E11 | „Aufnehmen“ ersetzt oder ergänzt | — | „Aufnehmen“ ersetzt (umbelegen, e2e „P tut nichts mehr“), `+` ergänzt, `×` entfernt einzeln | Beides gebraucht, `End`/`F` haben zwei. |
| E12 | Initial-Bundle (989 KB von 1 MB) | a) Budget erhöhen, b) Editor lazy, c) Engine lazy | b + c: Editor per `@defer`, Katalog/Keymaps/Notation/Dispatcher als Chunk `engine.ts` (dynamischer Import beim Start); im Startbundle nur `ActionService` | Alles eager kostete +20 KB (1,01 MB, Warnung). Mit c: 993,5 KB. Bis der Chunk da ist (ms), tun Tasten nichts. |
| E13 | Englische README-Texte | a) im Katalog, b) im Skript | b: `README_TEXT` in `scripts/keymap-table.mjs`, Test verlangt Text für jede Id | Hält das Bundle klein; die App zeigt die deutschen Namen. |
| E14 | Tooltips mit fest eingetragenen Kürzeln („(⌘/Strg+O)“) | a) lassen, b) aus der Keymap | b: `ActionService.hint(id)` in Toolbar, Tabs, Detail-Panel, Dashboard, Ruler | Sonst zeigen sie nach dem Umbelegen Falsches. |
| E15 | Kaputte Belegung im Store | — | `mergeKeymap` prüft die Form (Version 1, Liste von Strings, ≤ 200 Einträge, ≤ 8 je Aktion, ≤ 64 Zeichen), sonst Vorgaben + Hinweis; Inhalt prüft `resolveKeymap` (Hinweis beim Start mit Anzahl, Liste im Editor) | Start wird nie verhindert. Import gibt es nicht (Prompt: „Nicht in diesem Prompt“). |
| E16 | Ausgeschlossene Bereiche | — | `view`-Aktionen nicht in Textfeldern, Dialogen, Menüs der Tabelle, `.detail`, `[role=separator]`, `[role=tree]`, `.stats`, `.timeline`; `Space`/`Enter` nicht auf Buttons, Checkboxen, Tabs. `TOGGLE_DETAIL` (`D`) wirkt auch in den Panels (wie bisher). Im Dashboard-Modus sind die `view`-Aktionen der Log-Ansicht aus (`enabled`) | Übernimmt die Regeln von `log-table-view.ts`. Konflikt `T` (Spalten) gegen `T` im Baum: kein Konflikt, der Baum ist lokal. `I` beim Tippen: Textfeld. |
| E17 | Reservierte Kürzel | — | macOS: `Mod+Q/H/M`, `Mod+Alt+H`, `Mod+Ctrl+F` (Vollbild im Menü), `Mod+Tab`, `Mod+Shift+Tab`, `Mod+Space`; Windows/Linux: `Alt+F4`, `Alt+Tab`; für `global`/`field` überall `Mod+C/V/X/A/Z`, `Mod+Shift+Z`; für `field` keine druckbaren Tasten | Editor lehnt mit Grund ab. `Mod+C` bleibt für `COPY_SELECTION` (`view`, nie im Textfeld). |
| E18 | Gleiche Taste in zwei Bereichen | — | Kein Konflikt zwischen `view` und `field` (`Esc` hebt im Log die Auswahl auf, im Suchfeld leert es) | Bereiche überschneiden sich nicht. |

## Verträge

- Settings: `keymap: { version: 1, bindings: Record<string, string[]> }`, Vorgabe `{ version: 1, bindings: {} }`.
- Command `set_menu_accelerators(items: { id, shortcut: string | null }[])`: nur Ids aus `MENU_ACTIONS`, höchstens so
  viele Einträge; `Mod` → `CmdOrCtrl`, `Ctrl` nur unter macOS, keine Akkorde, keine schlichten Tasten oder `Alt+Taste`.
- Event `menu-action` (Payload: Aktions-Id) ersetzt `menu-open`, `menu-open-path`, … .
- Menü: File ▸ … Close Tab; View ▸ Colour Scheme…; Help ▸ Keyboard Shortcuts… (englisch wie das übrige Menü).

## Messwerte

| | vorher | nachher |
|---|---|---|
| Initial-Bundle | 989,49 KB | 993,48 KB (Engine-Chunk lazy, Editor lazy) |
| Vitest | 46 Dateien, 397 Tests | 51 Dateien, 443 Tests |
| Script-Tests | 17 | 21 |
| Rust `menu_accel` | – | 7 Tests |
| `npm run e2e` | ~419 Schritte | 440 Schritte, grün (ein Lauf) |

## Nur von Hand prüfbar

- Menü-Accelerators: zeigt das Menü umbelegte Kürzel, feuert eine Taste nicht doppelt (macOS, Windows, Linux).
- macOS ⌘W schließt den Tab (nicht das Fenster), ⌘Q/⌘H unverändert; ⌥-Kombinationen mit echter Tastatur.
- QWERTZ: `?`, `<`, `>`, `Mod+,` mit echter deutscher Tastatur (Specs decken die `key`/`code`-Werte ab).
- WebView2: `F5`, `Mod+R`, `Mod+P`, `F12` (nur gemappte Tasten bekommen `preventDefault`).
- Neustart: e2e prüft nur, dass die Belegung im Store steht.

## Fortschritt

- [x] Phase 1: Inventar, Entscheidungen E1–E18 (dieses Dokument)
- [x] Phase 2: `menu_accel.rs` + Tests, `set_menu_accelerators`, Menü-Ids = Aktions-Ids, Close Tab, Help-Eintrag
- [x] Phase 3: `core/actions/` (Katalog, Keymaps, Notation, resolve, Dispatcher, Service) mit Specs, Handler in
      `app.ts`/`toolbar.ts`/`log-table-view.ts` entfernt, Editor `features/shortcuts/` (lazy), Settings-Merge
- [x] Phase 4: e2e-Schritte (Übersicht `?`, Editor, Konflikt, Esc, P → K, Store, Zurücksetzen, Esc im Suchfeld)
- [x] Phase 5: README (generierte Tabelle + Widget-Tabelle, Screenshot `shortcuts.png`), CLAUDE.md, architecture,
      roadmap, 000-arbeitsweise Phase 3
- [x] Phase 6: `npm run check`, `npm run e2e`
