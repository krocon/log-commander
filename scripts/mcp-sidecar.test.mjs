// Prompt 022, from AppIconic scripts/mcp-sidecar.test.mjs: names and config of the bundled MCP sidecar.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sidecarFiles, sidecarName } from './mcp-sidecar.mjs';

test('sidecar names follow Tauri externalBin (name-<triple>[.exe])', () => {
  assert.equal(
    sidecarName('x86_64-unknown-linux-gnu'),
    'log-commander-mcp-x86_64-unknown-linux-gnu',
  );
  assert.equal(
    sidecarName('x86_64-pc-windows-msvc'),
    'log-commander-mcp-x86_64-pc-windows-msvc.exe',
  );
  assert.equal(sidecarName('universal-apple-darwin'), 'log-commander-mcp-universal-apple-darwin');
});

test('the sidecar config bundles the program next to the app (prompt 022)', () => {
  const conf = JSON.parse(
    readFileSync(new URL('../src-tauri/tauri.sidecar.conf.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(conf.bundle.externalBin, ['binaries/log-commander-mcp']);
  // the everyday config stays without it, so `tauri dev` and CI need no sidecar build
  const main = JSON.parse(
    readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  );
  assert.equal(main.bundle.externalBin, undefined);
});

test('a universal macOS build needs the sidecar of each architecture too', () => {
  assert.deepEqual(sidecarFiles('universal-apple-darwin'), [
    'log-commander-mcp-aarch64-apple-darwin',
    'log-commander-mcp-x86_64-apple-darwin',
    'log-commander-mcp-universal-apple-darwin',
  ]);
  assert.deepEqual(sidecarFiles('x86_64-pc-windows-msvc'), [
    'log-commander-mcp-x86_64-pc-windows-msvc.exe',
  ]);
});
