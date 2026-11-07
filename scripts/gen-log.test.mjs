import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeEntry, parseArgs } from './gen-log.mjs';

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
