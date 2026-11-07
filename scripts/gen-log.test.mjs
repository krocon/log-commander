import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entryTime, makeEntry, metricsText, parseArgs } from './gen-log.mjs';

function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

const now = new Date('2026-01-15T10:00:00.123Z');

test('json entries always parse and carry a level', () => {
  const random = seeded(7);
  for (let i = 0; i < 200; i++) {
    const entry = JSON.parse(makeEntry('json', now, random));
    assert.ok(entry.level !== undefined || entry['@l'] !== undefined);
  }
});

test('stack traces appear only below errors', () => {
  const random = seeded(11);
  let stacks = 0;
  for (let i = 0; i < 2000; i++) {
    const entry = makeEntry('spring', now, random, 1);
    if (entry.includes('\n')) {
      stacks++;
      assert.match(entry.split('\n')[0], /ERROR|FATAL/);
    }
  }
  assert.ok(stacks > 0);
});

test('no stack traces with chance 0', () => {
  const random = seeded(13);
  for (let i = 0; i < 500; i++) assert.ok(!makeEntry('spring', now, random, 0).includes('\n'));
});

test('nginx format', () => {
  assert.match(makeEntry('nginx', now, seeded(3)), /^2026\/01\/15 10:00:00 \[\w+\] 1234#0: /);
});

test('parses options', () => {
  const options = parseArgs(['a.log', '--rate', '5000', '--json', '--rotate-every', '10']);
  assert.equal(options.file, 'a.log');
  assert.equal(options.rate, 5000);
  assert.equal(options.format, 'json');
  assert.equal(options.rotateEvery, 10);
});

test('rejects unknown options and a missing file', () => {
  assert.throws(() => parseArgs(['--nope']));
  assert.throws(() => parseArgs([]));
});

test('metrics: cpu, mem and took in the message, ms or s', () => {
  const random = seeded(17);
  const units = new Set();
  for (let i = 0; i < 300; i++) {
    const text = metricsText(random);
    const m = /^cpu=(\d+\.\d)% mem=(\d+\.\d)GB took (\d+ms|\d+\.\ds)$/.exec(text);
    assert.ok(m, text);
    units.add(m[3].endsWith('ms') ? 'ms' : 's');
  }
  assert.deepEqual([...units].sort(), ['ms', 's']);
  const entry = makeEntry('python', now, seeded(5), 0, true);
  assert.match(entry, / cpu=\d+\.\d% mem=/);
  assert.equal(parseArgs(['a.log', '--metrics']).metrics, true);
  assert.equal(parseArgs(['a.log']).metrics, false);
});

test('a synthetic clock with pauses (prompt 014)', () => {
  const options = parseArgs([
    'gap.log',
    '--start',
    '2026-01-15T09:00:00Z',
    '--pause-after',
    '300',
    '--pause',
    '47',
  ]);
  assert.equal(entryTime(options, 0).toISOString(), '2026-01-15T09:00:00.000Z');
  assert.equal(entryTime(options, 299).toISOString(), '2026-01-15T09:04:59.000Z');
  // 47 minutes of silence after 300 entries, then one entry a second again.
  assert.equal(entryTime(options, 300).toISOString(), '2026-01-15T09:52:00.000Z');
  assert.equal(entryTime(options, 301).toISOString(), '2026-01-15T09:52:01.000Z');
  // Without a start the real clock, shifted by the pauses.
  const live = parseArgs(['x.log', '--pause-after', '10', '--pause', '1']);
  assert.equal(entryTime(live, 25, 0).getTime(), 2 * 60_000);
  assert.throws(() => parseArgs(['x.log', '--start', 'yesterday-ish']));
});
