import { describe, expect, it } from 'vitest';
import { describeError } from '../../core/errors/app-error';
import {
  ALL_SOURCES,
  MergeEntry,
  addPaths,
  allVisible,
  gutterText,
  isVisible,
  labelWidth,
  lateLines,
  maskForBackend,
  mergeKey,
  mergeProblem,
  mergeTitle,
  onlySource,
  sourceColor,
  sourceLabels,
  sourceProblems,
  toggleSource,
} from './merge-logic';

function entry(path: string, error: string | null = null): MergeEntry {
  return { path, fileName: path, profileId: 'log4j', firstTime: 0, lastTime: 0, error };
}

describe('merge logic', () => {
  it('recognises the same files in any order', () => {
    expect(mergeKey(['/b.log', '/a.log'])).toBe(mergeKey(['/a.log', '/b.log']));
    expect(mergeKey(['/a.log', '/b.log'])).not.toBe(mergeKey(['/a.log', '/c.log']));
  });

  it('gives eight colours and starts over with the ninth source', () => {
    expect([0, 1, 7, 8, 15].map(sourceColor)).toEqual([1, 2, 8, 1, 8]);
  });

  it('labels: short names, equal ones told apart by their number', () => {
    expect(sourceLabels(['a.log', 'service-backend-2024.log'])).toEqual(['a.log', 'service-bac…']);
    const same = sourceLabels(['application-one.log', 'application-two.log']);
    expect(same[0]).not.toBe(same[1]);
    expect(same).toEqual(['applicati#1', 'applicati#2']);
    expect(labelWidth(['a', 'abc'])).toBe(3);
    expect(gutterText('a', 3, 41)).toBe('a   42');
    expect(gutterText('a', 3, null)).toBe('a  ');
  });

  it('chips: switch a source, never hide the last one, Alt shows only one', () => {
    let mask = ALL_SOURCES;
    mask = toggleSource(mask, 1, 3);
    expect([0, 1, 2].map((i) => isVisible(mask, i))).toEqual([true, false, true]);
    expect(maskForBackend(mask, 3)).toBe(0b101);
    mask = toggleSource(mask, 0, 3);
    mask = toggleSource(mask, 2, 3);
    expect(mask).toBe(0b100);
    // Back to all of them: no filter for the backend.
    expect(toggleSource(toggleSource(mask, 0, 3), 1, 3)).toBe(ALL_SOURCES);
    expect(maskForBackend(ALL_SOURCES, 3)).toBeNull();
    expect(onlySource(ALL_SOURCES, 1, 3)).toBe(0b010);
    expect(onlySource(0b010, 1, 3)).toBe(ALL_SOURCES);
    expect(allVisible(0b111, 3)).toBe(true);
    // A single file has no sources to filter.
    expect(maskForBackend(0b1, 0)).toBeNull();
  });

  it('counts late lines and names sources with a problem', () => {
    const live = { kind: 'live' } as const;
    const updates = [
      { status: live, fileSize: 1, lines: 5, lateLines: 2 },
      { status: { kind: 'file_missing' } as const, fileSize: 1, lines: 5, lateLines: 1 },
    ];
    expect(lateLines(updates)).toBe(3);
    const infos = [
      { index: 0, path: '/a', fileName: 'a.log', profileId: 'x', encoding: 'utf8' },
      { index: 1, path: '/b', fileName: 'b.log', profileId: 'x', encoding: 'utf8' },
    ];
    expect(sourceProblems(infos, updates)).toEqual(['b.log fehlt']);
  });

  it('dialog: two to sixteen files, no duplicates, no file with an error', () => {
    expect(mergeProblem([entry('/a')])).toContain('zwei');
    expect(mergeProblem([entry('/a'), entry('/b')])).toBeNull();
    expect(mergeProblem([entry('/a'), entry('/b', 'kaputt')])).toContain('Fehler');
    const many = Array.from({ length: 17 }, (_, i) => entry(`/${i}`));
    expect(mergeProblem(many)).toContain('16');
    const { entries, duplicates } = addPaths([entry('/a')], ['/b', '/a', '/b']);
    expect(entries.map((e) => e.path)).toEqual(['/a', '/b']);
    expect(duplicates).toEqual(['/a', '/b']);
    expect(entries[1].fileName).toBe('b');
  });

  it('error texts of a merge', () => {
    expect(describeError({ code: 'no_timestamps', message: 'x', path: '/plain.txt' })).toBe(
      'Keine Zeitstempel in den ersten 200 Zeilen, Zusammenführen nicht möglich: /plain.txt',
    );
    expect(describeError({ code: 'invalid_merge', message: 'twice' })).toContain('twice');
  });

  it('tab title', () => {
    expect(mergeTitle(3)).toBe('Merge (3 Dateien)');
  });
});
