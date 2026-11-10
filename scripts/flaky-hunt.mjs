#!/usr/bin/env node
// Runs the Rust tests many times under artificial load and collects every failure.
//
//   node scripts/flaky-hunt.mjs [--runs 20] [--threads N] [--load N] [--serial]
//                               [--only <substring of a binary>] [--filter <test name>]
//                               [--timeout 600] [--out flaky-hunt.json]
//
// The test binaries are built once (`cargo test --no-run`) and then started directly, all at
// the same time, each with more test threads than the machine has cores. On top of that
// `--load` busy processes keep the cores occupied. That is roughly what a CI runner with two
// slow cores does to the tests. A binary that does not end within `--timeout` seconds is
// killed and counted as a hang.
//
// Exit code 1 if anything failed. The summary lists each failing test with its count and the
// first lines of its message.

import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAURI = join(ROOT, 'src-tauri');

export function parseArgs(argv, cores = availableParallelism()) {
  const options = {
    runs: 20,
    threads: cores * 2,
    load: cores,
    serial: false,
    only: '',
    filter: '',
    timeout: 600,
    out: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    const number = () => {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 0) throw new Error(`${arg} needs a whole number`);
      return n;
    };
    if (arg === '--runs') options.runs = number();
    else if (arg === '--threads') options.threads = number();
    else if (arg === '--load') options.load = number();
    else if (arg === '--timeout') options.timeout = number();
    else if (arg === '--serial') options.serial = true;
    else if (arg === '--only') options.only = value();
    else if (arg === '--filter') options.filter = value();
    else if (arg === '--out') options.out = value();
    else throw new Error(`unknown option ${arg}`);
  }
  if (options.runs < 1 || options.threads < 1) throw new Error('--runs and --threads start at 1');
  return options;
}

/** Test executables from the JSON messages of `cargo test --no-run`. */
export function parseExecutables(cargoJson) {
  const found = [];
  for (const line of cargoJson.split('\n')) {
    if (!line.startsWith('{')) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.reason !== 'compiler-artifact' || !message.executable) continue;
    if (!message.profile?.test) continue;
    found.push({
      name: `${message.target.name}${message.target.kind.includes('test') ? '' : ` (${message.target.kind[0]})`}`,
      executable: message.executable,
      cwd: dirname(message.manifest_path),
    });
  }
  return found;
}

/** Failed tests of one libtest run with the first lines of what they printed. */
export function parseFailures(output, maxLines = 12) {
  const failed = [];
  for (const match of output.matchAll(/^test (\S+) \.\.\. FAILED$/gm)) failed.push(match[1]);
  // Output of a test can end up in the same line as its result: "test a ... <noise>FAILED".
  for (const match of output.matchAll(/^test (\S+) \.\.\. .+FAILED$/gm)) {
    if (!failed.includes(match[1])) failed.push(match[1]);
  }
  const lines = output.split('\n');
  return failed.map((test) => {
    const start = lines.indexOf(`---- ${test} stdout ----`);
    const message = [];
    if (start >= 0) {
      for (let i = start + 1; i < lines.length && message.length < maxLines; i++) {
        if (/^---- .+ ----$/.test(lines[i]) || lines[i] === 'failures:') break;
        if (lines[i].trim() !== '') message.push(lines[i]);
      }
    }
    return { test, message: message.join('\n') };
  });
}

/** Counts failures per binary and test, keeps the first message of each. */
export function summarize(failures) {
  const byTest = new Map();
  for (const failure of failures) {
    const key = `${failure.binary} :: ${failure.test}`;
    const entry = byTest.get(key) ?? { ...failure, count: 0, runs: [] };
    entry.count++;
    entry.runs.push(failure.run);
    byTest.set(key, entry);
  }
  return [...byTest.values()].sort((a, b) => b.count - a.count);
}

function build() {
  console.log('flaky-hunt: building the test binaries …');
  const result = spawnSync('cargo', ['test', '--workspace', '--no-run', '--message-format=json'], {
    cwd: TAURI,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.status !== 0) throw new Error('cargo test --no-run failed');
  return parseExecutables(result.stdout);
}

function runBinary(binary, options) {
  return new Promise((resolve) => {
    const args = [`--test-threads=${options.threads}`];
    if (options.filter) args.unshift(options.filter);
    const started = Date.now();
    const child = spawn(binary.executable, args, {
      cwd: binary.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    let hung = false;
    const timer = setTimeout(() => {
      hung = true;
      child.kill('SIGKILL');
    }, options.timeout * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, hung, output, seconds: (Date.now() - started) / 1000 });
    });
  });
}

function startLoad(count) {
  const burners = [];
  for (let i = 0; i < count; i++) {
    burners.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
  }
  return () => burners.forEach((burner) => burner.kill('SIGKILL'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const binaries = build().filter((binary) => binary.name.includes(options.only));
  if (binaries.length === 0) throw new Error('no test binary matches');
  console.log(
    `flaky-hunt: ${binaries.length} binaries, ${options.runs} runs, ${options.threads} test threads each, ` +
      `${options.load} busy processes, ${options.serial ? 'one binary after the other' : 'all binaries at once'}`,
  );

  const stopLoad = startLoad(options.load);
  process.on('SIGINT', () => {
    stopLoad();
    process.exit(130);
  });
  const failures = [];
  try {
    for (let run = 1; run <= options.runs; run++) {
      const started = Date.now();
      const one = async (binary) => {
        const result = await runBinary(binary, options);
        const failed = parseFailures(result.output);
        if (result.hung) {
          const running = [...result.output.matchAll(/^test (\S+) \.\.\. $/gm)].map((m) => m[1]);
          failed.push({
            test: '(hang)',
            message: `killed after ${options.timeout} s; tail of the output:\n${result.output.split('\n').slice(-8).join('\n')}${running.length ? `\nunfinished: ${running.join(', ')}` : ''}`,
          });
        } else if (result.code !== 0 && failed.length === 0) {
          failed.push({
            test: '(exit)',
            message: `exit code ${result.code}:\n${result.output.split('\n').slice(-12).join('\n')}`,
          });
        }
        for (const failure of failed) failures.push({ run, binary: binary.name, ...failure });
        return failed.length;
      };
      let count = 0;
      if (options.serial) for (const binary of binaries) count += await one(binary);
      else count = (await Promise.all(binaries.map(one))).reduce((a, b) => a + b, 0);
      const seconds = ((Date.now() - started) / 1000).toFixed(0);
      console.log(
        `run ${run}/${options.runs}: ${count === 0 ? 'ok' : `${count} FAILED`} (${seconds} s)`,
      );
      for (const failure of failures.filter((f) => f.run === run)) {
        console.log(`  ${failure.binary} :: ${failure.test}`);
      }
    }
  } finally {
    stopLoad();
  }

  const summary = summarize(failures);
  console.log('');
  if (summary.length === 0) console.log(`flaky-hunt: no failure in ${options.runs} runs`);
  for (const entry of summary) {
    console.log(`${entry.count}× ${entry.binary} :: ${entry.test} (runs ${entry.runs.join(', ')})`);
    console.log(entry.message.replace(/^/gm, '    '));
  }
  if (options.out) {
    writeFileSync(
      options.out,
      JSON.stringify({ options, platform: process.platform, summary }, null, 2),
    );
    console.log(`written to ${basename(options.out)}`);
  }
  process.exit(summary.length === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`flaky-hunt: ${error.message}`);
    process.exit(2);
  });
}
