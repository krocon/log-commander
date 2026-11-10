#!/usr/bin/env node
// Builds the MCP sidecar `log-commander-mcp` (prompt 022; from AppIconic `scripts/mcp-sidecar.mjs`, same author, MIT) in release mode and puts it where
// Tauri's `bundle.externalBin` wants it: src-tauri/binaries/log-commander-mcp-<target triple>[.exe].
//
//   node scripts/mcp-sidecar.mjs                       host target
//   node scripts/mcp-sidecar.mjs universal-apple-darwin macOS universal (lipo of both)
//   node scripts/mcp-sidecar.mjs --dev                 debug build next to the debug app
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', 'src-tauri');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root });

/** File name of the sidecar for a target triple (exported for the test). */
export function sidecarName(triple) {
  return `log-commander-mcp-${triple}${triple.includes('windows') ? '.exe' : ''}`;
}

/** The macOS architectures of a universal build. */
export const UNIVERSAL_PARTS = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];

/**
 * Every sidecar file a build for `triple` needs. A universal macOS build compiles the app once per
 * architecture first, and each of those builds looks for its own `…-<arch>` sidecar; the bundle
 * then takes the `…-universal-apple-darwin` one (AppIconic release 1.0.0 failed without the parts).
 */
export function sidecarFiles(triple) {
  return triple === 'universal-apple-darwin'
    ? [...UNIVERSAL_PARTS, triple].map(sidecarName)
    : [sidecarName(triple)];
}

function hostTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  return /^host: (.+)$/m.exec(out)[1].trim();
}

function build(triple) {
  run('cargo', [
    'build',
    '--release',
    '-p',
    'lc-mcp',
    '--bin',
    'log-commander-mcp',
    '--target',
    triple,
  ]);
  const exe = triple.includes('windows') ? 'log-commander-mcp.exe' : 'log-commander-mcp';
  return join(root, 'target', triple, 'release', exe);
}

function main(argv) {
  if (argv.includes('--dev')) {
    run('cargo', ['build', '-p', 'lc-mcp', '--bin', 'log-commander-mcp']);
    return;
  }
  const triple = argv[0] ?? hostTriple();
  const dir = join(root, 'binaries');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, sidecarName(triple));
  if (triple === 'universal-apple-darwin') {
    const parts = UNIVERSAL_PARTS.map(build);
    // each architecture's build needs its own file, the bundle the combined one
    UNIVERSAL_PARTS.forEach((t, i) => copyFileSync(parts[i], join(dir, sidecarName(t))));
    run('lipo', ['-create', '-output', target, ...parts]);
  } else {
    copyFileSync(build(triple), target);
  }
  for (const f of sidecarFiles(triple)) console.log(`sidecar: ${join(dir, f)}`);
}

if (process.argv[1] === import.meta.filename) main(process.argv.slice(2));
