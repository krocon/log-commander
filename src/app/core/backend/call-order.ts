/**
 * Order of the commands that change something (prompt 023). Tauri runs every command as a task of its own,
 * so two calls sent one after the other may run in either order. These commands mean "the last one wins":
 * each call gets a rising number, and the backend refuses a call that arrives after a newer one of its kind
 * with the code `superseded` (`src-tauri/src/order.rs`). Callers ignore that answer: the newer call did the work.
 */
export const ORDERED_COMMANDS: ReadonlySet<string> = new Set([
  'set_filter',
  'set_profile',
  'set_frozen',
  'set_keep_on_rotate',
  'set_spool_keep',
  'set_custom_profiles',
  'set_extract_rules',
]);

let last = 0;

/**
 * The next number: rising within this page, and above everything a page before a reload has sent (it starts
 * at the clock, in thousandths of a millisecond; the backend keeps its numbers as long as the app runs).
 */
export function nextSeq(now: number = Date.now()): number {
  last = Math.max(last + 1, Math.floor(now) * 1000);
  return last;
}

/** The arguments of a call, numbered if its command is one of the ordered ones. */
export function withSeq(
  command: string,
  args: Record<string, unknown> | undefined,
  now?: number,
): Record<string, unknown> | undefined {
  return ORDERED_COMMANDS.has(command) ? { ...args, seq: nextSeq(now) } : args;
}
