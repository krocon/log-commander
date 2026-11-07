import { describe, expect, it } from 'vitest';
import { statusPill } from './status-pill';

describe('statusPill', () => {
  it('tells live from a paused follow', () => {
    expect(statusPill({ kind: 'live' }, false, true).label).toBe('Live');
    expect(statusPill({ kind: 'live' }, false, false).label).toBe('Pausiert');
  });

  it('says frozen whatever follow does', () => {
    expect(statusPill({ kind: 'live' }, true, true).label).toBe('Eingefroren');
    expect(statusPill({ kind: 'live' }, true, false).label).toBe('Eingefroren');
  });

  it('puts a freeze before short notices', () => {
    expect(statusPill({ kind: 'rotated' }, true, true).label).toBe('Eingefroren');
    expect(statusPill({ kind: 'truncated' }, true, true).label).toBe('Eingefroren');
  });

  it('puts trouble before a freeze', () => {
    expect(statusPill({ kind: 'file_missing' }, true, true).cls).toBe('bad');
    const failed = statusPill({ kind: 'error', message: 'kaputt' }, true, true);
    expect(failed).toEqual({ label: 'Fehler: kaputt', cls: 'bad' });
  });

  it('shows the progress of loading', () => {
    expect(statusPill({ kind: 'loading', progress: 0.42 }, false, true).label).toBe('Lade … 42 %');
  });
});
