import { describe, expect, it } from 'vitest';
import { LEVELS } from '../../core/log/log.models';
import { addNode, condNode, emptyTree, ROOT_ID } from '../sessions/filter-tree';
import {
  MAX_WS_MARKS,
  WORKSPACE_FORMAT,
  WORKSPACE_VERSION,
  WorkspaceDoc,
  isNetworkFile,
  isRemoteSourceFile,
  isWorkspacePath,
  locateSource,
  parseWorkspace,
  serializeWorkspace,
  sourceCandidates,
  withRelativePaths,
} from './workspace-model';

const anchor = (line: number) => ({
  line,
  source: 0,
  offset: line * 40,
  len: 39,
  hash: '0123456789abcdef',
});

function sample(): WorkspaceDoc {
  const tree = addNode(
    emptyTree(),
    ROOT_ID,
    condNode({ type: 'text', text: 'Timeout', isRegex: false, caseSensitive: false }),
  );
  return {
    format: WORKSPACE_FORMAT,
    version: WORKSPACE_VERSION,
    savedAt: '2026-11-07T10:00:00.000Z',
    files: [
      {
        kind: 'file',
        sources: [{ path: '/var/log/app.log', relPath: null, profileId: null }],
        profileId: 'log4j',
        tabs: [
          {
            parent: null,
            filter: {
              levels: ['WARN', 'ERROR', 'FATAL'],
              query: { text: 'order', isRegex: false, caseSensitive: true },
              mode: 'highlight',
              sourceMask: 0xffff,
              tree,
            },
            mode: 'log',
            follow: false,
            top: anchor(100),
            selection: anchor(120),
          },
          {
            parent: 0,
            filter: {
              levels: [...LEVELS],
              query: { text: '', isRegex: false, caseSensitive: false },
              mode: 'filter',
              sourceMask: 0xffff,
              tree: emptyTree(),
            },
            mode: 'dashboard',
            follow: true,
            top: null,
            selection: null,
          },
        ],
        bookmarks: [{ anchor: anchor(7), text: null }],
        notes: [{ anchor: anchor(120), text: 'Hier fängt es an: `x` {code}' }],
      },
      {
        kind: 'merge',
        sources: [
          { path: '/var/log/a.log', relPath: null, profileId: 'log4j' },
          { path: '/var/log/b.log', relPath: null, profileId: null },
        ],
        profileId: null,
        tabs: [
          {
            parent: null,
            filter: {
              levels: [...LEVELS],
              query: { text: '', isRegex: false, caseSensitive: false },
              mode: 'filter',
              sourceMask: 1,
              tree: emptyTree(),
            },
            mode: 'log',
            follow: true,
            top: null,
            selection: null,
          },
        ],
        bookmarks: [],
        notes: [],
      },
    ],
    active: { file: 0, tab: 1 },
    ui: {
      columnMode: 'raw',
      detailVisible: true,
      detailHeight: 300,
      detailWrap: false,
      sidebarVisible: false,
      sidebarWidth: 300,
      showTimeline: false,
      showOverviewRuler: true,
    },
    columnLayouts: {
      log4j: { order: ['level', 'message'], widths: { level: 70 }, hidden: ['pid'] },
    },
  };
}

function parsed(text: string): WorkspaceDoc {
  const result = parseWorkspace(text);
  if (!result.ok) throw new Error(result.error);
  return result.doc;
}

describe('workspace model', () => {
  it('goes there and back unchanged', () => {
    const doc = withRelativePaths(sample(), '/var/cases/ws.lcw');
    const result = parseWorkspace(serializeWorkspace(doc));
    expect(result.ok && result.dropped).toBe(0);
    expect(result.ok && result.migratedFrom).toBeNull();
    expect(parsed(serializeWorkspace(doc))).toEqual(doc);
    expect(doc.files[0].sources[0].relPath).toBe('../log/app.log');
  });

  it('migrates the draft version 1', () => {
    const v1 = {
      format: WORKSPACE_FORMAT,
      version: 1,
      files: [
        { path: '/var/log/app.log', levels: ['ERROR'], search: 'x', bookmarks: [3, 9] },
        { path: 'relative.log' },
      ],
      active: 0,
    };
    const result = parseWorkspace(JSON.stringify(v1));
    if (!result.ok) throw new Error(result.error);
    expect(result.migratedFrom).toBe(1);
    expect(result.dropped).toBe(1);
    const [file] = result.doc.files;
    expect(file.sources).toEqual([{ path: '/var/log/app.log', relPath: null, profileId: null }]);
    expect(file.tabs[0].filter.levels).toEqual(['ERROR']);
    expect(file.tabs[0].filter.query.text).toBe('x');
    expect(file.bookmarks.map((b) => b.anchor)).toEqual([
      { line: 3, source: 0, offset: 0, len: 0, hash: '' },
      { line: 9, source: 0, offset: 0, len: 0, hash: '' },
    ]);
    expect(result.doc.active).toEqual({ file: 0, tab: 0 });
  });

  it('refuses what is no workspace or too new', () => {
    expect(parseWorkspace('{').ok).toBe(false);
    expect(parseWorkspace('[]').ok).toBe(false);
    expect(parseWorkspace(JSON.stringify({ format: 'other', version: 2 })).ok).toBe(false);
    expect(parseWorkspace(JSON.stringify({ format: WORKSPACE_FORMAT })).ok).toBe(false);
    const newer = parseWorkspace(JSON.stringify({ format: WORKSPACE_FORMAT, version: 3 }));
    expect(newer.ok).toBe(false);
    expect(!newer.ok && newer.error).toContain('neueren Version');
  });

  it('drops hostile or broken parts and keeps the rest', () => {
    const doc = JSON.parse(serializeWorkspace(sample()));
    doc.files[0].sources[0].path = '/var/log/../log/./app.log';
    doc.files[0].bookmarks.push(
      { anchor: { ...anchor(1), hash: 'not hex' } },
      { anchor: { ...anchor(1), line: -1 } },
      { anchor: { ...anchor(1), offset: 1e300 } },
      'nonsense',
    );
    doc.files[0].notes.push({ anchor: anchor(2), text: 'x'.repeat(5000) });
    doc.files[0].notes.push({ anchor: anchor(2), text: '   ' });
    doc.files[0].tabs[1].parent = 5;
    doc.files[0].profileId = '../../etc';
    doc.files.push(
      { kind: 'file', sources: [{ path: 'relative/app.log' }] },
      { kind: 'file', sources: [{ path: '/a\u0000b' }] },
      { kind: 'merge', sources: [{ path: '/only/one.log' }] },
      { kind: 'file', sources: [{ path: '/x.log' }, { path: '/y.log' }] },
    );
    doc.ui = { columnMode: 'evil', detailHeight: 1e9, sidebarVisible: 'yes' };
    doc.active = { file: 99, tab: 0 };
    const result = parseWorkspace(JSON.stringify(doc));
    if (!result.ok) throw new Error(result.error);
    const [file] = result.doc.files;
    expect(result.doc.files).toHaveLength(2);
    expect(file.sources[0].path).toBe('/var/log/app.log');
    expect(file.bookmarks).toHaveLength(1);
    expect(file.notes).toHaveLength(1);
    expect(file.tabs[1].parent).toBe(0);
    expect(file.profileId).toBeNull();
    expect(result.doc.ui.columnMode).toBe('columns');
    expect(result.doc.ui.detailHeight).toBe(240);
    expect(result.doc.ui.sidebarVisible).toBe(true);
    expect(result.doc.active).toBeNull();
    expect(result.dropped).toBe(10);
  });

  it('caps lists that are too long', () => {
    const doc = JSON.parse(serializeWorkspace(sample()));
    doc.files[0].bookmarks = Array.from({ length: MAX_WS_MARKS + 5 }, (_, i) => ({
      anchor: anchor(i),
    }));
    doc.files[0].tabs = Array.from({ length: 20 }, () => doc.files[0].tabs[1]);
    const result = parseWorkspace(JSON.stringify(doc));
    if (!result.ok) throw new Error(result.error);
    expect(result.doc.files[0].bookmarks).toHaveLength(MAX_WS_MARKS);
    expect(result.doc.files[0].tabs).toHaveLength(8);
    expect(result.doc.files[0].tabs[0].parent).toBeNull();
  });

  it('finds files next to a moved workspace', () => {
    const doc = withRelativePaths(sample(), '/home/me/case/ws.lcw');
    const source = doc.files[0].sources[0];
    expect(source.relPath).toBe('../../../var/log/app.log');
    const moved = { ...source, path: '/old/machine/app.log', relPath: 'logs/app.log' };
    const there = new Set(['/new/place/logs/app.log']);
    expect(locateSource(moved, '/new/place/ws.lcw', (p) => there.has(p))).toBe(
      '/new/place/logs/app.log',
    );
    expect(locateSource(moved, '/elsewhere/ws.lcw', (p) => there.has(p))).toBeNull();
    expect(sourceCandidates(moved, '/new/place/ws.lcw')).toEqual([
      '/old/machine/app.log',
      '/new/place/logs/app.log',
    ]);
    const remote = { path: '//attacker/share/a.log', relPath: '../x/a.log', profileId: null };
    expect(sourceCandidates(remote, '/ws/case.lcw')).toEqual(['/x/a.log']);
    const unc = { path: '/local/a.log', relPath: null, profileId: null };
    expect(sourceCandidates(unc, '\\\\host\\share\\case.lcw')).toEqual(['/local/a.log']);
    expect(
      isNetworkFile({ ...sample().files[1], sources: [remote, sample().files[1].sources[0]] }),
    ).toBe(true);
    expect(isNetworkFile(sample().files[0])).toBe(false);
    const parsedRemote = JSON.parse(serializeWorkspace(sample()));
    parsedRemote.files[0].sources[0].path = '//attacker/share/a.log';
    const remoteDoc = parsed(JSON.stringify(parsedRemote));
    expect(remoteDoc.files[0].sources[0].path).toBe('//attacker/share/a.log');
    expect(isNetworkFile(remoteDoc.files[0])).toBe(true);
    expect(isWorkspacePath('/x/Fall 4711.LCW')).toBe(true);
    expect(isWorkspacePath('/x/app.log')).toBe(false);
  });
});

describe('sources in a workspace (prompt 016)', () => {
  const syslog = {
    kind: 'syslog',
    protocol: 'tcp',
    address: '127.0.0.1',
    port: 5514,
    allow: ['10.0.0.0/8'],
    allowRemote: false,
  };
  const withSource = (source: unknown) =>
    JSON.stringify({
      format: WORKSPACE_FORMAT,
      version: WORKSPACE_VERSION,
      files: [{ kind: 'source', sources: [], source, tabs: [{}], bookmarks: [{}], notes: [] }],
    });

  it('keeps a checked source with its tabs, without marks', () => {
    const parsed = parseWorkspace(withSource(syslog));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const file = parsed.doc.files[0];
    expect(file.kind).toBe('source');
    expect(file.source).toEqual(syslog);
    expect(file.tabs).toHaveLength(1);
    expect(file.bookmarks).toEqual([]);
    expect(isRemoteSourceFile(file)).toBe(false);
    expect(isNetworkFile(file)).toBe(false);
    // Round trip.
    const again = parseWorkspace(serializeWorkspace(parsed.doc));
    expect(again.ok && again.doc.files[0].source).toEqual(syslog);
  });

  it('drops broken sources and marks remote ones', () => {
    const broken = parseWorkspace(withSource({ ...syslog, address: 'evil.example' }));
    expect(broken.ok && broken.doc.files).toEqual([]);
    expect(broken.ok && broken.dropped).toBe(1);
    expect(parseWorkspace(withSource({ ...syslog, port: 0 })).ok).toBe(true);
    const remote = parseWorkspace(withSource({ ...syslog, address: '0.0.0.0', allowRemote: true }));
    expect(remote.ok && isRemoteSourceFile(remote.doc.files[0])).toBe(true);
    // Remote without the explicit choice is not a valid configuration at all.
    const silent = parseWorkspace(withSource({ ...syslog, address: '0.0.0.0' }));
    expect(silent.ok && silent.doc.files).toEqual([]);
  });
});
