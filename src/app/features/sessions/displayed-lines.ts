/** What the decision needs to know about the lines at hand. */
export interface LoadedLines {
  has(position: number): boolean;
  /** Where each held page ends, in no particular order. */
  pageEnds(): Iterable<number>;
}

export interface DisplayedLinesInput {
  /** The count the view draws now. */
  displayed: number;
  /** The count the backend reports. */
  target: number;
  follow: boolean;
  /** First line of the view; only matters when not following. */
  top: number;
  /** Rows the view can show at once. */
  rows: number;
  loaded: LoadedLines;
}

/**
 * The line count the view may draw. New lines count only once their text is here, so a live tail
 * stays put for the round trip and then moves in one step, instead of drawing rows without text
 * (which flickers). Going by what has arrived also means it cannot starve: a slow load that a
 * newer update overtook still moves the view forward.
 */
export function nextDisplayedLines(input: DisplayedLinesInput): number {
  const { displayed, target } = input;
  // A shrinking view has nothing to wait for.
  if (target <= displayed) return target;
  return input.follow ? forFollowing(input) : forReading(input);
}

/** Following shows the end: the highest count whose last rows are all here. */
function forFollowing({ displayed, target, rows, loaded }: DisplayedLinesInput): number {
  let best = displayed;
  for (const pageEnd of loaded.pageEnds()) {
    const end = Math.min(pageEnd, target);
    if (end > best && hasAll(loaded, Math.max(0, end - rows), end)) best = end;
  }
  return best;
}

/** Reading stays where it is: only rows that would come into view have to be here. */
function forReading({ displayed, target, top, rows, loaded }: DisplayedLinesInput): number {
  const needed = Math.min(target, top + rows);
  for (let position = displayed; position < needed; position++) {
    if (!loaded.has(position)) return position;
  }
  return target;
}

function hasAll(loaded: LoadedLines, start: number, end: number): boolean {
  for (let position = start; position < end; position++) {
    if (!loaded.has(position)) return false;
  }
  return true;
}
