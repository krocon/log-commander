import { describe, expect, it } from 'vitest';
import { ColumnSet } from '../../core/log/log.models';
import {
  draftFromInference,
  formatSummary,
  isNewerColumns,
  parseLayouts,
  partlyRecognised,
} from './format-logic';

const set = (change: Partial<ColumnSet> = {}): ColumnSet => ({
  revision: 1,
  confidence: 0.97,
  profileId: 'log4j',
  inferredLayout: null,
  columns: [{ id: 'message', label: 'Nachricht', kind: 'text' }],
  ...change,
});

const profiles = [{ id: 'log4j', name: 'Log4j / Logback / Spring Boot', patterns: [] }];

describe('format logic', () => {
  it('takes only newer column sets', () => {
    expect(isNewerColumns(null, set())).toBe(true);
    expect(isNewerColumns(set({ revision: 2 }), set({ revision: 1 }))).toBe(false);
    expect(isNewerColumns(set({ revision: 1 }), set({ revision: 2 }))).toBe(true);
  });

  it('names the format and its share', () => {
    expect(formatSummary(set(), profiles)).toBe('Log4j / Logback / Spring Boot · 97 %');
    expect(formatSummary(set({ inferredLayout: '^x$', confidence: 0.854 }), profiles)).toBe(
      'Erkanntes Format · 85 %',
    );
    expect(formatSummary(set({ confidence: 0 }), profiles)).toContain('nicht erkannt');
    expect(formatSummary(null, profiles)).toBeNull();
  });

  it('flags a partly recognised format', () => {
    expect(partlyRecognised(set({ confidence: 0.6 }))).toBe(true);
    expect(partlyRecognised(set({ confidence: 0.8 }))).toBe(false);
    expect(partlyRecognised(set({ confidence: 0 }))).toBe(false);
  });

  it('splits layouts by line', () => {
    expect(parseLayouts(' ^a$ \n\n^b$\n')).toEqual(['^a$', '^b$']);
  });

  it('turns an inference into a profile draft', () => {
    const draft = draftFromInference('^(?P<level>\\w+) (?P<message>.*)$', 'app.log');
    expect(draft.name).toBe('Erkannt: app.log');
    expect(draft.pattern).toBe(draft.layouts);
    expect(draftFromInference('^(?P<message>.*)$', 'a').pattern).toBe('');
  });
});
