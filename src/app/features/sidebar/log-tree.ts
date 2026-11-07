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
  FilterCondNode,
  ROOT_ID,
  addNode,
  findNode,
  groupNode,
  moveNode,
  moveNodeTo,
  newNodeId,
  parentOf,
  removeNode,
  toggleEnabled,
  toggleNegate,
  toggleOp,
} from '../sessions/filter-tree';
import { ConditionDialogComponent, ConditionEdit } from './condition-dialog';
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
  imports: [SessionMarksComponent, ConditionDialogComponent],
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
          [attr.aria-checked]="node.exprId && !node.exprRoot ? node.enabled : null"
          [attr.aria-invalid]="node.error ? true : null"
          [attr.tabindex]="node.id === roving() ? 0 : -1"
          [class.off]="node.enabled === false"
          [class.invalid]="!!node.error"
          [class.drop]="dropTarget() === node.id"
          [title]="node.error ? node.title + ' – Fehler: ' + node.error : node.title"
          [style.padding-left.px]="4 + (node.level - 1) * 14"
          [attr.draggable]="isDraggable(node)"
          (click)="onClick(node, $event)"
          (dblclick)="onDblClick(node)"
          (keydown)="onKey($event)"
          (focus)="focusId.set(node.id)"
          (dragstart)="onDragStart(node, $event)"
          (dragover)="onDragOver(node, $event)"
          (dragleave)="dropTarget.set(null)"
          (drop)="onDrop(node, $event)"
          (dragend)="dropTarget.set(null)"
        >
          <span class="twisty" aria-hidden="true">{{
            node.expandable ? (node.expanded ? '▾' : '▸') : ''
          }}</span>
          @if (node.exprId && !node.exprRoot) {
            <input
              type="checkbox"
              class="onoff"
              tabindex="-1"
              [checked]="node.enabled"
              [attr.aria-label]="node.label + (node.enabled ? ' ausschalten' : ' einschalten')"
              title="An/aus (Leertaste)"
              (click)="$event.stopPropagation()"
              (change)="toggle(node)"
            />
          }
          @if (node.joiner) {
            <span class="joiner">{{ node.joiner }}</span>
          }
          @if (node.negate) {
            <span class="joiner not">NICHT</span>
          }
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
          @if ((node.kind === 'file' || node.kind === 'view') && sessionOf(node); as session) {
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
          @if (node.error) {
            <span class="err-mark" aria-hidden="true">Fehler</span>
          }
          @if (node.kind === 'expr-group') {
            <button
              type="button"
              class="op"
              tabindex="-1"
              [attr.aria-label]="
                'Verknüpfung ' + (node.op === 'and' ? 'UND' : 'ODER') + ', umschalten'
              "
              title="UND/ODER umschalten (Enter)"
              (click)="toggleGroupOp(node, $event)"
            >
              {{ node.op === 'and' ? 'UND' : 'ODER' }}
            </button>
            <button
              type="button"
              class="add"
              tabindex="-1"
              title="Bedingung hinzufügen (A)"
              aria-label="Bedingung hinzufügen"
              (click)="startAdd(node, $event)"
            >
              +
            </button>
            <button
              type="button"
              class="add"
              tabindex="-1"
              title="Gruppe hinzufügen (Shift+A)"
              aria-label="Gruppe hinzufügen"
              (click)="addGroup(node, $event)"
            >
              +( )
            </button>
          }
          @if ((node.kind === 'file' || node.kind === 'view') && node.current) {
            <button
              type="button"
              class="add"
              tabindex="-1"
              title="Bedingung hinzufügen (A)"
              aria-label="Bedingung hinzufügen"
              (click)="startAdd(node, $event)"
            >
              +
            </button>
          }
          @if (
            node.kind === 'active-filter' && editing() !== node.id && sessionOf(node);
            as session
          ) {
            <button
              type="button"
              class="tab-open"
              tabindex="-1"
              [disabled]="!!sessions.filterTabLimit(session)"
              [title]="
                sessions.filterTabLimit(session) ??
                'Als Tab öffnen: das Ergebnis in einem neuen Tab weiter filtern (T)'
              "
              (click)="openTab(node, $event)"
            >
              ⧉ Tab
            </button>
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
    @if (condEdit(); as edit) {
      @if (sessionById(edit.sessionId); as session) {
        <app-condition-dialog
          [session]="session"
          [edit]="edit.edit"
          (closed)="onDialogClosed(edit.returnTo)"
        />
      }
    }
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
    .kind-filter-query .label,
    .kind-expr-cond .label {
      font-family: var(--font-mono);
      font-size: 11px;
    }
    .node.off .label {
      color: var(--text-dim);
      text-decoration: line-through;
    }
    .node.invalid .label {
      color: var(--danger);
    }
    .node.drop {
      box-shadow: inset 0 -2px 0 var(--accent);
    }
    .onoff {
      flex: none;
      margin: 0 2px 0 0;
    }
    .joiner {
      flex: none;
      color: var(--accent);
      font-size: 10px;
      font-weight: 600;
    }
    .joiner.not {
      color: var(--danger);
    }
    .err-mark {
      flex: none;
      color: var(--danger);
      font-size: 10px;
      font-weight: 600;
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
    .tab-open,
    .remove,
    .op,
    .add {
      flex: none;
      padding: 0 5px;
      color: var(--text-dim);
      font-size: 11px;
    }
    .op {
      min-width: 38px;
      color: var(--accent);
      font-weight: 600;
    }
    .save,
    .tab-open {
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
        tree: s.filterTree(),
        treeError: s.treeError(),
        parentId: s.parent()?.id ?? null,
        viewId: s.viewId,
        label: s.viewId === 0 ? undefined : s.tabLabel(),
        title: s.viewId === 0 ? undefined : s.tabTitle(),
        columnLabel: (id: string) => s.columns()?.columns.find((c) => c.id === id)?.label ?? id,
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
    return (
      (nodes.find((n) => (n.kind === 'file' || n.kind === 'view') && n.current) ?? nodes[0])?.id ??
      null
    );
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
    return (
      node.kind === 'filter-levels' ||
      node.kind === 'filter-query' ||
      node.kind === 'saved' ||
      !!node.exprId
    );
  }

  protected removeTitle(node: TreeNode): string {
    if (node.kind === 'saved') return 'Gespeicherten Filter löschen (Entf)';
    if (node.exprId) {
      return node.exprRoot ? 'Alle Bedingungen entfernen (Entf)' : 'Entfernen (Entf)';
    }
    return node.kind === 'filter-levels' ? 'Alle Level zeigen (Entf)' : 'Suche entfernen (Entf)';
  }

  // ---------------------------------------------------------------- filter tree (prompt 010)

  /** The dialog for a condition, and where the focus goes back to. */
  protected readonly condEdit = signal<{
    sessionId: number;
    edit: ConditionEdit;
    returnTo: string | null;
  } | null>(null);
  protected readonly dropTarget = signal<string | null>(null);
  private dragged: { sessionId: number; exprId: string } | null = null;

  protected sessionById(id: number): SessionState | null {
    return this.sessions.sessions().find((s) => s.id === id) ?? null;
  }

  private changeTree(
    node: TreeNode,
    change: (
      tree: ReturnType<SessionState['filterTree']>,
    ) => ReturnType<SessionState['filterTree']>,
  ): void {
    const session = this.sessionOf(node);
    if (session) this.sessions.setTree(session, change(session.filterTree()));
  }

  protected toggle(node: TreeNode): void {
    if (node.exprId) this.changeTree(node, (t) => toggleEnabled(t, node.exprId as string));
  }

  protected toggleGroupOp(node: TreeNode, event?: Event): void {
    event?.stopPropagation();
    if (node.exprId) this.changeTree(node, (t) => toggleOp(t, node.exprId as string));
  }

  /** The group a new node goes into: the group itself, the parent of a condition, else the top. */
  private targetGroup(node: TreeNode, session: SessionState): string {
    if (!node.exprId) return ROOT_ID;
    const tree = session.filterTree();
    const own = findNode(tree, node.exprId);
    if (own?.kind === 'group') return own.id;
    return parentOf(tree, node.exprId)?.id ?? ROOT_ID;
  }

  protected startAdd(node: TreeNode, event?: Event): void {
    event?.stopPropagation();
    const session = this.sessionOf(node);
    if (!session) return;
    this.condEdit.set({
      sessionId: session.id,
      edit: { nodeId: newNodeId(), parentId: this.targetGroup(node, session), original: null },
      returnTo: node.id,
    });
  }

  protected addGroup(node: TreeNode, event?: Event): void {
    event?.stopPropagation();
    const session = this.sessionOf(node);
    if (!session) return;
    const group = groupNode('or');
    // An empty group does nothing yet; the dialog for its first condition opens right away.
    this.sessions.setTree(
      session,
      addNode(session.filterTree(), this.targetGroup(node, session), group),
    );
    this.condEdit.set({
      sessionId: session.id,
      edit: { nodeId: newNodeId(), parentId: group.id, original: null },
      returnTo: `expr:${session.id}:${group.id}`,
    });
  }

  private startEdit(node: TreeNode): void {
    const session = this.sessionOf(node);
    if (!session || !node.exprId) return;
    const found = findNode(session.filterTree(), node.exprId);
    if (found?.kind !== 'cond') return;
    const parent = parentOf(session.filterTree(), found.id);
    this.condEdit.set({
      sessionId: session.id,
      edit: {
        nodeId: found.id,
        parentId: parent?.id ?? ROOT_ID,
        original: found as FilterCondNode,
      },
      returnTo: node.id,
    });
  }

  protected onDialogClosed(returnTo: string | null): void {
    this.condEdit.set(null);
    const nodes = this.nodes();
    const target = nodes.some((n) => n.id === returnTo) ? returnTo : nodes[0]?.id;
    if (target) this.moveFocus(target);
  }

  protected onDblClick(node: TreeNode): void {
    if (node.kind === 'expr-cond') this.startEdit(node);
  }

  protected isDraggable(node: TreeNode): boolean | null {
    return node.exprId && !node.exprRoot ? true : null;
  }

  protected onDragStart(node: TreeNode, event: DragEvent): void {
    if (!node.exprId || node.sessionId === null) return;
    this.dragged = { sessionId: node.sessionId, exprId: node.exprId };
    event.dataTransfer?.setData('text/plain', node.label);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  protected onDragOver(node: TreeNode, event: DragEvent): void {
    if (!this.dragged || !node.exprId || node.sessionId !== this.dragged.sessionId) return;
    event.preventDefault();
    this.dropTarget.set(node.id);
  }

  /** On a group: into it, at the end. On a condition: before it. */
  protected onDrop(node: TreeNode, event: DragEvent): void {
    const dragged = this.dragged;
    this.dragged = null;
    this.dropTarget.set(null);
    if (!dragged || !node.exprId || dragged.exprId === node.exprId) return;
    event.preventDefault();
    const session = this.sessionOf(node);
    if (!session) return;
    const tree = session.filterTree();
    const target = findNode(tree, node.exprId);
    if (!target) return;
    let next: typeof tree;
    if (target.kind === 'group') {
      next = moveNodeTo(tree, dragged.exprId, target.id, target.children.length);
    } else {
      const parent = parentOf(tree, target.id);
      if (!parent) return;
      const index = parent.children.findIndex((c) => c.id === target.id);
      next = moveNodeTo(tree, dragged.exprId, parent.id, index);
    }
    this.sessions.setTree(session, next);
    this.moveFocus(`expr:${session.id}:${dragged.exprId}`);
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
      case 'view':
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
      case 'expr-group':
        // Enter on a group switches AND/OR; the twisty opens and closes it.
        this.toggleGroupOp(node);
        break;
      case 'expr-cond':
        this.startEdit(node);
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
    } else if (node.exprId && session) {
      const exprId = node.exprId;
      this.sessions.setTree(session, removeNode(session.filterTree(), exprId));
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

  /** The result of the node's tab as a new filter tab (prompt 013). */
  protected openTab(node: TreeNode, event?: Event): void {
    event?.stopPropagation();
    const session = this.sessionOf(node);
    if (session) void this.sessions.openFilterTab(session);
  }

  protected startSave(node: TreeNode, event?: Event): void {
    event?.stopPropagation();
    const session = this.sessionOf(node);
    if (!session) return;
    this.draftName.set(suggestName(session.levels(), session.query(), session.filterTree()));
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
      session.filterTree(),
    );
    this.settingsService.update({
      savedFilters: upsertSavedFilter(this.settingsService.settings().savedFilters, entry),
    });
    this.setExpanded('saved', true);
    this.editing.set(null);
    this.moveFocus(node.id);
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey) return;
    if ((event.target as HTMLElement).closest('input.name')) return;
    const nodes = this.nodes();
    const current = nodes.find((n) => n.id === this.roving());
    if (!current) return;
    if (this.onTreeKey(event, current)) {
      event.preventDefault();
      return;
    }
    if (event.altKey) return;
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

  /** Keys of the filter tree: on/off, NOT, add, move. True when the key was used. */
  private onTreeKey(event: KeyboardEvent, node: TreeNode): boolean {
    const session = this.sessionOf(node);
    if (!session) return false;
    const inTree = !!node.exprId && !node.exprRoot;
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      if (!inTree) return false;
      const exprId = node.exprId as string;
      this.sessions.setTree(
        session,
        moveNode(session.filterTree(), exprId, event.key === 'ArrowUp' ? -1 : 1),
      );
      this.moveFocus(node.id);
      return true;
    }
    if (event.altKey) return false;
    const canAdd =
      !!node.exprId ||
      node.kind === 'active-filter' ||
      ((node.kind === 'file' || node.kind === 'view') && node.current);
    if ((event.key === 'a' || event.key === 'A') && canAdd) {
      if (event.shiftKey) this.addGroup(node);
      else this.startAdd(node);
      return true;
    }
    if (
      (event.key === 't' || event.key === 'T') &&
      !event.shiftKey &&
      (node.kind === 'active-filter' || node.kind === 'file' || node.kind === 'view')
    ) {
      this.openTab(node);
      return true;
    }
    if (!inTree) return false;
    if (event.key === ' ') {
      this.toggle(node);
      return true;
    }
    if (event.key === 'n' || event.key === 'N') {
      const exprId = node.exprId as string;
      this.sessions.setTree(session, toggleNegate(session.filterTree(), exprId));
      return true;
    }
    return false;
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
