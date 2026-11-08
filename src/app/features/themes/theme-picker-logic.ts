import { toHex } from '../../core/theme/color';
import { completeTokens, resolveColor } from '../../core/theme/theme-logic';
import { Theme } from '../../core/theme/theme.models';

/** A card of the picker: `system` = follow the system, otherwise a scheme id. */
export interface PickerCard {
  readonly id: string;
  readonly name: string;
  readonly dark: boolean;
}

export interface PickerSection {
  readonly key: 'system' | 'dark' | 'light';
  readonly label: string;
  readonly cards: readonly PickerCard[];
}

export const SYSTEM_CARD: PickerCard = { id: 'system', name: 'System folgen', dark: false };

/** Every word of the filter occurs in the name or in „dunkel“/„dark“ resp. „hell“/„light“; case does not matter. */
export function matchesFilter(card: PickerCard, filter: string): boolean {
  const kind =
    card.id === 'system' ? 'system hell dunkel' : card.dark ? 'dunkel dark' : 'hell light';
  const hay = `${card.name} ${kind}`.toLowerCase();
  return filter
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '')
    .every((w) => hay.includes(w));
}

/** „System folgen“ first, then the dark and the light schemes, each filtered; empty sections are left out. */
export function pickerSections(themes: readonly Theme[], filter: string): PickerSection[] {
  const card = (t: Theme): PickerCard => ({ id: t.id, name: t.name, dark: t.dark });
  const keep = (cards: PickerCard[]) => cards.filter((c) => matchesFilter(c, filter));
  return [
    { key: 'system' as const, label: 'System folgen', cards: keep([SYSTEM_CARD]) },
    { key: 'dark' as const, label: 'Dunkel', cards: keep(themes.filter((t) => t.dark).map(card)) },
    { key: 'light' as const, label: 'Hell', cards: keep(themes.filter((t) => !t.dark).map(card)) },
  ].filter((s) => s.cards.length > 0);
}

/** Where a card is drawn (`offsetTop`, `offsetLeft`). */
export interface CardBox {
  readonly top: number;
  readonly left: number;
}

/**
 * The card after a key (arrows, Home, End); `null` = not a moving key, `-1` = up from the first row (back to
 * the filter field). Up and down go to the nearest card of the row above or below, so sections of different
 * length and the single „System folgen“ card line up; without a layout (all boxes at 0) by `columns`.
 */
export function moveInGrid(
  index: number,
  key: string,
  boxes: readonly CardBox[],
  columns: number,
): number | null {
  const count = boxes.length;
  if (count === 0) return null;
  const from = index < 0 ? 0 : index;
  switch (key) {
    case 'ArrowRight':
      return Math.min(count - 1, from + 1);
    case 'ArrowLeft':
      return Math.max(0, from - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'ArrowDown':
    case 'ArrowUp':
      break;
    default:
      return null;
  }
  const down = key === 'ArrowDown';
  if (boxes.every((b) => b.top === 0)) {
    if (down) return Math.min(count - 1, from + columns);
    return from < columns ? -1 : from - columns;
  }
  const here = boxes[from];
  const tops = boxes.map((b) => b.top).filter((t) => (down ? t > here.top : t < here.top));
  if (tops.length === 0) return down ? from : -1;
  const row = down ? Math.min(...tops) : Math.max(...tops);
  let best = -1;
  for (let i = 0; i < count; i++) {
    if (boxes[i].top !== row) continue;
    if (best < 0 || Math.abs(boxes[i].left - here.left) < Math.abs(boxes[best].left - here.left)) {
      best = i;
    }
  }
  return best;
}

/** The colours a thumbnail paints, resolved to `#rrggbb`: nothing else gets into the card's style. */
export const THUMB_TOKENS = [
  '--bg-app',
  '--bg-panel',
  '--bg-gutter',
  '--border',
  '--text',
  '--text-dim',
  '--accent',
  '--row-selected',
  '--hit-bg',
  '--lv-trace-fg',
  '--lv-info-fg',
  '--lv-debug-fg',
  '--lv-warn-fg',
  '--lv-warn-bg',
  '--lv-error-fg',
  '--lv-error-bg',
  '--lv-error-edge',
  '--lv-fatal-fg',
  '--lv-fatal-bg',
  '--tok-time',
  '--tok-number',
] as const;

/** `--thumb-<token>` → `#rrggbb` for the card's style; unresolvable tokens are left out. */
export function thumbStyle(
  theme: Pick<Theme, 'tokens' | 'dark'>,
  light: Theme,
  dark: Theme,
): Record<string, string> {
  const tokens = completeTokens(theme, light, dark);
  const out: Record<string, string> = {};
  for (const name of THUMB_TOKENS) {
    const c = resolveColor(name, tokens);
    if (c) out[`--thumb-${name.slice(2)}`] = toHex(c);
  }
  return out;
}
