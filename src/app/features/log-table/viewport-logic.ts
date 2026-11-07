import { ScrollPos } from '../sessions/session-state';

/**
 * The scroll model: the position is a line plus a pixel offset, not a pixel value, so a view of
 * many millions of lines (or wrapped lines of varying height) does not hit the browser's limit of
 * about 33 million pixels for one element. The native scrollbar only represents a fraction.
 */
export const MAX_SCROLL_RANGE = 8_000_000;

export interface ViewMetrics {
  count: number;
  viewportH: number;
  rowH: number;
  /** Measured height with wrapped lines; otherwise all rows are `rowH`. */
  heightOf?: (position: number) => number;
}

const heightAt = (m: ViewMetrics, position: number) => m.heightOf?.(position) ?? m.rowH;

/** The position that puts the last line at the bottom edge. */
export function bottomAnchor(m: ViewMetrics): ScrollPos {
  let sum = 0;
  let position = m.count;
  while (position > 0 && sum < m.viewportH) {
    position--;
    sum += heightAt(m, position);
  }
  return { top: position, subPx: Math.max(0, sum - m.viewportH) };
}

export function isAtOrBelow(pos: ScrollPos, other: ScrollPos): boolean {
  return pos.top > other.top || (pos.top === other.top && pos.subPx >= other.subPx);
}

export interface ScrollResult {
  pos: ScrollPos;
  atBottom: boolean;
}

export function scrollBy(pos: ScrollPos, dy: number, m: ViewMetrics): ScrollResult {
  let top = pos.top;
  let sub = pos.subPx + dy;
  while (sub < 0 && top > 0) {
    top--;
    sub += heightAt(m, top);
  }
  if (sub < 0) sub = 0;
  while (top < m.count && sub >= heightAt(m, top)) {
    sub -= heightAt(m, top);
    top++;
  }
  return clampToBottom({ top, subPx: sub }, m);
}

export function clampToBottom(pos: ScrollPos, m: ViewMetrics): ScrollResult {
  const anchor = bottomAnchor(m);
  if (isAtOrBelow(pos, anchor)) return { pos: anchor, atBottom: true };
  return { pos, atBottom: false };
}

/** Lines to render so the viewport is always covered. */
export function visibleRowCount(viewportH: number, rowH: number): number {
  return Math.ceil(viewportH / rowH) + 2;
}

/** The last possible first line, as far as the scrollbar is concerned. */
export function maxTop(count: number, viewportH: number, rowH: number): number {
  return Math.max(0, count - Math.floor(viewportH / rowH));
}

export function scrollRange(count: number, viewportH: number, rowH: number): number {
  return Math.min(maxTop(count, viewportH, rowH) * rowH, MAX_SCROLL_RANGE);
}

export function topToScrollTop(
  top: number,
  count: number,
  viewportH: number,
  rowH: number,
): number {
  const last = maxTop(count, viewportH, rowH);
  return last === 0 ? 0 : (Math.min(top, last) / last) * scrollRange(count, viewportH, rowH);
}

export function scrollTopToTop(
  scrollTop: number,
  count: number,
  viewportH: number,
  rowH: number,
): number {
  const range = scrollRange(count, viewportH, rowH);
  if (range <= 0) return 0;
  return Math.round((Math.min(scrollTop, range) / range) * maxTop(count, viewportH, rowH));
}

/**
 * The position that brings a row hidden below the viewport (e.g. by a panel that opened) back to the
 * bottom edge, or null if it is visible or above. Fixed row height.
 */
export function revealBelow(pos: ScrollPos, row: number, m: ViewMetrics): ScrollPos | null {
  const top = pos.top * m.rowH + pos.subPx;
  const rowBottom = (row + 1) * m.rowH;
  if (row < pos.top || rowBottom <= top + m.viewportH) return null;
  const wanted = Math.max(0, rowBottom - m.viewportH);
  const line = Math.floor(wanted / m.rowH);
  return { top: line, subPx: wanted - line * m.rowH };
}
