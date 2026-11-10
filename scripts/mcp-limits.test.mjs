// Prompt 022: the limits the frontend checks (src/app/features/mcp/mcp-limits.ts) are the ones the tool schemas of
// the sidecar announce (src-tauri/mcp/tools.snapshot.json, written by `cargo test -p lc-mcp`).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('..', import.meta.url);
const snapshot = JSON.parse(
  readFileSync(new URL('src-tauri/mcp/tools.snapshot.json', root), 'utf8'),
);
const source = readFileSync(new URL('src/app/features/mcp/mcp-limits.ts', root), 'utf8');

function limit(name) {
  const m = new RegExp(`\\b${name}: ([0-9_]+),`).exec(source);
  assert.ok(m, `${name} in mcp-limits.ts`);
  return Number(m[1].replaceAll('_', ''));
}

function schemaOf(tool, prop) {
  const t = snapshot.tools.find((x) => x.name === tool);
  assert.ok(t, tool);
  return t.inputSchema.properties[prop];
}

test('frontend limits match the tool schemas', () => {
  const pairs = [
    ['readLinesMax', schemaOf('read_lines', 'count').maximum],
    ['readLinesDefault', schemaOf('read_lines', 'count').default],
    ['lineCharsMin', schemaOf('read_lines', 'max_line_chars').minimum],
    ['lineCharsMax', schemaOf('read_lines', 'max_line_chars').maximum],
    ['lineCharsDefault', schemaOf('read_lines', 'max_line_chars').default],
    ['entryCharsMin', schemaOf('get_entry', 'max_chars').minimum],
    ['entryCharsMax', schemaOf('get_entry', 'max_chars').maximum],
    ['entryCharsDefault', schemaOf('get_entry', 'max_chars').default],
    ['hitsMax', schemaOf('search', 'limit').maximum],
    ['hitsDefault', schemaOf('search', 'limit').default],
    ['bucketsMax', schemaOf('get_timeline', 'buckets').maximum],
    ['bucketsDefault', schemaOf('get_timeline', 'buckets').default],
    ['sqlRowsMax', schemaOf('run_sql', 'limit').maximum],
    ['sqlRowsDefault', schemaOf('run_sql', 'limit').default],
    ['sqlBytesMax', schemaOf('run_sql', 'sql').maxLength],
    ['waitSecondsMax', schemaOf('wait_for_lines', 'timeout_s').maximum],
    ['waitSecondsDefault', schemaOf('wait_for_lines', 'timeout_s').default],
    ['waitLinesMax', schemaOf('wait_for_lines', 'limit').maximum],
    ['waitLinesDefault', schemaOf('wait_for_lines', 'limit').default],
    ['noteCharsMax', schemaOf('add_note', 'text').maxLength],
    ['patternCharsMax', schemaOf('search', 'query').maxLength],
    ['openPathsMax', schemaOf('propose_open', 'paths').maxItems],
  ];
  for (const [name, expected] of pairs) assert.equal(limit(name), expected, name);
  assert.equal(limit('filterWaitMs'), snapshot.limits.filter_wait_seconds * 1000);
  assert.equal(limit('proposalWaitMs'), snapshot.limits.proposal_wait_seconds * 1000);
});

test('the frontend knows every tool of the sidecar', () => {
  const service = readFileSync(new URL('src/app/features/mcp/mcp-tools.ts', root), 'utf8');
  for (const { name } of snapshot.tools) {
    if (name === 'help') continue; // answered by the sidecar itself
    assert.ok(service.includes(`case '${name}':`), `mcp-tools.ts handles ${name}`);
  }
});
