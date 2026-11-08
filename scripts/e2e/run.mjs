#!/usr/bin/env node
// End-to-end test of the real app: a debug build, real webview, real backend, a real log file. The
// scenario runs in the webview (scenario.js) and reports over stdout; this harness changes the file
// when asked. Needs a window (on Linux: run under Xvfb).
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createSocket } from 'node:dgram';
import { DatabaseSync } from 'node:sqlite';
import { entryTime, makeEntry, parseArgs } from '../gen-log.mjs';

const root = new URL('../..', import.meta.url).pathname;
const exe = process.platform === 'win32' ? 'log-commander.exe' : 'log-commander';

if (!process.argv.includes('--no-build')) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const built = spawnSync(npx, ['tauri', 'build', '--debug', '--no-bundle'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

/** `--scenario <file>` runs another scenario, e.g. a spike measurement. */
function scenarioArg() {
  const i = process.argv.indexOf('--scenario');
  return i > 0 ? process.argv[i + 1] : undefined;
}

const dir = mkdtempSync(join(tmpdir(), 'lc-e2e-'));
const log = join(dir, 'e2e.log');
writeFileSync(log, readFileSync(join(root, 'samples/spring-boot.log')));
const other = join(dir, 'other.log');
writeFileSync(other, 'ERROR:root:other file\nINFO:root:still here\n');
// No structure at all: no columns (prompt 009), opened by the scenario through the path dialog.
writeFileSync(join(dir, 'plain.log'), 'just some words\nand some more words\n');
// Prompt 017: the folder the SFTP server in the app serves (debug builds only), with a log in it.
const remoteDir = join(dir, 'remote');
const remoteLog = join(remoteDir, 'app.log');
mkdirSync(join(remoteDir, 'archive'), { recursive: true });
writeFileSync(
  remoteLog,
  '2026-01-15 10:00:00,000 INFO  [main] app.Boot - remote start\n2026-01-15 10:00:01,000 ERROR [main] app.Db - remote größe 😀\n',
);
// Measurements in the message (prompt 011): Python format, `cpu=… mem=… took …`, the same on every run.
{
  let state = 4711;
  const random = () => (state = (state * 16807) % 2147483647) / 2147483647;
  const start = Date.UTC(2026, 0, 15, 9);
  let text = '';
  for (let i = 0; i < 300; i++)
    text += `${makeEntry('python', new Date(start + i * 1000), random, 0, true)}\n`;
  writeFileSync(join(dir, 'metrics.log'), text);
}
// Merge (prompt 006): two formats whose entries interleave in time; generators make them grow later.
const mergeA = join(dir, 'merge-a.log');
const mergeB = join(dir, 'merge-b.log');
writeFileSync(
  mergeA,
  [1, 3, 5]
    .map((s) => `2026-01-15T09:00:0${s}.000Z  INFO 4711 --- [main] c.a.A : merge a${s}\n`)
    .join(''),
);
writeFileSync(
  mergeB,
  '2026-01-15 09:00:02,000 - app.b - INFO - merge b2\n'.replace('09:00', localHour(9)) +
    '2026-01-15 09:00:04,000 - app.b - ERROR - merge b4\nTraceback (most recent call last):\nValueError: b4\n'.replace(
      '09:00',
      localHour(9),
    ),
);
// Timeline (prompt 014): one entry a second from 09:00:00Z, after 300 entries 47 minutes of silence (09:04:59 to
// 09:52:00), 600 entries; the same on every run.
{
  let state = 1414;
  const random = () => (state = (state * 16807) % 2147483647) / 2147483647;
  const options = parseArgs([
    'gap.log',
    '--start',
    '2026-01-15T09:00:00Z',
    '--pause-after',
    '300',
    '--pause',
    '47',
  ]);
  let text = '';
  for (let i = 0; i < 600; i++)
    text += `${makeEntry('spring', entryTime(options, i), random, 0.3)}\n`;
  writeFileSync(join(dir, 'gap.log'), text);
}
// Prompt 019: a SQLite database with a log table; the scenario opens it as a source (read-only), the harness adds
// rows (`dbinsert`) and checks that nothing else changed it (`expectdbcount`).
const logsDb = new DatabaseSync(join(dir, 'logs.db'));
logsDb.exec(`CREATE TABLE logs (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, level TEXT, msg TEXT, data BLOB);
  INSERT INTO logs (ts, level, msg, data) VALUES
    ('2026-11-08T10:00:00', 'INFO', 'db start', NULL),
    ('2026-11-08T10:00:01', 'ERROR', 'db Grüße 😀', x'00ff'),
    ('2026-11-08T10:00:01', 'WARN', 'db same time', NULL);`);
// Dashboard (prompt 012): the Spring Boot sample once more, opened by the scenario through the path dialog.
const dash = join(dir, 'dash.log');
writeFileSync(dash, readFileSync(join(root, 'samples/spring-boot.log')));
/** `HH:00` local for 09:00 UTC on that day, so both files mean the same moment without a zone. */
function localHour(utcHour) {
  const d = new Date(Date.UTC(2026, 0, 15, utcHour, 0, 0));
  return `${String(d.getHours()).padStart(2, '0')}:00`;
}
const generators = [];
const big = join(dir, 'big.log');
// `--big-lines N` for measurements with larger files (the spike of prompt 003 reads at 10 million).
const bigLinesAt = process.argv.indexOf('--big-lines');
writeBigFile(big, bigLinesAt > 0 ? Number(process.argv[bigLinesAt + 1]) : 2_000_000);

function writeBigFile(path, lines) {
  const fd = openSync(path, 'w');
  let chunk = '';
  for (let i = 1; i <= lines; i++) {
    chunk += `2026-01-15T10:00:00.000+01:00  INFO 1 --- [t] a.B : big line ${i} \n`;
    if (chunk.length > 1_000_000) {
      writeSync(fd, chunk);
      chunk = '';
    }
  }
  writeSync(fd, chunk);
  closeSync(fd);
}

const app = spawn(join(root, 'src-tauri/target/debug', exe), [log, other, big], {
  env: {
    ...process.env,
    // Keeps the user's real settings and recent files out of it.
    HOME: dir,
    APPDATA: dir,
    LOCALAPPDATA: dir,
    XDG_CONFIG_HOME: dir,
    XDG_DATA_HOME: dir,
    LC_E2E_SCRIPT: join(root, scenarioArg() ?? 'scripts/e2e/scenario.js'),
    // The window opens behind the others without focus; `--foreground` keeps the usual start (frame
    // measurements of the spikes need a visible, unobscured window).
    LC_E2E_FOREGROUND: process.argv.includes('--foreground') ? '1' : undefined,
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});

let passed = 0;
let exitCode = 1;
const finish = (code) => {
  exitCode = code;
  app.kill();
};
const timer = setTimeout(() => {
  console.error('FAIL: scenario did not finish in time (no report for 90 s)');
  finish(1);
}, 90_000);

function act(action) {
  const [verb, ...rest] = action.split(' ');
  const text = rest.join(' ');
  switch (verb) {
    case 'append':
      appendFileSync(log, `${text}\n`);
      break;
    case 'appenddash':
      appendFileSync(dash, `${text}\n`);
      break;
    case 'bulk': {
      const n = Number(text);
      let chunk = '';
      for (let i = 1; i <= n; i++) {
        chunk += `2026-01-15T10:01:01.000+01:00  INFO 4711 --- [t] a.B : bulk line ${i}\n`;
      }
      appendFileSync(log, chunk);
      break;
    }
    case 'rate': {
      const [rateText, secondsText, level = 'INFO', target = 'log'] = text.split(' ');
      const file = target === 'big' ? big : log;
      const rate = Number(rateText);
      const seconds = Number(secondsText);
      const perTick = rate / 20;
      let written = 0;
      const tick = setInterval(() => {
        let chunk = '';
        for (let i = 0; i < perTick; i++) {
          written++;
          chunk += `2026-01-15T10:07:00.000+01:00 ${level.padStart(5)} 4711 --- [t] a.B : ${level} rate line ${written}\n`;
        }
        appendFileSync(file, chunk);
        if (written >= rate * seconds) clearInterval(tick);
      }, 50);
      break;
    }
    case 'cpustart':
      cpuMark = cpuSample();
      break;
    case 'cpustop': {
      const now = cpuSample();
      const seconds = (Date.now() - cpuMark.at) / 1000;
      const pct = (a, b) => Math.round(((a - b) / seconds) * 100);
      console.log(
        `  cpu ${text}: app ${pct(now.app, cpuMark.app)} %, webview ${pct(now.web, cpuMark.web)} %, webview rss ${now.rss} MB`,
      );
      break;
    }
    case 'genstart': {
      // A busy and a quiet source; the busy one rotates (prompt 006).
      const gen = join(root, 'scripts/gen-log.mjs');
      generators.push(
        spawn(process.execPath, [gen, mergeA, '--rate', '5000', '--rotate-every', '20000'], {
          stdio: 'ignore',
        }),
        spawn(process.execPath, [gen, mergeB, '--rate', '20'], {
          stdio: 'ignore',
        }),
      );
      break;
    }
    case 'genstop':
      for (const g of generators) g.kill();
      break;
    case 'truncate':
      truncateSync(log);
      break;
    case 'sftpappend':
      // Prompt 017: a line written on the "server".
      appendFileSync(remoteLog, `${text}\n`);
      break;
    case 'sftprotate':
      renameSync(remoteLog, `${remoteLog}.1`);
      writeFileSync(remoteLog, `${text}\n`);
      break;
    case 'rotate':
      renameSync(log, `${log}.1`);
      writeFileSync(log, `${text}\n`);
      break;
    case 'delete':
      rmSync(log);
      break;
    case 'recreate':
      writeFileSync(log, `${text}\n`);
      break;
    case 'expectfile': {
      // Prompt 015: a file the app wrote (export, workspace) holds every given text: `name|text|text…`.
      const [name, ...wanted] = text.split('|');
      let content = '';
      try {
        content = readFileSync(join(dir, name), 'utf8');
      } catch (e) {
        console.error(`\nFAIL file ${name} not written: ${e.message}`);
        finish(1);
        break;
      }
      const missing = wanted.filter((w) => !content.includes(w));
      if (missing.length) {
        console.error(`\nFAIL file ${name} lacks ${JSON.stringify(missing)}`);
        finish(1);
      } else {
        passed++;
        console.log(`  ok  file ${name} holds ${wanted.length} expected texts`);
      }
      break;
    }
    case 'syslog': {
      // Prompt 016: `syslog <port> <count>` sends RFC 3164 datagrams to the app's listener (severities ERROR,
      // WARN, INFO in turn), then one message with line breaks.
      const [portText, countText] = text.split(' ');
      const socket = createSocket('udp4');
      const port = Number(portText);
      const messages = [];
      for (let i = 0; i < Number(countText); i++) {
        const pri = 8 + [3, 4, 6][i % 3];
        messages.push(`<${pri}>Nov  7 10:15:30 e2e-host app[${i}]: syslog e2e message ${i}\n`);
      }
      messages.push('<11>Nov  7 10:15:31 e2e-host app[1]: multi line\nsecond line');
      let i = 0;
      const next = () => {
        if (i >= messages.length) {
          socket.close();
          return;
        }
        socket.send(messages[i++], port, '127.0.0.1', () => setTimeout(next, 1));
      };
      next();
      break;
    }
    case 'expectspool':
    case 'expectnospool': {
      // The spool of a source exists while its tab is open and is gone after closing (prompt 016).
      const want = verb === 'expectspool';
      const start = Date.now();
      const check = () => {
        if (existsSync(text) === want) {
          passed++;
          console.log(`  ok  spool ${want ? 'exists' : 'deleted'}: ${text}`);
        } else if (Date.now() - start < 5000) {
          setTimeout(check, 100);
        } else {
          console.error(`\nFAIL spool ${want ? 'missing' : 'left behind'}: ${text}`);
          finish(1);
        }
      };
      check();
      break;
    }
    case 'dbinsert': {
      // `dbinsert <ts>|<level>|<msg>` (prompt 019).
      const [ts, level, msg] = text.split('|');
      logsDb.prepare('INSERT INTO logs (ts, level, msg) VALUES (?, ?, ?)').run(ts, level, msg);
      break;
    }
    case 'expectdbcount': {
      // Only the harness writes: the app never changed the database (prompt 019).
      const { n } = logsDb.prepare('SELECT count(*) AS n FROM logs').get();
      const hacked = logsDb.prepare("SELECT count(*) AS n FROM logs WHERE msg = 'hacked'").get().n;
      if (n === Number(text) && hacked === 0) {
        passed++;
        console.log(`  ok  the database holds ${n} rows, none written by the app`);
      } else {
        console.error(`\nFAIL the database holds ${n} rows (${hacked} 'hacked'), expected ${text}`);
        finish(1);
      }
      break;
    }
    case 'expectsettings': {
      // Prompt 020: what the app stored in its settings store (survives a restart): `text|text…`.
      const file = readdirSync(dir, { recursive: true }).find((f) =>
        String(f).endsWith('settings.json'),
      );
      const content = file ? readFileSync(join(dir, String(file)), 'utf8') : '';
      const missing = text.split('|').filter((w) => !content.includes(w));
      if (!file || missing.length) {
        console.error(`\nFAIL settings ${file ?? '(none)'} lack ${JSON.stringify(missing)}`);
        finish(1);
      } else {
        passed++;
        console.log(`  ok  the settings store holds ${text}`);
      }
      break;
    }
    case 'expectnofile': {
      const leftovers = readdirSync(dir).filter((f) => f.includes(text));
      if (leftovers.length) {
        console.error(`\nFAIL files left behind: ${leftovers.join(', ')}`);
        finish(1);
      } else {
        passed++;
        console.log(`  ok  no file like ${text} left behind`);
      }
      break;
    }
    default:
      break;
  }
}

let cpuMark = { at: Date.now(), app: 0, web: 0 };

/** CPU seconds of the app and of the newest WebKit content process (macOS), RSS of the latter. */
function cpuSample() {
  const seconds = (pid) => {
    const out = spawnSync('ps', ['-o', 'time=,rss=', '-p', String(pid)], {
      encoding: 'utf8',
    }).stdout.trim();
    const [time = '0:0', rss = '0'] = out.split(/\s+/);
    const parts = time.split(':').map(Number);
    return { cpu: parts.reduce((acc, v) => acc * 60 + v, 0), rss: Math.round(Number(rss) / 1024) };
  };
  const web = spawnSync('pgrep', ['-n', '-f', 'com.apple.WebKit.WebContent'], {
    encoding: 'utf8',
  }).stdout.trim();
  const webSample = web ? seconds(web) : { cpu: 0, rss: 0 };
  return { at: Date.now(), app: seconds(app.pid).cpu, web: webSample.cpu, rss: webSample.rss };
}

createInterface({ input: app.stdout }).on('line', (line) => {
  if (!line.startsWith('E2E ')) return;
  const message = line.slice(4);
  timer.refresh();
  if (message.startsWith('PASS')) {
    passed++;
    console.log(`  ok  ${message.slice(5)}`);
  } else if (message.startsWith('ACTION')) {
    act(message.slice(7));
  } else if (message === 'DONE') {
    console.log(`\n${passed} steps passed`);
    finish(0);
  } else if (message.startsWith('FAIL')) {
    console.error(`\nFAIL ${message.slice(5)}`);
    finish(1);
  }
});

app.on('exit', () => {
  clearTimeout(timer);
  logsDb.close();
  for (const g of generators) g.kill();
  rmSync(dir, { recursive: true, force: true });
  process.exit(exitCode);
});
