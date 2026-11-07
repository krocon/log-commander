/** Pure arithmetic of the splitter (`splitter.ts`): no DOM, so it can be tested on its own. */

/** Which side of the splitter the size belongs to: the pane before it (left/top) or after it (right/bottom). */
export type SplitPane = 'before' | 'after';

/** `value` within `[min, max]`; a `max` below `min` gives `min`. Rounded to whole pixels. */
export function clampSize(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return Math.round(min);
  return Math.round(Math.max(min, Math.min(Math.max(min, max), value)));
}

/**
 * Size during a drag: the pointer moved from `startPos` to `pos` (clientX or clientY). A pane after the
 * splitter grows when the pointer moves towards the start (up or left).
 */
export function dragSize(
  startSize: number,
  startPos: number,
  pos: number,
  pane: SplitPane,
  min: number,
  max: number,
): number {
  const delta = pos - startPos;
  return clampSize(startSize + (pane === 'before' ? delta : -delta), min, max);
}

/**
 * Size after a key: arrows move by `step` (10 times with Shift), Home and End go to the bounds. Arrows
 * towards the start (up, left) grow a pane after the splitter. `null` for other keys.
 */
export function keySize(
  size: number,
  key: string,
  shift: boolean,
  orientation: 'horizontal' | 'vertical',
  pane: SplitPane,
  min: number,
  max: number,
  step = 10,
): number | null {
  const amount = shift ? step * 10 : step;
  const [back, forward] =
    orientation === 'horizontal' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
  let delta: number;
  if (key === back) delta = -amount;
  else if (key === forward) delta = amount;
  else if (key === 'Home') return clampSize(min, min, max);
  else if (key === 'End') return clampSize(max, min, max);
  else return null;
  return clampSize(size + (pane === 'before' ? delta : -delta), min, max);
}
