import { signal } from '@angular/core';
import { LogLine } from '../../core/log/log.models';

export const PAGE_SIZE = 200;
const MAX_PAGES = 64;

export type PageLoader = (start: number, count: number) => Promise<LogLine[]>;

/**
 * Lines the frontend currently holds: fixed pages of the view, least recently used out. Only the
 * last page can still change (it grows, or its provisional line gets replaced).
 */
export class PageCache {
  private readonly pages = new Map<number, LogLine[]>();
  private readonly loading = new Set<number>();
  private token = 0;
  /** Bumped when lines arrive, so renderers re-read. */
  readonly revision = signal(0);

  constructor(private readonly loader: PageLoader) {}

  line(position: number): LogLine | null {
    const page = this.pages.get(Math.floor(position / PAGE_SIZE));
    return page?.[position % PAGE_SIZE] ?? null;
  }

  has(position: number): boolean {
    return this.line(position) !== null;
  }

  /** Where each held page ends. */
  *pageEnds(): Iterable<number> {
    for (const [page, lines] of this.pages) yield page * PAGE_SIZE + lines.length;
  }

  /** Requests all pages touching the range that are missing or out of date. */
  ensure(start: number, end: number): void {
    const first = Math.floor(start / PAGE_SIZE);
    const last = Math.floor(Math.max(start, end - 1) / PAGE_SIZE);
    for (let page = first; page <= last; page++) {
      const cached = this.pages.get(page);
      if (cached) {
        // Most recently used goes to the end of the map's order.
        this.pages.delete(page);
        this.pages.set(page, cached);
      }
      if ((!cached || this.outdated.has(page)) && !this.loading.has(page)) {
        void this.load(page);
      }
    }
  }

  /** Everything is void: other filter, or the index started over. */
  clear(): void {
    this.token++;
    this.pages.clear();
    this.loading.clear();
    this.outdated.clear();
    this.overtaken.clear();
    this.revision.update((r) => r + 1);
  }

  /**
   * The view changed from `oldCount` on: the page that held the old end and later ones must be read
   * again. They stay visible until the new text is there, so following does not flicker.
   */
  invalidateTail(oldCount: number): void {
    const tailPage = Math.floor(Math.max(oldCount - 1, 0) / PAGE_SIZE);
    for (const page of this.pages.keys()) {
      if (page >= tailPage) this.outdated.add(page);
    }
    // A running load of these pages may predate the change: it must not count as fresh.
    for (const page of this.loading) {
      if (page >= tailPage) this.overtaken.add(page);
    }
    this.revision.update((r) => r + 1);
  }

  private readonly outdated = new Set<number>();
  private readonly overtaken = new Set<number>();

  private async load(page: number): Promise<void> {
    const token = this.token;
    this.loading.add(page);
    try {
      const lines = await this.loader(page * PAGE_SIZE, PAGE_SIZE);
      if (token !== this.token) return;
      this.loading.delete(page);
      this.pages.set(page, lines);
      this.outdated.delete(page);
      if (this.overtaken.delete(page)) this.outdated.add(page);
      while (this.pages.size > MAX_PAGES) {
        const oldest = this.pages.keys().next().value as number;
        this.pages.delete(oldest);
        this.outdated.delete(oldest);
      }
      this.revision.update((r) => r + 1);
    } catch {
      // The session may have closed meanwhile; the next ensure() tries again.
      if (token === this.token) this.loading.delete(page);
    }
  }
}
