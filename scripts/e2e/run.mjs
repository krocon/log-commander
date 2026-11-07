#!/usr/bin/env node
// End-to-end test of the real app: a debug build, real webview, real backend, a real log file. The
// scenario runs in the webview (scenario.js) and reports over stdout; this harness changes the file
// when asked. Needs a window (on Linux: run under Xvfb).
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
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

const dir = mkdtempSync(join(tmpdir(), 'lc-e2e-'));
const log = join(dir, 'e2e.log');
writeFileSync(log, readFileSync(join(root, 'samples/spring-boot.log')));
const other = join(dir, 'other.log');
writeFileSync(other, 'ERROR:root:other file\nINFO:root:still here\n');
const big = join(dir, 'big.log');
writeBigFile(big, 2_000_000);

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
    LC_E2E_SCRIPT: join(root, 'scripts/e2e/scenario.js'),
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
      const [rate, seconds] = text.split(' ').map(Number);
      const perTick = rate / 20;
      let written = 0;
      const tick = setInterval(() => {
        let chunk = '';
        for (let i = 0; i < perTick; i++) {
          written++;
          chunk += `2026-01-15T10:07:00.000+01:00  INFO 4711 --- [t] a.B : rate line ${written}\n`;
        }
        appendFileSync(log, chunk);
        if (written >= rate * seconds) clearInterval(tick);
      }, 50);
      break;
    }
    case 'truncate':
      truncateSync(log);
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
    default:
      break;
  }
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
  rmSync(dir, { recursive: true, force: true });
  process.exit(exitCode);
});
