# Prompt 021: Aktionen, Keymaps und Shortcut-Editor

> Start in neuer Sitzung: „Lies `prompts/000-arbeitsweise.md` und führe `prompts/021-shortcut-editor.md` aus.“
> **Möglichst früh umsetzen, vor 004 bis 020.** Diese Prompts bringen zusammen über ein Dutzend neue Kürzel. Mit 021 tragen
> sie nur eine Aktion und eine Default-Belegung ein, statt je einen eigenen `keydown`-Handler zu bauen. Kommt 021 später,
> gehören die Kürzel der bis dahin umgesetzten Prompts mit in den Katalog.
> Vorbild: files-and-folders-tauri (`/Users/marckronberg/WebstormProjects/files-and-folders-tauri`), dort zuerst lesen:
> `src/app/core/actions/` (`shortcut.ts`, `keymap.ts`, `keyboard-dispatcher.ts`, `action-catalog.ts`, `action.service.ts`,
> `keymaps/*.json`, Specs), `src/app/features/actions/shortcut-dialog.ts` und `prompts/done/002-aktionen-tastatur.design.md`
> (D1 bis D6, §3.4 Dispatcher). Gleicher Autor, MIT: Code darf übernommen und angepasst werden.
> Nach Abschluss: Prompt nach `prompts/done/` verschieben.

## Ziel

Jedes Tastenkürzel lässt sich in einem Dialog ansehen, neu belegen, entfernen und zurücksetzen. Dahinter steht ein
Aktionskatalog mit stabilen Ids, eine Default-Keymap je Betriebssystem und **ein** Tastatur-Dispatcher. Die verstreuten
Handler verschwinden, und das native Menü zeigt dieselben Kürzel wie der Rest der App.

## Bestand

| Stelle | Kürzel heute |
|---|---|
| `app.ts:185` `onKey` | `Mod+O` Öffnen, `Mod+Shift+O` Pfad öffnen, `Mod+W` Tab schließen, `Mod+Tab`/`Mod+Shift+Tab` Tab wechseln, `Mod+,` Einstellungen |
| `toolbar.ts:300` `onGlobalKey` | `Mod+F` Suche fokussieren. Im Suchfeld (`toolbar.ts:352`): `Enter`, `Shift+Enter`, `Esc` |
| `log-view.ts:350` `onKey` | `Mod+C` Auswahl kopieren, `End`/`F` ans Ende und folgen, `Space` Folgen umschalten, `P` Freeze, `Home`, `PageUp/Down`, `ArrowUp/Down`, `Esc` Auswahl aufheben |
| `lib.rs:83` Menü | Accelerators `CmdOrCtrl+O`, `CmdOrCtrl+Shift+O`, fest im Rust-Code |

Achtung: `app.ts` prüft `event.key === 'Tab'` mit `Mod`. Das README nennt `Ctrl+Tab`. Unter macOS ist das ein Unterschied
(⌘Tab gehört dem System). Beim Übertragen klären und im Bericht nennen.

## Was übernommen wird und was nicht

| files-and-folders | Hier | Grund |
|---|---|---|
| Notation `[Mod+][Ctrl+][Alt+][Shift+]<Taste>`, Akkorde mit Leerzeichen, `key` mit `code`-Rückfall (`shortcut.ts`) | übernehmen samt Specs | Löst QWERTZ, ⌥-Zeichen unter macOS, Ziffern und Ziffernblock. Ist dort erprobt. |
| Default-Keymaps als JSON je OS im Frontend | übernehmen | Eine Quelle für Dispatcher, Editor, Menü und Hilfe. |
| Override nur mit den Abweichungen, je Aktion ersetzt, `[]` = ohne Kürzel | übernehmen | Neue Defaults späterer Versionen kommen an. |
| Override-Datei über eigene Rust-Commands | **nicht**: im Settings-Store (`keymap`: `{ version: 1, bindings }`) | `tauri-plugin-store` gibt es schon. Prüfung im Frontend. |
| Dispatcher als ein Capture-Handler am `document` | übernehmen | Ersetzt die drei Handler. |
| Befehlspalette, Button-Leiste, Badges, Aktionsmenü | **nicht** in diesem Prompt | Gibt es hier nicht. Die Palette wäre ein guter Folgeschritt, weil der Katalog sie fast fertig mitbringt. |
| Kürzel-Dialog mit Suche, Aufnehmen, Entfernen, Zurücksetzen, Konflikten | übernehmen | Der eigentliche Wunsch. |

## Entscheidungen

| Thema | Entscheidung | Warum |
|---|---|---|
| Ids | `SCREAMING_SNAKE`, stabil, nie umbenennen, z. B. `OPEN_FILE`, `OPEN_PATH`, `CLOSE_TAB`, `NEXT_TAB`, `PREV_TAB`, `OPEN_SETTINGS`, `FOCUS_SEARCH`, `FIND_NEXT`, `FIND_PREV`, `COPY_SELECTION`, `FOLLOW_END`, `TOGGLE_FOLLOW`, `TOGGLE_FREEZE`, `GO_START`, `CLEAR_SELECTION`, `OPEN_SHORTCUTS` | Die Ids stehen in Nutzereinstellungen. |
| Geltungsbereich je Aktion | `global` (überall, auch im Eingabefeld, nur mit `Mod`/`Ctrl`/`Alt` oder F-Taste), `view` (nur wenn kein Eingabefeld, kein Dialog, kein Baum den Fokus hat), `field` (nur im Suchfeld) | Bildet ab, was heute die drei Handler einzeln regeln. `P` darf im Suchfeld kein Freeze auslösen. |
| Scrolltasten | `PageUp/Down`, `ArrowUp/Down`, `Home` und `End` werden Aktionen wie die anderen, aber mit Wiederholung bei gehaltener Taste | Anders als in files-and-folders gibt es keine Tabelle, die sie besitzt. Wer will, legt Scrollen auf `J`/`K`. |
| Reservierte Kürzel | macOS: die des App-Menüs (`Mod+Q`, `Mod+H`, `Mod+M`, `Mod+Alt+H`), ⌘Tab. Überall: `Mod+C`/`Mod+V`/`Mod+X`/`Mod+A` in Eingabefeldern | Der Editor lässt sie nicht zu und sagt warum. `Mod+W` vorher prüfen: Das Standardmenü (`Menu::default`) belegt es unter macOS mit „Fenster schließen“. |
| Konflikt | Beim Aufnehmen sofort anzeigen („belegt durch Freeze“) mit „Ersetzen“ oder „Abbrechen“. Beim Laden gewinnt der Override, die andere Aktion verliert das Kürzel, Hinweis | Kein stilles Überschreiben. |
| Menü | Accelerators der Menüeinträge kommen aus der Keymap. Command `set_menu_accelerators(items)` baut die Einträge neu | Sonst zeigt das Menü `⌘O`, obwohl der Nutzer umbelegt hat. Ein Accelerator fängt die Taste vor der WebView ab, also feuert dieselbe Aktion nicht doppelt. |

## Umsetzung

1. **Kern** `src/app/core/actions/`: `shortcut.ts` (aus files-and-folders, auf das Nötige gekürzt), `platform.ts`,
   `action-catalog.ts` (Id, deutscher Name, Gruppe `Datei`, `Tabs`, `Ansicht`, `Suche`, `Auswahl`, Geltungsbereich,
   wiederholbar ja/nein), `keymaps/{macos,windows,linux}.json` mit den heutigen Kürzeln, `keymap.ts` (`resolveKeymap`:
   Defaults + Override, Meldungen für unbekannte Ids, ungültige, reservierte und doppelte Kürzel).
2. **`ActionService`** (Root): Features registrieren Handler je Id (`register(id, run, enabled?)`), `run(id)`. Aktionen ohne
   Handler sind im Editor sichtbar, aber gedimmt. Fehler gehen über den vorhandenen `showError`.
3. **`KeyboardDispatcher`** (Root, Capture-Phase am `document`):
   ```
   Dialog offen          → nur der Dialog, außer globale Aktionen ohne eigene Bedeutung im Dialog
   Kürzel wird aufgenommen → alles an den Editor
   Fokus im Eingabefeld  → nur Aktionen mit Bereich global oder field
   Fokus in Baum, Panel, Ruler (005, 004, 007) → deren Pfeiltasten bleiben dort
   Akkord offen          → zweite Taste prüfen (1,5 s)
   Treffer               → preventDefault, stopPropagation, ActionService.run
   ```
   Die Handler in `app.ts`, `toolbar.ts` und `log-view.ts` werden entfernt, ihre Logik wird zu registrierten Aktionen.
   `Space` auf einem Button bleibt beim Button (`log-view.ts:371`).
4. **Editor** `features/shortcuts/shortcut-dialog.ts`: Suche über Name, Id und Kürzel, Liste nach Gruppen. Je Aktion: Kürzel als
   Chips (mit `×` entfernen), „Aufnehmen“ (nächste Tastenkombination, `Esc` bricht ab, `Backspace` allein ist ein
   gültiges Kürzel, deshalb Abbruch nur über `Esc` und den Button), „Zurücksetzen“ (nur sichtbar bei Abweichung). Oben
   „Alle zurücksetzen“ mit Bestätigung. Meldungen aus `resolveKeymap` als Liste mit `role="status"`. Darstellung der Kürzel je
   OS (macOS `⌘⇧O`, sonst `Strg+Umschalt+O`), Funktion dafür mit Spec.
5. **Einstieg:** Menü „Hilfe ▸ Tastenkürzel …“ bzw. „Einstellungen ▸ Tastenkürzel …“, Button im Einstellungsdialog, Aktion
   `OPEN_SHORTCUTS` mit Default `Mod+Shift+K` (macOS `⌘⇧K`) und `?` als Bereich `view`. Mit `?` öffnet er im Lesemodus als
   Übersicht, mit Knopf „Bearbeiten“.
6. **Menü:** `set_menu_accelerators` in `commands.rs`. Rust übersetzt nur die Notation in Tauri-Accelerators (`Mod` → `CmdOrCtrl`)
   und lässt Akkorde und schlichte Tasten weg, die ein Menü nicht tragen kann. Beim Start und nach jeder Änderung aufrufen.
7. **Settings:** `keymap` in `settings.models.ts` mit Vorgabe in `mergeSettings`. Eine kaputte Belegung fällt auf die Defaults zurück
   und erzeugt einen Hinweis, verhindert aber nie den Start.
8. **Doku:** Die Tabelle der Kürzel im `README.md` wird aus den Keymaps erzeugt (`scripts/keymap-table.mjs`) und in `npm run check`
   gegen das README geprüft, damit beides nicht auseinanderläuft.

## Fallen

- **macOS mit ⌥:** `event.key` liefert `ø` statt `O`. Der `code`-Rückfall aus `shortcut.ts` löst das. Dort steht der Grund im Kommentar,
  nicht wegkürzen.
- **Deutsche Tastatur:** `Mod+,` und `?` liegen auf anderen Tasten als bei US. Satzzeichen kommen aus `key`, Ziffern aus `code`. Mit
  QWERTZ testen.
- **Doppelt gefeuert:** Ein Menü-Accelerator und der Dispatcher dürfen nicht beide auslösen. Unter macOS fängt das Menü ab, unter
  Windows/Linux die Tauri-Menüleiste unterschiedlich. Je OS prüfen und dokumentieren, was nicht prüfbar war.
- **WebView-Eigenkürzel:** `F5`, `Mod+R`, `Mod+P`, `F12` je nach WebView. Gemappte Tasten bekommen `preventDefault`. Ob das unter
  WebView2 reicht, ist nur unter Windows prüfbar.
- **Aufnehmen und Dispatcher:** Während der Aufnahme darf keine Aktion laufen, auch kein Menü-Accelerator. Für Menü-Kürzel unter macOS
  heißt das: Das Menü sieht die Taste zuerst. Im Editor darauf hinweisen oder die Accelerators während der Aufnahme kurz entfernen.
- **Tail läuft weiter:** Der Editor ist ein Dialog. `Space` und Pfeile dürfen dort nichts in der Log-Ansicht auslösen.
- **e2e:** `scripts/e2e/scenario.js` löst Kürzel per synthetischem `KeyboardEvent` aus. Das geht weiter durch den Dispatcher, Menü-
  Accelerators aber nicht. Nicht als abgedeckt melden.

## Tests

- **Vitest:** `shortcut.ts` (Specs aus files-and-folders übernehmen und ergänzen: QWERTZ, ⌥ unter macOS, Ziffernblock, Akkord), `resolveKeymap`
  (Override ersetzt, `[]`, unbekannte Id, reserviert, Konflikt), Dispatcher je Geltungsbereich und mit offenem Dialog, Wiederholung,
  Anzeige je OS, Settings-Merge. Jede Default-Keymap: keine Doppelbelegung, keine reservierte Taste, jede Id im Katalog.
- **Rust:** Übersetzung der Notation in Accelerators, Akkorde werden ausgelassen.
- **Skript:** README-Tabelle passt zu den Keymaps.
- **e2e:** `P` auf `K` umbelegen, `K` friert ein, `P` tut nichts mehr. Nach Neustart gilt die Belegung. Zurücksetzen stellt `P` wieder her.
  Vorhandene Kürzel-Prüfungen im Szenario bleiben grün.

## Nicht in diesem Prompt

Befehlspalette, Import und Export einer Keymap (passt zu 015), Kürzel für Profile oder gespeicherte Filter, mehrere Keymap-Vorlagen
(„VS Code“, „less“).

## Fertig, wenn

- [ ] Kein `keydown`-Handler außerhalb von Dispatcher, Editor und Eingabefeldern mehr (`rg "'keydown'"` im Bericht)
- [ ] Alle heutigen Kürzel funktionieren wie vorher auf macOS, Windows und Linux, Abweichungen begründet
- [ ] `npm run check` und `npm run e2e` grün
- [ ] Menü zeigt umbelegte Kürzel
- [ ] `README.md`, `CLAUDE.md` (Layout `core/actions/`, Regel „neue Kürzel nur über Katalog und Keymaps“), `docs/architecture.md`
      ergänzt, Screenshot des Editors
- [ ] In `prompts/000-arbeitsweise.md` Phase 3 den Hinweis auf den Katalog als verbindlich markiert

Kein Commit ohne Rückfrage.
