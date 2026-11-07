# Prompt 002: Freeze-Button

> Start in neuer Sitzung: „Lies `prompts/000-analyse-flackern-freeze-tabelle.md` und führe `prompts/002-freeze-button.md` aus.“
> Nach Abschluss: Prompt nach `prompts/done/` verschieben. Prompt 001 sollte vorher umgesetzt sein, sonst flackert das
> Aufholen nach dem Fortsetzen.

## Ziel

Ein Button unterbricht die Aufnahme neuer Daten je Tab, damit man in Ruhe lesen kann. Solange eingefroren ist, ändern sich
Zeilen, Zähler und Scrollleiste nicht. Beim Fortsetzen holt die App alles Verpasste nach.

Abgrenzung: Das vorhandene „Pausiert“ stoppt nur das Mitscrollen und bleibt unverändert.

## Entscheidung: Pause im Backend

Der Tail-Worker liest im Freeze nicht weiter. Der Index bleibt stehen, damit bleiben Filter, Suche, Level-Chips, Kopieren
und Zeilennummern ohne weiteren Code konsistent. Die Datei wird später ab der Leseposition weitergelesen, es geht also
nichts verloren (Ausnahmen unten).

Verworfen: Weiterlesen und nur die Anzeige anhalten. Dann müsste jede Abfrage auf einen Zeilenstand begrenzt werden,
weil ein Filterwechsel im Backend über alle gelesenen Zeilen läuft.

## Backend

1. `Shared` bekommt `frozen: AtomicBool`; neuer Befehl `set_frozen(session_id, frozen)` in `commands.rs`, Logik in
   `session.rs`. Danach `shared.wake()`, damit es sofort wirkt.
2. In `Tailer::tick()` (`tail.rs:125`) im Freeze überspringen: Dateiwechsel, Truncation-Prüfung, `drain()` und
   `maybe_commit_partial()`.
3. **`emit_if_due()` muss im Freeze weiterlaufen.** Filter- und Level-Jobs setzen nur `dirty` und wecken den Worker
   (`session.rs:698`, `:742`). Das Update kommt aus `tick()`. Ohne das bliebe ein Filterwechsel im Freeze ewig bei
   „Filter wird berechnet“.
4. `SessionUpdate` (`model.rs:55`) um `frozen: bool` und `pending_bytes: u64` ergänzen. `pending_bytes` = aktuelle
   Dateigröße minus `read_pos`, damit die Anzeige „+12,4 MB warten“ möglich ist. Nur bei Änderung `dirty` setzen.
   DTO in `log.models.ts` und `update()` in `scripts/e2e/mock-ipc.js` mitziehen.
   Bewusst kein neuer `Status`: `frozen` ist unabhängig von Live, Datei fehlt oder Fehler, und `set_status` setzt `Live`
   zurück.

## Randfälle im Backend

Rotation, Truncation und Löschen laufen im Freeze weiter, nur ohne Reaktion:

| Fall | Verhalten | Test |
|---|---|---|
| Eine Rotation | Handle bleibt offen. Beim Fortsetzen liest `switch_file` die alte Datei zu Ende und wechselt. Nichts geht verloren. | ja |
| Mehrere Rotationen | Nur die aktuelle Datei wird gesehen, Zwischenstände fehlen. Bekannte Grenze, in die Doku. | Doku |
| Truncation (`copytruncate`) | Der Text liegt nicht im Speicher, sondern wird aus der Datei gelesen. Eingefrorene Zeilen können daher fehlen oder falsch sein. | ja |
| `keep_on_rotate = false` | Beim Fortsetzen beginnt die Ansicht neu (`epoch`). Erwartet. | ja |
| Datei gelöscht | Handle lebt weiter, Anzeige bleibt. Beim Fortsetzen meldet `tick()` „Datei fehlt“. | ja |

Für Truncation im Freeze zuerst prüfen, was `LineReader::raw` (`indexer.rs:239`) bei einem Offset hinter dem Dateiende
liefert. Keinen Absturz und keine falschen Daten ohne Hinweis zulassen: Im Freeze die Größe weiter vergleichen und bei
`size < read_pos` einen Hinweis zeigen, etwa „Datei wurde geleert, Anzeige ist evtl. unvollständig“. Zurückgesetzt wird erst
beim Fortsetzen.

## Frontend

1. `LogApi.setFrozen`, `LogSessionService.toggleFreeze(session)`, Fehler über `showError`.
2. **Button:** an den Anfang der Toolbar, ⏸/▶ mit Text („Freeze“/„Fortsetzen“), `aria-pressed`, Titel mit Kürzel.
   Deaktiviert ohne Sitzung und während `status.kind === 'loading'`.
3. **Kürzel:** `P`, in `onKey` in `log-view.ts:358` ergänzen (frei, Eingabefelder sind schon ausgenommen).
4. **Statusleiste:** `pill` zeigt bei `frozen` vorrangig „Eingefroren“, daneben `pendingBytes` über `formatBytes`. Fehler
   und „Datei fehlt“ gehen vor. Neue Farbe nur als Token in `src/styles.css`, danach `npm run contrast`.
5. **Tab:** kleine Markierung für eingefrorene Tabs in `tabs.ts`, weil der Freeze je Tab gilt.

## Verhalten beim Fortsetzen

- War Follow an: ans neue Ende, wie bisher.
- War Follow aus (Nutzer steht mitten im Log): Position bleibt, der Badge zeigt „N neue Zeilen“.
- „Ans Ende“ und `End` gehen im Freeze ans Ende des eingefrorenen Stands und heben den Freeze nicht auf.
- Scrollen, Suchen, Filtern, Markieren und Kopieren funktionieren im Freeze.

Prüfen, dass der `follow`-Effekt in `log-view.ts:189` im Freeze nichts bewegt, und dass `pausedAtCount` beim Einfrieren mit
Follow-aus stimmt.

## Tests

- **Rust** (`src-tauri/tests/tail_integration.rs`, Helfer `open`, `append`, `wait`): einfrieren, schreiben, Stand bleibt und
  `pending_bytes` wächst; fortsetzen, alle Zeilen da, in der richtigen Reihenfolge; Filterwechsel im Freeze liefert ein
  Ergebnis ohne neue Zeilen; Rotation, Truncation und `keep_on_rotate = false` aus der Tabelle oben.
- **Vitest:** Pill-Vorrang und Tastenlogik, soweit als reine Funktion prüfbar.
- **e2e** (`scripts/e2e/scenario.js`): Tail läuft, Freeze per Button, Zeilenzahl über mehrere Updates konstant, Fortsetzen
  per `P`, Zeilen sind da.

## Fertig, wenn

- [ ] Alle Tests oben grün, `npm run check` und `npm run e2e` grün
- [ ] Screenshots in `docs/screenshots` nur erneuert, falls die Toolbar sich dort sichtbar ändert (`scripts/screenshots.mjs`)
- [ ] `README.md`, `CLAUDE.md` (Entscheidung und Grenzen) und `docs/roadmap.md` ergänzt
- [ ] Sichttest mit `npm run demo:log` und `npm run demo:app`, oder im Bericht als offen genannt, falls nicht ausführbar

Kein Commit ohne Rückfrage.
