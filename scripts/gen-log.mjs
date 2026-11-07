#!/usr/bin/env node
// Writes log lines into a file at a given rate, for trying Log Commander by hand.
//
//   node scripts/gen-log.mjs /tmp/app.log --rate 5000
//   node scripts/gen-log.mjs /tmp/app.jsonl --format json --rate 200
//   node scripts/gen-log.mjs /tmp/app.log --rotate-every 50000 --truncate-every 0
//   node scripts/gen-log.mjs /tmp/big.log --lines 5000000 --rate 0      (as fast as possible)
import { appendFileSync, renameSync, truncateSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'INFO', 'INFO', 'INFO', 'WARN', 'ERROR', 'FATAL'];
const WEIGHTS = [8, 20, 60, 0, 0, 0, 7, 4, 1];
const MESSAGES = [
  'request finished in {n} ms',
  'user {id} logged in from 10.0.{a}.{b}',
  'cache miss for key "session:{id}"',
  'retrying connection to https://db.example.com:{port}/primary',
  'processed batch of {n} items',
  'heap usage at {a}%',
];
const NUMERIC_JSON = { TRACE: 10, DEBUG: 20, INFO: 30, WARN: 40, ERROR: 50, FATAL: 60 };

function pickLevel(random) {
  const total = WEIGHTS.reduce((a, b) => a + b, 0);
  let roll = random() * total;
  for (let i = 0; i < LEVELS.length; i++) {
    roll -= WEIGHTS[i];
    if (roll < 0) return LEVELS[i];
  }
  return 'INFO';
}

function message(random) {
  const n = (max) => Math.floor(random() * max);
  return MESSAGES[n(MESSAGES.length)]
    .replace('{n}', n(5000))
    .replace('{id}', `${n(99999)}-${n(99999)}`)
    .replace('{a}', n(256))
    .replace('{b}', n(256))
    .replace('{port}', 5000 + n(1000));
}

const STACK = [
  'java.lang.IllegalStateException: connection pool exhausted',
  '\tat com.acme.db.Pool.acquire(Pool.java:142)',
  '\tat com.acme.service.OrderService.place(OrderService.java:57)',
  'Caused by: java.net.SocketTimeoutException: Read timed out',
  '\t... 12 more',
];

/** One entry (one or more lines, without the final newline). */
export function makeEntry(format, now, random, stackChance = 0.3) {
  const level = pickLevel(random);
  const iso = now.toISOString();
  const text = message(random);
  const stack = (level === 'ERROR' || level === 'FATAL') && random() < stackChance;
  switch (format) {
    case 'json':
      return random() < 0.5
        ? JSON.stringify({ time: iso, level: NUMERIC_JSON[level], msg: text })
        : JSON.stringify({ '@t': iso, '@l': level.toLowerCase(), '@m': text });
    case 'python': {
      const py = level === 'WARN' ? 'WARNING' : level === 'FATAL' ? 'CRITICAL' : level;
      const head = `${iso.replace('T', ' ').replace('Z', '').replace('.', ',')} - app.worker - ${py === 'TRACE' ? 'DEBUG' : py} - ${text}`;
      return stack
        ? `${head}\nTraceback (most recent call last):\n  File "app.py", line 3, in <module>\nValueError: ${text}`
        : head;
    }
    case 'nginx': {
      const word = {
        TRACE: 'debug',
        DEBUG: 'debug',
        INFO: 'info',
        WARN: 'warn',
        ERROR: 'error',
        FATAL: 'emerg',
      }[level];
      return `${iso.slice(0, 19).replace(/-/g, '/').replace('T', ' ')} [${word}] 1234#0: *${Math.floor(random() * 9999)} ${text}`;
    }
    default: {
      const head = `${iso}  ${level.padStart(5)} 4711 --- [worker-${Math.floor(random() * 8)}] c.a.service.Handler : ${text}`;
      return stack ? `${head}\n${STACK.join('\n')}` : head;
    }
  }
}

export function parseArgs(argv) {
  const options = {
    file: null,
    rate: 100,
    format: 'spring',
    lines: Infinity,
    rotateEvery: 0,
    truncateEvery: 0,
    stack: 0.3,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--rate') options.rate = Number(next());
    else if (arg === '--format') options.format = next();
    else if (arg === '--json') options.format = 'json';
    else if (arg === '--lines') options.lines = Number(next());
    else if (arg === '--rotate-every') options.rotateEvery = Number(next());
    else if (arg === '--truncate-every') options.truncateEvery = Number(next());
    else if (arg === '--stack') options.stack = Number(next());
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else options.file = arg;
  }
  if (!options.file)
    throw new Error(
      'usage: gen-log.mjs <file> [--rate N] [--format spring|python|json|nginx] [--lines N] [--rotate-every N] [--truncate-every N] [--stack 0..1]',
    );
  return options;
}

function rotate(file) {
  for (let i = 4; i >= 1; i--) {
    if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  }
  if (existsSync(file)) renameSync(file, `${file}.1`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let written = 0;
  let sinceRotate = 0;
  let sinceTruncate = 0;
  const tickMs = 50;
  const perTick = options.rate > 0 ? Math.max(1, Math.round((options.rate * tickMs) / 1000)) : 5000;
  process.on('SIGINT', () => {
    console.log(`\n${written} entries written`);
    process.exit(0);
  });
  while (written < options.lines) {
    const start = Date.now();
    const count = Math.min(perTick, options.lines - written);
    let chunk = '';
    for (let i = 0; i < count; i++) {
      chunk += makeEntry(options.format, new Date(), Math.random, options.stack) + '\n';
    }
    appendFileSync(options.file, chunk);
    written += count;
    sinceRotate += count;
    sinceTruncate += count;
    if (options.rotateEvery && sinceRotate >= options.rotateEvery) {
      rotate(options.file);
      sinceRotate = 0;
      console.log(`rotated after ${written} entries`);
    }
    if (options.truncateEvery && sinceTruncate >= options.truncateEvery) {
      truncateSync(options.file);
      sinceTruncate = 0;
      console.log(`truncated after ${written} entries`);
    }
    if (options.rate > 0) {
      await new Promise((r) => setTimeout(r, Math.max(0, tickMs - (Date.now() - start))));
    }
  }
  console.log(`${written} entries written`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
