import { describe, expect, it } from 'vitest';
import {
  EntryKey,
  LOG_MIN,
  PANEL_MIN,
  SPLITTER_SIZE,
  lineRangeLabel,
  needsReload,
  panelHeight,
  panelMax,
} from './detail-logic';

describe('detail layout', () => {
  it('keeps the wanted height within the bounds', () => {
    expect(panelHeight(240, 800)).toBe(240);
    expect(panelHeight(20, 800)).toBe(PANEL_MIN);
    expect(panelHeight(5000, 800)).toBe(800 - LOG_MIN - SPLITTER_SIZE);
    expect(panelMax(800)).toBe(800 - LOG_MIN - SPLITTER_SIZE);
  });

  it('lets the log view win in a small window', () => {
    const tight = LOG_MIN + SPLITTER_SIZE + 50;
    expect(panelHeight(240, tight)).toBe(50);
    expect(panelHeight(240, 100)).toBe(0);
    expect(panelMax(100)).toBe(PANEL_MIN);
  });
});

describe('detail reload', () => {
  const key = (change: Partial<EntryKey> = {}): EntryKey => ({
    sessionId: 1,
    anchor: 10,
    epoch: 0,
    viewGeneration: 0,
    totalLines: 100,
    fileSize: 5000,
    ...change,
  });

  it('loads first and for another line, tab, index or view', () => {
    expect(needsReload(null, null, key())).toBe(true);
    expect(needsReload(key(), 12, key({ anchor: 11 }))).toBe(true);
    expect(needsReload(key(), 12, key({ sessionId: 2 }))).toBe(true);
    expect(needsReload(key(), 12, key({ epoch: 1 }))).toBe(true);
    expect(needsReload(key(), 12, key({ viewGeneration: 3 }))).toBe(true);
  });

  it('ignores updates for an entry in the middle of the file', () => {
    expect(needsReload(key(), 12, key({ totalLines: 150, fileSize: 9000 }))).toBe(false);
  });

  it('reloads an entry at the end while the file grows', () => {
    expect(needsReload(key(), 99, key())).toBe(false);
    expect(needsReload(key(), 99, key({ totalLines: 101 }))).toBe(true);
    // The provisional last line grows without a new line.
    expect(needsReload(key(), 99, key({ fileSize: 5100 }))).toBe(true);
  });

  it('waits for an answer that is still out', () => {
    expect(needsReload(key(), null, key({ totalLines: 120 }))).toBe(false);
  });
});

describe('detail header', () => {
  it('names the lines one-based', () => {
    expect(lineRangeLabel(811, 839)).toBe('Zeile 812–840');
    expect(lineRangeLabel(0, 0)).toBe('Zeile 1');
    expect(lineRangeLabel(1233, 1299)).toBe('Zeile 1.234–1.300');
  });
});
