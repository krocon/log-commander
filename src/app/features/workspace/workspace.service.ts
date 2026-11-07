import { Injectable, inject, signal } from '@angular/core';
import { pickFile, pickSaveFile } from '../../core/dialog/native-dialog';
import { AppError, describeError, toAppError } from '../../core/errors/app-error';
import { LogApi } from '../../core/log/log-api';
import { Anchor, LEVELS, MergeSourceSpec } from '../../core/log/log.models';
import { SettingsService } from '../../core/settings/settings.service';
import { baseName } from '../../shared/format';
import { ALL_SOURCES, mergeKey } from '../merge/merge-logic';
import { countConditions, emptyTree } from '../sessions/filter-tree';
import { LogSessionService } from '../sessions/log-session.service';
import { LostMark, SessionState } from '../sessions/session-state';
import { sourceKey, sourceLabel } from '../sources/source-logic';
import { sftpAddress } from '../remote/remote-logic';
import {
  WORKSPACE_EXTENSION,
  WORKSPACE_FORMAT,
  WORKSPACE_VERSION,
  WorkspaceDoc,
  WsFile,
  WsMark,
  WsTab,
  isNetworkFile,
  isRemoteSourceFile,
  locateSource,
  parseWorkspace,
  serializeWorkspace,
  sourceCandidates,
  withRelativePaths,
} from './workspace-model';

/** How long a restore waits for a file to be read before it places marks anyway. */
const LOAD_TIMEOUT_MS = 120_000;
const POLL_MS = 50;

/** A file of the workspace that is not where it was. */
export interface MissingItem {
  file: number;
  source: number;
  path: string;
  /** Picked with „Suchen …“. */
  chosen: string | null;
  skipped: boolean;
}

/** A file of the workspace in the confirmation before anything is touched. */
export interface ConfirmItem {
  file: number;
  label: string;
  paths: string[];
  /** A network path, or a source listening beyond this computer: never opened, probed or started. */
  network: boolean;
  /** Why it is not opened, when `network`. */
  reason: string | null;
  checked: boolean;
}

export interface ConfirmState {
  name: string;
  items: ConfirmItem[];
  /** Formats the workspace brings column layouts for. */
  layouts: string[];
  applyLayouts: boolean;
}

/** What did not come back, shown once the workspace is open. */
export interface RestoreReport {
  skipped: string[];
  lost: { file: string; bookmarks: number; notes: number; lines: number[] }[];
  dropped: number;
  migratedFrom: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Saving and opening a workspace (prompt 015). Saving collects tabs, filters, marks (as anchors) and the layout
 * into a `.lcw`; opening validates it (it may come from someone else), asks for missing files, opens files and
 * filter tabs, and places marks and positions once the files are read.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  private readonly api = inject(LogApi);
  private readonly sessions = inject(LogSessionService);
  private readonly settings = inject(SettingsService);

  /** Which files to open (prompt 015 review): nothing of a workspace is touched before the user agrees. */
  readonly confirm = signal<ConfirmState | null>(null);
  private confirmDone: ((go: boolean) => void) | null = null;
  readonly missing = signal<readonly MissingItem[] | null>(null);
  readonly report = signal<RestoreReport | null>(null);
  readonly busy = signal(false);
  private missingDone: ((go: boolean) => void) | null = null;

  constructor() {
    this.sessions.workspaceOpener = (path) => this.openFrom(path);
  }

  // ---------------------------------------------------------------- saving

  async save(): Promise<void> {
    if (!this.sessions.sessions().length) {
      this.sessions.showError('Keine Datei geöffnet, nichts zu speichern');
      return;
    }
    try {
      const chosen = await pickSaveFile(
        'Arbeitsstand speichern',
        `Arbeitsstand.${WORKSPACE_EXTENSION}`,
        [{ name: 'Arbeitsstand', extensions: [WORKSPACE_EXTENSION] }],
      );
      if (!chosen) return;
      const error = await this.saveTo(chosen);
      if (error) this.sessions.showError(error);
    } catch (e) {
      this.sessions.showError(toAppError(e));
    }
  }

  async saveTo(target: string): Promise<AppError | null> {
    const path = target.toLowerCase().endsWith(`.${WORKSPACE_EXTENSION}`)
      ? target
      : `${target}.${WORKSPACE_EXTENSION}`;
    try {
      const doc = withRelativePaths(await this.capture(), path);
      await this.api.writeWorkspace(path, serializeWorkspace(doc));
      this.settings.addRecentFile(path);
      this.sessions.showNotice(`Arbeitsstand gespeichert: ${baseName(path)}`);
      return null;
    } catch (e) {
      return toAppError(e);
    }
  }

  /** The state of all tabs as a workspace (absolute paths; relative ones are added for the target). */
  async capture(): Promise<WorkspaceDoc> {
    const tabs = this.sessions.sessions();
    const groups = new Map<number, SessionState[]>();
    for (const tab of tabs) groups.set(tab.sessionId, [...(groups.get(tab.sessionId) ?? []), tab]);
    const files: WsFile[] = [];
    let active: WorkspaceDoc['active'] = null;
    const layouts: WorkspaceDoc['columnLayouts'] = {};
    for (const group of groups.values()) {
      // The file's own tab first; if it was closed, its filter tabs hang below an unfiltered one.
      const fileTab = group.find((t) => t.viewId === 0) ?? null;
      const ordered = fileTab ? [fileTab, ...group.filter((t) => t !== fileTab)] : group;
      const first = ordered[0];
      const lines = new Set<number>();
      for (const line of first.bookmarks()) lines.add(line);
      for (const line of first.notes().keys()) lines.add(line);
      const topOf = (t: SessionState) =>
        t.follow() ? null : (t.cache.line(t.scroll().top)?.line ?? null);
      for (const t of ordered) {
        const top = topOf(t);
        if (top !== null) lines.add(top);
        const sel = t.selection();
        if (sel) lines.add(sel.anchor);
      }
      const list = [...lines];
      const anchors = new Map<number, Anchor>();
      if (list.length) {
        const found = await this.api.lineAnchors(first.sessionId, list);
        list.forEach((line, i) => {
          const a = found[i];
          if (a) anchors.set(line, a);
        });
      }
      const anchorOf = (line: number | null | undefined) =>
        line === null || line === undefined ? null : (anchors.get(line) ?? null);
      // Without the file's tab (closed, its filter tabs stay): an unfiltered one goes in front.
      const offset = fileTab ? 0 : 1;
      const wsTabs: WsTab[] = ordered.map((t, i) => {
        const at = t.parent() ? ordered.indexOf(t.parent() as SessionState) : -1;
        const parentIndex = i === 0 && fileTab ? null : at >= 0 && at < i ? at + offset : 0;
        return {
          parent: parentIndex,
          filter: {
            levels: LEVELS.filter((l) => t.levels().has(l)),
            query: { ...t.query() },
            mode: t.searchMode(),
            sourceMask: t.sourceMask(),
            tree: structuredClone(t.filterTree()),
          },
          mode: t.mode(),
          follow: t.follow(),
          top: anchorOf(topOf(t)),
          selection: anchorOf(t.selection()?.anchor),
        };
      });
      if (!fileTab) wsTabs.unshift(emptyTab());
      const marks = (kind: LostMark['kind']) =>
        first
          .lostMarks()
          .filter((m) => m.kind === kind)
          .map((m) => ({ anchor: m.anchor, text: m.text }));
      const bookmarks: WsMark[] = [
        ...[...first.bookmarks()].flatMap((l) => {
          const a = anchors.get(l);
          return a ? [{ anchor: a, text: null }] : [];
        }),
        ...marks('bookmark'),
      ];
      const notes: WsMark[] = [
        ...[...first.notes()].flatMap(([l, text]) => {
          const a = anchors.get(l);
          return a ? [{ anchor: a, text }] : [];
        }),
        ...marks('note'),
      ];
      const profileId = first.update().profileId;
      if (first.source) {
        // Prompt 016: the source is started again; marks belong to this spool only.
        files.push({
          kind: 'source',
          sources: [],
          // Prompt 017: host, user, port, path and start only; never a secret, no local key file.
          source:
            first.source.config.kind === 'sftp'
              ? { ...first.source.config, keyFile: null }
              : { ...first.source.config },
          profileId: profileId === first.suggestedProfileId ? null : profileId,
          tabs: wsTabs.map((t) => ({ ...t, top: null, selection: null })).slice(0, 8),
          bookmarks: [],
          notes: [],
        });
        const activeIndex = ordered.findIndex((t) => t.id === this.sessions.activeId());
        if (activeIndex >= 0) {
          active = { file: files.length - 1, tab: Math.min(7, activeIndex + offset) };
        }
        continue;
      }
      files.push({
        kind: first.isMerge ? 'merge' : 'file',
        sources: first.isMerge
          ? first.sources.map((s) => ({ path: s.path, relPath: null, profileId: s.profileId }))
          : [{ path: first.path, relPath: null, profileId: null }],
        profileId: first.isMerge || profileId === first.suggestedProfileId ? null : profileId,
        tabs: wsTabs.slice(0, 8),
        bookmarks,
        notes,
      });
      const activeIndex = ordered.findIndex((t) => t.id === this.sessions.activeId());
      if (activeIndex >= 0) {
        active = { file: files.length - 1, tab: Math.min(7, activeIndex + offset) };
      }
      const pid = first.columns()?.profileId;
      const layout = pid ? this.settings.settings().columnLayouts[pid] : undefined;
      if (pid && layout) layouts[pid] = structuredClone(layout);
    }
    const s = this.settings.settings();
    return {
      format: WORKSPACE_FORMAT,
      version: WORKSPACE_VERSION,
      savedAt: new Date().toISOString(),
      files,
      active,
      ui: {
        columnMode: s.columnMode,
        detailVisible: s.detailVisible,
        detailHeight: s.detailHeight,
        detailWrap: s.detailWrap,
        sidebarVisible: s.sidebarVisible,
        sidebarWidth: s.sidebarWidth,
        showTimeline: s.showTimeline,
        showOverviewRuler: s.showOverviewRuler,
      },
      columnLayouts: layouts,
    };
  }

  // ---------------------------------------------------------------- opening

  async open(): Promise<void> {
    try {
      const chosen = await pickFile('Arbeitsstand öffnen', [
        { name: 'Arbeitsstand', extensions: [WORKSPACE_EXTENSION] },
      ]);
      if (!chosen) return;
      const error = await this.openFrom(chosen);
      if (error) this.sessions.showError(error);
    } catch (e) {
      this.sessions.showError(toAppError(e));
    }
  }

  async openFrom(path: string): Promise<AppError | null> {
    if (this.busy()) return { code: 'unknown', message: 'Ein Arbeitsstand wird gerade geöffnet' };
    this.busy.set(true);
    try {
      const parsed = parseWorkspace(await this.api.readWorkspace(path));
      if (!parsed.ok) return { code: 'invalid_workspace', message: parsed.error, path };
      const doc = parsed.doc;
      const decision = await this.askConfirm(doc, path);
      if (!decision) return null;
      const located = await this.locate(doc, path, decision.files);
      if (!located) return null;
      this.settings.addRecentFile(path);
      this.settings.update({
        ...doc.ui,
        ...(decision.layouts
          ? { columnLayouts: { ...this.settings.settings().columnLayouts, ...doc.columnLayouts } }
          : {}),
      });
      const report: RestoreReport = {
        skipped: [
          ...doc.files
            .filter(isNetworkFile)
            .map(
              (f) => `${f.sources.map((s) => s.path).join(' + ')} (Netzwerkpfad, nicht geöffnet)`,
            ),
          ...doc.files
            .filter(isRemoteSourceFile)
            .map(
              (f) =>
                `${f.source ? sourceLabel(f.source) : 'Quelle'} (lauscht über diesen Rechner hinaus, nicht gestartet)`,
            ),
        ],
        lost: [],
        dropped: parsed.dropped,
        migratedFrom: parsed.migratedFrom,
      };
      let activeTab: SessionState | null = null;
      for (let i = 0; i < doc.files.length; i++) {
        if (!decision.files.has(i)) continue;
        const paths = located[i];
        const file = doc.files[i];
        const tabs = await this.restoreFile(file, paths, report);
        if (doc.active?.file === i) activeTab = tabs[doc.active.tab] ?? tabs[0] ?? null;
      }
      if (activeTab) this.sessions.activate(activeTab.id);
      if (report.skipped.length || report.lost.length || report.dropped || report.migratedFrom) {
        this.report.set(report);
      } else {
        this.sessions.showNotice(`Arbeitsstand geöffnet: ${baseName(path)}`);
      }
      return null;
    } catch (e) {
      return toAppError(e);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Where each source is now: probes the absolute and the relative path, asks for the missing ones. Null when
   * the user cancelled; per file the paths to open (empty: skipped).
   */
  private async locate(
    doc: WorkspaceDoc,
    wsPath: string,
    chosen: ReadonlySet<number>,
  ): Promise<string[][] | null> {
    const candidates = [
      ...new Set(
        doc.files.flatMap((f, i) =>
          chosen.has(i) ? f.sources.flatMap((s) => sourceCandidates(s, wsPath)) : [],
        ),
      ),
    ];
    const existing = new Set<string>();
    for (let i = 0; i < candidates.length; i += 256) {
      for (const probe of await this.api.probePaths(candidates.slice(i, i + 256))) {
        if (probe.exists) existing.add(probe.path);
      }
    }
    const result = doc.files.map((f, i) =>
      chosen.has(i) ? f.sources.map((s) => locateSource(s, wsPath, (p) => existing.has(p))) : [],
    );
    const missing: MissingItem[] = [];
    result.forEach((paths, file) =>
      paths.forEach((p, source) => {
        if (p === null) {
          missing.push({
            file,
            source,
            path: doc.files[file].sources[source].path,
            chosen: null,
            skipped: false,
          });
        }
      }),
    );
    if (missing.length) {
      this.missing.set(missing);
      const go = await new Promise<boolean>((resolve) => (this.missingDone = resolve));
      const decided = this.missing() ?? [];
      this.missing.set(null);
      if (!go) return null;
      for (const item of decided)
        result[item.file][item.source] = item.skipped ? null : item.chosen;
    }
    return result.map((paths) => paths.filter((p): p is string => p !== null));
  }

  /**
   * The files of the workspace, network paths greyed out, and whether to take over its column layouts. Nothing is
   * probed or opened before this; null when cancelled.
   */
  private async askConfirm(
    doc: WorkspaceDoc,
    wsPath: string,
  ): Promise<{ files: Set<number>; layouts: boolean } | null> {
    const layouts = Object.keys(doc.columnLayouts);
    this.confirm.set({
      name: baseName(wsPath),
      items: doc.files.map((f, file) => {
        if (f.kind === 'source' && f.source?.kind === 'sftp') {
          // Prompt 017: connecting to a server is a side effect: only when ticked here.
          return {
            file,
            label: `${sourceLabel(f.source)} (Remote)`,
            paths: [`verbindet mit ${sftpAddress(f.source)} über SSH/SFTP (erst nach Häkchen)`],
            network: false,
            reason: null,
            checked: false,
          };
        }
        if (f.kind === 'source' && f.source?.kind === 'syslog') {
          // Prompt 016: starting a listener is a side effect; one beyond this computer never from a file.
          const remote = isRemoteSourceFile(f);
          return {
            file,
            label: `${sourceLabel(f.source)} (Quelle)`,
            paths: [`startet Syslog-Empfang auf ${f.source.address}:${f.source.port}`],
            network: remote,
            reason: remote ? 'nicht gestartet (lauscht über diesen Rechner hinaus)' : null,
            checked: !remote,
          };
        }
        const network = isNetworkFile(f);
        return {
          file,
          label: f.sources.map((s) => baseName(s.path)).join(' + '),
          paths: f.sources.map((s) => s.path),
          network,
          reason: network ? 'nicht geöffnet (Netzwerkpfad)' : null,
          checked: !network,
        };
      }),
      layouts,
      applyLayouts: false,
    });
    const go = await new Promise<boolean>((resolve) => (this.confirmDone = resolve));
    const state = this.confirm();
    this.confirm.set(null);
    if (!go || !state) return null;
    return {
      files: new Set(state.items.filter((i) => i.checked && !i.network).map((i) => i.file)),
      layouts: state.applyLayouts,
    };
  }

  toggleConfirmFile(index: number): void {
    this.confirm.update((c) =>
      c
        ? {
            ...c,
            items: c.items.map((item, i) =>
              i === index && !item.network ? { ...item, checked: !item.checked } : item,
            ),
          }
        : c,
    );
  }

  toggleLayouts(): void {
    this.confirm.update((c) => (c ? { ...c, applyLayouts: !c.applyLayouts } : c));
  }

  finishConfirm(go: boolean): void {
    this.confirmDone?.(go);
    this.confirmDone = null;
  }

  /** „Suchen …“ for a missing file. */
  async pickFor(index: number): Promise<void> {
    const item = this.missing()?.[index];
    if (!item) return;
    const chosen = await pickFile(`Ersatz für ${baseName(item.path)}`);
    if (!chosen) return;
    this.missing.update((all) =>
      (all ?? []).map((m, i) => (i === index ? { ...m, chosen, skipped: false } : m)),
    );
  }

  skip(index: number): void {
    this.missing.update((all) =>
      (all ?? []).map((m, i) => (i === index ? { ...m, chosen: null, skipped: true } : m)),
    );
  }

  /** The missing-files dialog is done: go on with what was decided, or cancel the whole restore. */
  finishMissing(go: boolean): void {
    this.missingDone?.(go);
    this.missingDone = null;
  }

  /** A source of the workspace (prompt 016): started again, its filter tabs restored. */
  private async restoreSource(file: WsFile, report: RestoreReport): Promise<SessionState[]> {
    const config = file.source;
    if (!config || isRemoteSourceFile(file)) return [];
    const label = sourceLabel(config);
    const keep = this.settings
      .settings()
      .savedSources.find((s) => sourceKey(s.config) === sourceKey(config))?.keep;
    const error = await this.sessions.openSource(config, keep ?? false);
    if (error) {
      // Prompt 017: what needs the user (a host key to confirm, a password) goes to the dialog, prefilled.
      const interactive = ['host_key_unknown', 'secret_required'].includes(error.code);
      if (config.kind === 'sftp' && interactive && !this.sessions.remoteRequest()) {
        this.sessions.remoteRequest.set({ config, error });
        report.skipped.push(`${label}: im Dialog „Remote-Datei“ bestätigen`);
      } else {
        report.skipped.push(`${label}: ${describeError(error)}`);
      }
      return [];
    }
    const fileTab =
      this.sessions
        .sessions()
        .find(
          (s) =>
            s.viewId === 0 && s.source !== null && sourceKey(s.source.config) === sourceKey(config),
        ) ?? null;
    if (!fileTab) return [];
    return this.restoreTabs(file, fileTab, false);
  }

  private async restoreFile(
    file: WsFile,
    paths: string[],
    report: RestoreReport,
  ): Promise<SessionState[]> {
    if (file.kind === 'source') return this.restoreSource(file, report);
    const label = baseName(file.sources[0].path);
    const merge = file.kind === 'merge';
    if (paths.length === 0 || (merge && paths.length < 2)) {
      report.skipped.push(merge ? file.sources.map((s) => baseName(s.path)).join(' + ') : label);
      return [];
    }
    // A merge with a skipped file: the source masks no longer fit.
    const partial = merge && paths.length !== file.sources.length;
    let fileTab: SessionState | null;
    if (merge) {
      const specs: MergeSourceSpec[] = paths.map((path) => ({
        path,
        profileId: file.sources.find((s) => s.path === path)?.profileId ?? null,
      }));
      const error = await this.sessions.openMerged(specs);
      if (error) {
        report.skipped.push(`${label}: ${describeError(error)}`);
        return [];
      }
      const key = mergeKey(paths);
      fileTab = this.sessions.sessions().find((s) => s.mergeKey === key && s.viewId === 0) ?? null;
    } else {
      const error = await this.sessions.tryOpen(paths[0]);
      if (error) {
        report.skipped.push(`${label}: ${describeError(error)}`);
        return [];
      }
      fileTab =
        this.sessions.sessions().find((s) => s.viewId === 0 && samePath(s.path, paths[0])) ?? null;
    }
    if (!fileTab) return [];
    const created = await this.restoreTabs(file, fileTab, partial);
    await this.placeMarks(file, created, label, report);
    return created;
  }

  /** Profile and tabs of a file, merge or source: filters, filter tabs below, modes. */
  private async restoreTabs(
    file: WsFile,
    fileTab: SessionState,
    partial: boolean,
  ): Promise<SessionState[]> {
    if (file.profileId && fileTab.update().profileId !== file.profileId) {
      await this.sessions.setProfile(fileTab, file.profileId);
    }
    const created: SessionState[] = [];
    for (let i = 0; i < file.tabs.length; i++) {
      const tab = file.tabs[i];
      const sourceMask = partial ? ALL_SOURCES : tab.filter.sourceMask;
      if (i === 0) {
        if (!isDefault(tab, sourceMask)) {
          fileTab.sourceMask.set(sourceMask);
          await this.sessions.applyPreset(fileTab, {
            levels: tab.filter.levels,
            query: tab.filter.query,
            mode: tab.filter.mode,
            tree: tab.filter.tree,
          });
        }
        created.push(fileTab);
      } else {
        const parent = created[tab.parent ?? 0] ?? fileTab;
        const opened = await this.sessions.openFilterTab(parent, {
          levels: new Set(tab.filter.levels),
          sourceMask,
          tree: tab.filter.tree,
          query: tab.filter.query,
          mode: tab.filter.mode,
        });
        if (!opened) break;
        created.push(opened);
      }
      this.sessions.setMode(created[i], tab.mode);
    }
    return created;
  }

  /** Bookmarks, notes, selections and positions once the file is read; what is not found is kept and reported. */
  private async placeMarks(
    file: WsFile,
    tabs: SessionState[],
    label: string,
    report: RestoreReport,
  ): Promise<void> {
    const fileTab = tabs[0];
    await waitUntil(() => fileTab.update().status.kind !== 'loading');
    const total = fileTab.update().totalLines;
    const anchors: Anchor[] = [
      ...file.bookmarks.map((m) => m.anchor),
      ...file.notes.map((m) => m.anchor),
      ...file.tabs.flatMap((t) => [t.top, t.selection].filter((a): a is Anchor => a !== null)),
    ];
    const hashed = anchors.filter((a) => a.hash);
    const lines = new Map<Anchor, number | null>();
    for (let i = 0; i < hashed.length; i += 10_000) {
      const part = hashed.slice(i, i + 10_000);
      const found = await this.api.resolveAnchors(fileTab.sessionId, part);
      part.forEach((a, k) => lines.set(a, found[k] ?? null));
    }
    // An anchor without hash (old workspace) is taken by its number.
    for (const a of anchors) if (!a.hash) lines.set(a, a.line < total ? a.line : null);
    const lost: LostMark[] = [];
    const bookmarks = new Set(fileTab.bookmarks());
    for (const m of file.bookmarks) {
      const line = lines.get(m.anchor);
      if (line === null || line === undefined)
        lost.push({ kind: 'bookmark', anchor: m.anchor, text: null });
      else bookmarks.add(line);
    }
    const notes = new Map(fileTab.notes());
    for (const m of file.notes) {
      const line = lines.get(m.anchor);
      if (line === null || line === undefined)
        lost.push({ kind: 'note', anchor: m.anchor, text: m.text });
      else notes.set(line, m.text ?? '');
    }
    fileTab.bookmarks.set(bookmarks);
    fileTab.notes.set(notes);
    fileTab.lostMarks.set(lost);
    if (lost.length) {
      report.lost.push({
        file: label,
        bookmarks: lost.filter((m) => m.kind === 'bookmark').length,
        notes: lost.filter((m) => m.kind === 'note').length,
        lines: lost.map((m) => m.anchor.line + 1).slice(0, 20),
      });
    }
    for (let i = 0; i < tabs.length; i++) {
      const tab = file.tabs[i];
      const state = tabs[i];
      const selection = tab.selection ? lines.get(tab.selection) : null;
      if (selection !== null && selection !== undefined) {
        await this.sessions.selectEntry(state, selection, false);
      }
      const top = tab.top ? lines.get(tab.top) : null;
      if (tab.follow || top === null || top === undefined) {
        state.setFollow(tab.follow);
        continue;
      }
      // Positions belong to the view: wait for the tab's filter.
      await waitUntil(() => !state.update().filterPending);
      try {
        const position = await this.api.getPosition(state.sessionId, top, state.viewId);
        state.jumpTo(position, top);
      } catch {
        // A view closed meanwhile: nothing to scroll.
      }
    }
  }
}

function emptyTab(): WsTab {
  return {
    parent: null,
    filter: {
      levels: [...LEVELS],
      query: { text: '', isRegex: false, caseSensitive: false },
      mode: 'filter',
      sourceMask: ALL_SOURCES,
      tree: emptyTree(),
    },
    mode: 'log',
    follow: true,
    top: null,
    selection: null,
  };
}

function isDefault(tab: WsTab, sourceMask: number): boolean {
  const f = tab.filter;
  return (
    f.levels.length === LEVELS.length &&
    !f.query.text &&
    countConditions(f.tree) === 0 &&
    (sourceMask & ALL_SOURCES) === ALL_SOURCES
  );
}

function samePath(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase();
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < LOAD_TIMEOUT_MS) await sleep(POLL_MS);
}
