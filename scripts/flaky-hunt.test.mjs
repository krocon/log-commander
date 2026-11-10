import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs, parseExecutables, parseFailures, summarize } from './flaky-hunt.mjs';

test('options have defaults that exceed the cores', () => {
  const options = parseArgs([], 4);
  assert.equal(options.runs, 20);
  assert.equal(options.threads, 8);
  assert.equal(options.load, 4);
  assert.equal(options.serial, false);
});

test('options are read and checked', () => {
  const options = parseArgs(
    ['--runs', '3', '--load', '0', '--serial', '--only', 'tail', '--filter', 'rot'],
    4,
  );
  assert.deepEqual(
    [options.runs, options.load, options.serial, options.only, options.filter],
    [3, 0, true, 'tail', 'rot'],
  );
  assert.throws(() => parseArgs(['--runs']), /needs a value/);
  assert.throws(() => parseArgs(['--runs', 'x']), /whole number/);
  assert.throws(() => parseArgs(['--runs', '0']), /start at 1/);
  assert.throws(() => parseArgs(['--what']), /unknown option/);
});

test('test executables come from the cargo messages', () => {
  const artifact = (name, kind, test, executable) =>
    JSON.stringify({
      reason: 'compiler-artifact',
      manifest_path: '/w/src-tauri/Cargo.toml',
      target: { name, kind: [kind] },
      profile: { test },
      executable,
    });
  const found = parseExecutables(
    [
      'warning: something',
      artifact('serde', 'lib', false, null),
      artifact('log_commander_lib', 'lib', true, '/t/lib-1'),
      artifact('tail_integration', 'test', true, '/t/tail-2'),
      artifact('log-commander', 'bin', false, '/t/app'),
      '{"reason":"build-finished","success":true}',
    ].join('\n'),
  );
  assert.deepEqual(found, [
    { name: 'log_commander_lib (lib)', executable: '/t/lib-1', cwd: '/w/src-tauri' },
    { name: 'tail_integration', executable: '/t/tail-2', cwd: '/w/src-tauri' },
  ]);
});

test('failed tests are found with their message', () => {
  const output = `
running 3 tests
test a::fine ... ok
test a::broken ... FAILED
test b::noisy ... some output FAILED

failures:

---- a::broken stdout ----

thread 'a::broken' panicked at src/a.rs:3:5:
timeout: the line arrives
note: run with RUST_BACKTRACE=1

---- b::noisy stdout ----
second

failures:
    a::broken
    b::noisy

test result: FAILED. 1 passed; 2 failed
`;
  const failures = parseFailures(output);
  assert.deepEqual(
    failures.map((f) => f.test),
    ['a::broken', 'b::noisy'],
  );
  assert.match(failures[0].message, /timeout: the line arrives/);
  assert.doesNotMatch(failures[0].message, /second/);
  assert.equal(failures[1].message, 'second');
  assert.deepEqual(parseFailures('test a ... ok\n'), []);
});

test('the summary counts per test', () => {
  const summary = summarize([
    { run: 1, binary: 'x', test: 'a', message: 'first' },
    { run: 2, binary: 'x', test: 'b', message: 'm' },
    { run: 3, binary: 'x', test: 'a', message: 'later' },
  ]);
  assert.equal(summary[0].test, 'a');
  assert.equal(summary[0].count, 2);
  assert.deepEqual(summary[0].runs, [1, 3]);
  assert.equal(summary[0].message, 'first');
  assert.equal(summary[1].count, 1);
});
