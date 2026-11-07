import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { SettingsService } from '../../core/settings/settings.service';
import { SessionMarksComponent } from '../../shared/session-marks';
import { ALL_LEVELS } from '../sessions/filter-logic';
import { LogSessionService } from '../sessions/log-session.service';
import { SessionState } from '../sessions/session-state';
import { sourceColor, sourceStatusText } from '../merge/merge-logic';
import {
  TreeNode,
  buildTree,
  savedFilterOf,
  suggestName,
  treeKey,
  upsertSavedFilter,
} from './tree-model';

/**
 * Files, their active filter and the saved filters (prompt 005). A second view on the state of the
 * tabs: everything writes through `LogSessionService` and the settings. WAI-ARIA tree with a roving
 * tabindex; the small buttons in a row are for the mouse, the keyboard has Enter and Delete.
 */
@Component({
  selector: 'app-log-tree',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SessionMarksComponent],
  template: `
    <div class="tree" role="tree" aria-label="Dateien und Filter">
      @for (node of nodes(); track node.id) {
        <div
          role="treeitem"
          class="node"
          [class]="'node kind-' + node.kind"
          [class.current]="node.current"
          [attr.data-id]="node.id"
          [attr.aria-level]="node.level"
          [attr.aria-setsize]="node.setSize"
          [attr.aria-posinset]="node.posInSet"
          [attr.aria-expanded]="node.expandable ? node.expanded : null"
          [attr.aria-selected]="node.current"
          [attr.tabindex]="node.id === roving() ? 0 : -1"
          [title]="node.title"
          [style.padding-left.px]="4 + (node.level - 1) * 14"
          (click)="onClick(node, $event)"
          (keydown)="onKey($event)"
          (focus)="focusId.set(node.id)"
        >
          <span class="twisty" aria-hidden="true">{{
            node.expandable ? (node.expanded ? '▾' : '▸') : ''
          }}</span>
          @if (editing() === node.id) {
            <input
              #nameInput
              class="name"
              aria-label="Name des Filters, Enter speichert, Escape bricht ab"
              maxlength="80"
              [value]="draftName()"
              (click)="$event.stopPropagation()"
              (keydown)="onNameKey($event, node, nameInput.value)"
              (blur)="cancelSave(node, false)"
            />
          } @else {
            <span class="label">{{ node.label }}</span>
          }
          @if (node.kind === 'file' && sessionOf(node); as session) {
            <app-session-marks [session]="session" [status]="true" />
          }
          @if (node.kind === 'source' && sessionOf(node); as session) {
            <span
              class="src-mark"
              [class]="'src-mark src-' + sourceColorOf(node.sourceIndex ?? 0)"
              aria-hidden="true"
            ></span>
            @if (sourceState(session, node.sourceIndex ?? 0); as state) {
              <span class="src-state">{{ state }}</span>
            }
          }
          @if (node.kind === 'active-filter' && editing() !== node.id) {
            <button
              type="button"
              class="save"
              tabindex="-1"
              title="Filter unter einem Namen speichern (Enter)"
              (click)="startSave(node, $event)"
            >
              Speichern
            </button>
          }
          @if (removable(node)) {
            <button
              type="button"
              class="remove"
              tabindex="-1"
              [attr.aria-label]="node.label + ' entfernen'"
              [title]="removeTitle(node)"
              (click)="remove(node, $event)"
            >
              ×
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      overflow: auto;
      padding: 4px 0;
      font-size: 12px;
    }
    .node {
      display: flex;
      align-items: center;
      gap: 4px;
      height: 24px;
      padding-right: 4px;
      cursor: default;
      white-space: nowrap;
      outline: none;
    }
    .node:hover {
      background: var(--bg-hover);
    }
    .node:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .node.current.kind-file {
      background: var(--row-selected);
    }
    .kind-file .label,
    .kind-saved-group .label {
      font-weight: 600;
    }
    .kind-saved.current .label::after {
      content: ' ✓';
    }
    .kind-filter-levels .label,
    .kind-filter-query .label {
      font-family: var(--font-mono);
      font-size: 11px;
    }
    .twisty {
      flex: none;
      width: 12px;
      text-align: center;
      color: var(--text-dim);
    }
    .label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .kind-source .label {
      order: 1;
    }
    .src-mark {
      flex: none;
      width: 4px;
      height: 12px;
      margin-right: 4px;
      border-radius: 1px;
      background: var(--src);
    }
    .src-state {
      order: 2;
      color: var(--lv-warn-fg);
      font-size: 11px;
    }
    .name {
      flex: 1;
      min-width: 0;
      padding: 1px 5px;
    }
    .save,
    .remove {
      flex: none;
      padding: 0 5px;
      color: var(--text-dim);
      font-size: 11px;
    }
    .save {
      border-color: var(--border);
    }
    .remove {
      font-size: 13px;
    }
  `,
})
export class LogTreeComponent {
  protected readonly sessions = inject(LogSessionService);
  private readonly settingsService = inject(SettingsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  private readonly collapsed = signal<ReadonlySet<string>>(new Set());
  protected readonly focusId = signal<string | null>(null);
  protected readonly editing = signal<string | null>(null);
  protected readonly draftName = signal('');

  /** Recomputed when tabs, filters or saved filters change; the 10 updates a second touch nothing here. */
  protected readonly nodes = computed(() =>
    buildTree(
      this.sessions.sessions().map((s) => ({
        id: s.id,
        fileName: s.fileName,
        path: s.path,
        levels: s.levels(),
        query: s.query(),
        mode: s.searchMode(),
        sources: s.sources,
      })),
      this.sessions.activeId(),
      this.settingsService.settings().savedFilters,
      this.collapsed(),
    ),
  );

  /** The one node in the tab order: the focused one, else the active file. */
  protected readonly roving = computed(() => {
    const nodes = this.nodes();
    const id = this.focusId();
    if (id && nodes.some((n) => n.id === id)) return id;
    return (nodes.find((n) => n.kind === 'file' && n.current) ?? nodes[0])?.id ?? null;
  });

  protected sourceColorOf(index: number): number {
    return sourceColor(index);
  }

  /** The state of a source in a word (only when it is not simply live). */
  protected sourceState(session: SessionState, index: number): string | null {
    const status = session.update().sources?.[index]?.status;
    return status ? sourceStatusText(status) : null;
  }

  protected sessionOf(node: TreeNode): SessionState | null {
    return this.sessions.sessions().find((s) => s.id === node.sessionId) ?? null;
  }

  protected removable(node: TreeNode): boolean {
    return node.kind === 'filter-levels' || node.kind === 'filter-query' || node.kind === 'saved';
  }

  protected removeTitle(node: TreeNode): string {
    if (node.kind === 'saved') return 'Gespeicherten Filter löschen (Entf)';
    return node.kind === 'filter-levels' ? 'Alle Level zeigen (Entf)' : 'Suche entfernen (Entf)';
  }

  protected onClick(node: TreeNode, event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest('button, input')) return;
    this.focusId.set(node.id);
    // The triangle opens and closes, the rest of the row acts.
    if (node.expandable && target.closest('.twisty')) this.setExpanded(node.id, !node.expanded);
    else this.activate(node);
  }

  /** Enter, Space and a click. */
  private activate(node: TreeNode): void {
    switch (node.kind) {
      case 'file':
        if (node.sessionId !== null) this.sessions.activate(node.sessionId);
        break;
      case 'saved': {
        const filter = this.settingsService
          .settings()
          .savedFilters.find((f) => f.id === node.savedId);
        const session = this.sessions.active();
        if (filter && session) void this.sessions.applyPreset(session, filter);
        break;
      }
      case 'active-filter':
      case 'saved-group':
        this.setExpanded(node.id, !node.expanded);
        break;
      default:
        if (node.sessionId !== null) this.sessions.activate(node.sessionId);
    }
  }

  protected remove(node: TreeNode, event?: Event): void {
    event?.stopPropagation();
    const session = this.sessionOf(node);
    if (node.kind === 'filter-levels' && session) {
      void this.sessions.setLevels(session, ALL_LEVELS);
    } else if (node.kind === 'filter-query' && session) {
      void this.sessions.clearSearch(session);
    } else if (node.kind === 'saved') {
      const rest = this.settingsService
        .settings()
        .savedFilters.filter((f) => f.id !== node.savedId);
      this.settingsService.update({ savedFilters: rest });
    } else {
      return;
    }
    // The node goes away: the focus moves to its neighbour above.
    const nodes = this.nodes();
    const index = nodes.findIndex((n) => n.id === node.id);
    const fallback = nodes[index - 1] ?? nodes[index + 1];
    if (fallback && this.host.nativeElement.contains(document.activeElement)) {
      this.moveFocus(node.parentId ?? fallback.id);
    }
  }

  protected startSave(node: TreeNode, event?: Event): void {
    event?.stopPropagation();
    const session = this.sessionOf(node);
    if (!session) return;
    this.draftName.set(suggestName(session.levels(), session.query()));
    this.editing.set(node.id);
    afterNextRender(
      () => {
        const input = this.host.nativeElement.querySelector<HTMLInputElement>('input.name');
        input?.focus();
        input?.select();
      },
      { injector: this.injector },
    );
  }

  protected onNameKey(event: KeyboardEvent, node: TreeNode, name: string): void {
    // The tree's own keys (arrows, Home, End, Delete) belong to the text here.
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      this.save(node, name);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelSave(node, true);
    }
  }

  protected cancelSave(node: TreeNode, refocus: boolean): void {
    if (this.editing() !== node.id) return;
    this.editing.set(null);
    if (refocus) this.moveFocus(node.id);
  }

  private save(node: TreeNode, name: string): void {
    const session = this.sessionOf(node);
    const trimmed = name.trim();
    if (!session || !trimmed) return;
    const entry = savedFilterOf(
      newId(),
      trimmed,
      session.levels(),
      session.query(),
      session.searchMode(),
    );
    this.settingsService.update({
      savedFilters: upsertSavedFilter(this.settingsService.settings().savedFilters, entry),
    });
    this.setExpanded('saved', true);
    this.editing.set(null);
    this.moveFocus(node.id);
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if ((event.target as HTMLElement).closest('input')) return;
    const nodes = this.nodes();
    const current = nodes.find((n) => n.id === this.roving());
    if (!current) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (event.key === 'Enter' && current.kind === 'active-filter') this.startSave(current);
      else this.activate(current);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!this.removable(current)) return;
      event.preventDefault();
      this.remove(current);
      return;
    }
    const move = treeKey(nodes, current.id, event.key);
    if (!move) return;
    event.preventDefault();
    if (move.expand) this.setExpanded(move.expand, true);
    if (move.collapse) this.setExpanded(move.collapse, false);
    if (move.focus) this.moveFocus(move.focus);
  }

  private setExpanded(id: string, expanded: boolean): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      if (expanded) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  private moveFocus(id: string): void {
    this.focusId.set(id);
    afterNextRender(
      () =>
        this.host.nativeElement
          .querySelector<HTMLElement>(`[role=treeitem][data-id="${CSS.escape(id)}"]`)
          ?.focus(),
      { injector: this.injector },
    );
  }
}

function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}
