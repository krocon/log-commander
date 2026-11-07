/** Layout and loading rules of the detail panel (prompt 004), without DOM. */

/** Below this the panel is not worth showing; the log view keeps at least `LOG_MIN`. */
export const PANEL_MIN = 80;
export const LOG_MIN = 120;
/** Height of the splitter bar including its borders. */
export const SPLITTER_SIZE = 8;

/** Largest panel height that leaves the log view its minimum. */
export function panelMax(available: number): number {
  return Math.max(PANEL_MIN, Math.floor(available - LOG_MIN - SPLITTER_SIZE));
}

/**
 * The height the panel gets: the wanted one within the bounds. When the window gets too small the log
 * view wins, the panel shrinks below its minimum and finally to nothing.
 */
export function panelHeight(wanted: number, available: number): number {
  const max = Math.floor(available - LOG_MIN - SPLITTER_SIZE);
  if (max < PANEL_MIN) return Math.max(0, max);
  return Math.round(Math.min(max, Math.max(PANEL_MIN, wanted)));
}

/** What an entry was loaded for, and the file's state at that time. */
export interface EntryKey {
  sessionId: number;
  anchor: number;
  epoch: number;
  viewGeneration: number;
  totalLines: number;
  fileSize: number;
}

/**
 * Whether the panel must ask again. Another line, tab, index or view (a profile change can change the
 * continuation lines) always; besides that only an entry at the end of the file, which may still grow
 * (a stack trace is often written after its head line). Anything else would cost an IPC call per update.
 */
export function needsReload(
  loaded: EntryKey | null,
  loadedLast: number | null,
  now: EntryKey,
): boolean {
  if (!loaded) return true;
  if (
    loaded.sessionId !== now.sessionId ||
    loaded.anchor !== now.anchor ||
    loaded.epoch !== now.epoch ||
    loaded.viewGeneration !== now.viewGeneration
  ) {
    return true;
  }
  if (loadedLast === null) return false;
  const atEnd = loadedLast + 1 >= loaded.totalLines;
  return atEnd && (now.totalLines !== loaded.totalLines || now.fileSize !== loaded.fileSize);
}

/** "Zeile 812–840" for the header, one-based like the gutter. */
export function lineRangeLabel(first: number, last: number): string {
  const from = (first + 1).toLocaleString('de-DE');
  if (first === last) return `Zeile ${from}`;
  return `Zeile ${from}–${(last + 1).toLocaleString('de-DE')}`;
}
