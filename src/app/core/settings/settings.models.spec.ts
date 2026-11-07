import { emptyTree } from '../../features/sessions/filter-tree';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  MAX_RECENT_FILES,
  addRecent,
  mergeSettings,
  MAX_LAYOUT_ENTRIES,
  mergeColumnLayouts,
} from './settings.models';

describe('settings', () => {
  it('falls back to defaults for missing or broken values', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    const broken = mergeSettings({
      theme: 'pink' as never,
      fontSize: 'x' as never,
      recentFiles: 7 as never,
      colorOverrides: null as never,
    });
    expect(broken.theme).toBe('system');
    expect(broken.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect(broken.recentFiles).toEqual([]);
    expect(broken.colorOverrides).toEqual({});
  });

  it('drops the settings of the removed own viewport', () => {
    const merged = mergeSettings({ wrapLines: true, tableView: true } as never);
    expect(merged).toEqual(DEFAULT_SETTINGS);
  });

  it('defaults the column view and keeps valid layouts per profile', () => {
    const fresh = mergeSettings({});
    expect(fresh.columnMode).toBe('columns');
    expect(fresh.columnLayouts).toEqual({});
    expect(mergeSettings({ columnMode: 'grid' as never }).columnMode).toBe('columns');
    expect(mergeSettings({ columnMode: 'raw' }).columnMode).toBe('raw');
    const layout = { order: ['level', 'message'], widths: { level: 60 }, hidden: ['thread'] };
    expect(mergeSettings({ columnLayouts: { log4j: layout } }).columnLayouts).toEqual({
      log4j: layout,
    });
  });

  it('repairs broken column layouts', () => {
    expect(mergeSettings({ columnLayouts: 5 as never }).columnLayouts).toEqual({});
    expect(mergeSettings({ columnLayouts: [] as never }).columnLayouts).toEqual({});
    const merged = mergeSettings({
      columnLayouts: {
        a: null,
        b: { order: 'x', widths: { level: 'wide', thread: 120.4, pid: -3 }, hidden: [1] },
      } as never,
    });
    expect(merged.columnLayouts).toEqual({ b: { order: [], widths: { thread: 120 }, hidden: [] } });
  });

  it('limits the font size', () => {
    expect(mergeSettings({ fontSize: 500 }).fontSize).toBe(24);
    expect(mergeSettings({ fontSize: 1 }).fontSize).toBe(9);
  });

  it('keeps recent files unique, newest first, limited', () => {
    expect(addRecent(['a', 'b'], 'b')).toEqual(['b', 'a']);
    const many = Array.from({ length: 30 }, (_, i) => `f${i}`);
    expect(addRecent(many, 'new')).toHaveLength(MAX_RECENT_FILES);
  });

  it('defaults the detail panel and keeps valid values', () => {
    const fresh = mergeSettings({});
    expect([fresh.detailVisible, fresh.detailHeight, fresh.detailWrap]).toEqual([false, 240, true]);
    const kept = mergeSettings({ detailVisible: true, detailHeight: 311.6, detailWrap: false });
    expect([kept.detailVisible, kept.detailHeight, kept.detailWrap]).toEqual([true, 312, false]);
    const broken = mergeSettings({
      detailVisible: 'yes' as never,
      detailHeight: 'x' as never,
      detailWrap: 1 as never,
    });
    expect([broken.detailVisible, broken.detailHeight, broken.detailWrap]).toEqual([
      false,
      240,
      true,
    ]);
    expect(mergeSettings({ detailHeight: 5 }).detailHeight).toBe(80);
    expect(mergeSettings({ detailHeight: 1e9 }).detailHeight).toBe(4000);
  });

  it('defaults the sidebar and keeps valid values', () => {
    const fresh = mergeSettings({});
    expect([fresh.sidebarVisible, fresh.sidebarWidth, fresh.sidebarTreeShare]).toEqual([
      true,
      240,
      0.55,
    ]);
    expect(fresh.savedFilters).toEqual([]);
    const kept = mergeSettings({
      sidebarVisible: false,
      sidebarWidth: 300.4,
      sidebarTreeShare: 0.3,
    });
    expect([kept.sidebarVisible, kept.sidebarWidth, kept.sidebarTreeShare]).toEqual([
      false,
      300,
      0.3,
    ]);
    const broken = mergeSettings({
      sidebarVisible: 'no' as never,
      sidebarWidth: null as never,
      sidebarTreeShare: 'half' as never,
      savedFilters: {} as never,
    });
    expect([broken.sidebarVisible, broken.sidebarTreeShare, broken.savedFilters]).toEqual([
      true,
      0.55,
      [],
    ]);
    expect(mergeSettings({ sidebarWidth: 10 }).sidebarWidth).toBe(180);
    expect(mergeSettings({ sidebarTreeShare: 2 }).sidebarTreeShare).toBe(0.9);
  });

  it('repairs saved filters from an old or broken file', () => {
    const merged = mergeSettings({
      savedFilters: [
        null,
        { id: 'a', name: '  Fehler ', levels: ['ERROR', 'BOGUS'], query: { text: 'x' }, mode: 'x' },
        { id: 'a', name: 'Doppelt', levels: [], query: null, mode: 'filter' },
        { id: 'b', name: '', levels: [] },
        {
          id: 'c',
          name: 'Ohne Level-Liste',
          query: { text: '(', isRegex: true },
          mode: 'highlight',
        },
      ] as never,
    });
    expect(merged.savedFilters).toEqual([
      {
        id: 'a',
        name: 'Fehler',
        levels: ['ERROR'],
        query: { text: 'x', isRegex: false, caseSensitive: false },
        mode: 'filter',
        version: 2,
        tree: emptyTree(),
      },
      {
        id: 'c',
        name: 'Ohne Level-Liste',
        levels: ['UNKNOWN', 'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'],
        query: { text: '(', isRegex: true, caseSensitive: false },
        mode: 'highlight',
        version: 2,
        tree: emptyTree(),
      },
    ]);
  });

  it('turns saved filters of prompt 005 into version 2 with an empty tree and keeps a saved tree', () => {
    const tree = {
      kind: 'group',
      id: 'root',
      op: 'or',
      negate: false,
      enabled: true,
      children: [
        {
          kind: 'cond',
          id: 'x',
          negate: true,
          enabled: false,
          cond: { type: 'text', text: 'retry', isRegex: false, caseSensitive: false },
        },
        { kind: 'cond', id: 'bad', cond: { type: 'nope' } },
        { kind: 'cond', id: 'x', cond: { type: 'lines', first: 3 } },
      ],
    };
    const [old, current] = mergeSettings({
      savedFilters: [
        { id: 'a', name: 'Alt', levels: ['ERROR'], query: { text: 'x' }, mode: 'filter' },
        { id: 'b', name: 'Neu', levels: ['ERROR'], query: {}, mode: 'filter', version: 2, tree },
      ] as never,
    }).savedFilters;
    expect(old.version).toBe(2);
    expect(old.tree).toEqual(emptyTree());
    // Nothing of prompt 005 is lost.
    expect(old.levels).toEqual(['ERROR']);
    expect(old.query.text).toBe('x');
    expect(current.tree.op).toBe('or');
    expect(current.tree.children.length).toBe(2);
    expect(current.tree.children[0]).toMatchObject({ id: 'x', negate: true, enabled: false });
    // A duplicate id gets a new one.
    expect(current.tree.children[1].id).not.toBe('x');
    expect(current.tree.children[1]).toMatchObject({
      cond: { type: 'lines', first: 3, last: null },
    });
  });

  it('shows the overview ruler unless it was switched off', () => {
    expect(mergeSettings(null).showOverviewRuler).toBe(true);
    expect(mergeSettings({ showOverviewRuler: false }).showOverviewRuler).toBe(false);
    expect(mergeSettings({ showOverviewRuler: 'no' as never }).showOverviewRuler).toBe(true);
  });

  it('keeps valid extraction rules per profile and repairs broken ones', () => {
    expect(mergeSettings(null).extractRules).toEqual({});
    expect(mergeSettings(null).fieldHints).toEqual([]);
    const merged = mergeSettings({
      extractRules: {
        log4j: [
          {
            id: 'a',
            name: ' cpu ',
            column: 'message',
            pattern: 'cpu=(\\d+)',
            kind: 'percent',
            unit: '%',
          },
          {
            id: 'a',
            name: 'twice',
            column: 'message',
            pattern: 'x(\\d)',
            kind: 'number',
            unit: null,
          },
          { id: 'b', name: 'took', pattern: 'took (\\d+)', kind: 'weird', unit: '' },
          { id: 'c', name: '', pattern: 'x' },
          'junk',
        ],
        broken: 'nope',
        empty: [],
      } as never,
      fieldHints: ['log4j', 'log4j', 3] as never,
    });
    expect(merged.extractRules).toEqual({
      log4j: [
        {
          id: 'a',
          name: 'cpu',
          column: 'message',
          pattern: 'cpu=(\\d+)',
          kind: 'percent',
          unit: '%',
        },
        {
          id: 'b',
          name: 'took',
          column: 'message',
          pattern: 'took (\\d+)',
          kind: 'text',
          unit: null,
        },
      ],
    });
    expect(merged.fieldHints).toEqual([]);
    expect(mergeSettings({ fieldHints: ['log4j', 'log4j', 'json'] }).fieldHints).toEqual([
      'log4j',
      'json',
    ]);
  });
});

describe('column layouts from a workspace or a broken store (prompt 015)', () => {
  it('caps lists, ids and profiles', () => {
    const many = Array.from({ length: 1000 }, (_, i) => `c${i}`);
    const widths = Object.fromEntries(many.map((id) => [id, 100]));
    const layouts = mergeColumnLayouts({
      log4j: { order: [...many, 'x'.repeat(500)], hidden: [42, 'ok', ''], widths },
      ['p'.repeat(500)]: { order: ['a'] },
    });
    expect(Object.keys(layouts)).toEqual(['log4j']);
    expect(layouts['log4j'].order).toHaveLength(MAX_LAYOUT_ENTRIES);
    expect(layouts['log4j'].hidden).toEqual(['ok']);
    expect(Object.keys(layouts['log4j'].widths)).toHaveLength(MAX_LAYOUT_ENTRIES);
    const profiles = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`p${i}`, { order: [] }]),
    );
    expect(Object.keys(mergeColumnLayouts(profiles)).length).toBe(256);
  });
});

describe('sources and spool (prompt 016)', () => {
  it('keeps checked sources and bounds the spool limit', () => {
    const config = {
      kind: 'syslog',
      protocol: 'udp',
      address: '127.0.0.1',
      port: 5514,
      allow: [],
      allowRemote: false,
    };
    const merged = mergeSettings({
      savedSources: [{ config, keep: true }, { config: { ...config, port: 'x' } }],
    } as never);
    expect(merged.savedSources).toEqual([{ config, keep: true }]);
    expect(merged.spoolLimitMb).toBe(2048);
    expect(mergeSettings({ spoolLimitMb: 1 }).spoolLimitMb).toBe(64);
    expect(mergeSettings({ spoolLimitMb: 1e9 }).spoolLimitMb).toBe(8192);
    expect(mergeSettings({ spoolLimitMb: 'x' as never }).spoolLimitMb).toBe(2048);
    expect(mergeSettings({ savedSources: 'x' as never }).savedSources).toEqual([]);
  });
});
