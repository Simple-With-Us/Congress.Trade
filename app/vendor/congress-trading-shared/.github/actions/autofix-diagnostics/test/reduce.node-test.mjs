import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { reduceTranscript } from '../reduce.mjs';

const script = new URL('../reduce.mjs', import.meta.url).pathname;
const SENTINEL = 'TOP_SECRET_SENTINEL_7f1a';

test('preserves result failure separately from success subtype without coercing text', () => {
  for (const [flag, expected] of [[true, true], [false, false], [undefined, null], [SENTINEL, null]]) {
    const out = reduceTranscript([{ type: 'result', subtype: 'success', is_error: flag }]);
    assert.equal(out.result.subtype, 'success');
    assert.equal(out.result.is_error, expected);
    assert(!JSON.stringify(out).includes(SENTINEL));
  }
});

test('categorizes bounded array-form errors without retaining text or other blocks', () => {
  for (const [text, expected] of [['permission denied', 'permission'], ['timed out', 'timeout']]) {
    const out = reduceTranscript([{ type: 'user', message: { content: [{
      type: 'tool_result', is_error: true,
      content: [null, { type: 'image', data: SENTINEL }, { type: 'text', text: `${text} ${SENTINEL}` }],
    }] } }]);
    assert.equal(out.events[0].error_category, expected);
    assert(!JSON.stringify(out).includes(SENTINEL));
    assert(!JSON.stringify(out).includes(text));
  }
  const out = reduceTranscript([{ type: 'user', message: { content: [{
    type: 'tool_result', is_error: true,
    content: [{ type: 'text', text: 'x'.repeat(8192) }, { type: 'text', text: 'permission denied' }],
  }] } }]);
  assert.equal(out.events[0].error_category, 'other');
});
const walk = (value, visit) => {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) value.forEach(v => walk(v, visit));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => walk(v, visit));
};

test('whitelists transcript values and keeps secret sentinels out of every output field', () => {
  const transcript = [{ type: SENTINEL, uuid: SENTINEL, text: SENTINEL, error: SENTINEL, path: SENTINEL, url: SENTINEL,
    message: { content: [{ type: 'tool_use', id: SENTINEL, name: SENTINEL, input: { command: SENTINEL, nested: [SENTINEL], path: `/private/${SENTINEL}` } }, { type: SENTINEL, text: SENTINEL }] } },
  { type: 'assistant', message: { content: [
    { type: 'tool_use', id: `id-${SENTINEL}`, name: 'Bash', input: { command: SENTINEL, args: [`${SENTINEL}`] } },
    { type: 'tool_use', id: `unknown-${SENTINEL}`, name: SENTINEL, input: { nested: { secret: SENTINEL } } },
  ] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `id-${SENTINEL}`, is_error: true, content: `failed at /secret/${SENTINEL}: permission denied ${SENTINEL}` }] } },
  { type: 'result', subtype: SENTINEL, duration_ms: 42, num_turns: 61, cost_usd: 8, model: SENTINEL }];
  const result = reduceTranscript(transcript);
  assert.equal(result.events[0].tool_name, 'Bash');
  assert.equal(result.events[1].tool_name, 'other');
  assert.equal(result.events[2].error_category, 'permission');
  assert.equal(result.result.subtype, 'other');
  assert.equal(result.result.num_turns, 61);
  walk(result, value => assert.equal(value.includes(SENTINEL), false));
  assert.equal(JSON.stringify(result).includes('failed at'), false);
});

test('keeps Bash purpose unknown without serializing commands or losing paired errors', () => {
  const commands = [
    'git status --short', 'npm test', 'rg --files', 'git diff --output=patch',
    `echo "git status ${SENTINEL}"`, `git status && git push ${SENTINEL}`,
    `git status ${'x'.repeat(8193)}${SENTINEL}`,
  ];
  const transcript = commands.flatMap((command, index) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: String(index), name: 'Bash', input: { command, private: SENTINEL } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: String(index), is_error: index === 3 || index === 5, content: SENTINEL }] } },
  ]);
  const out = reduceTranscript(transcript);
  assert(out.events.every(event => event.operation_category === 'shell_other'));
  assert.equal(out.counts.operation_uses.shell_other, commands.length);
  assert.equal(out.counts.operation_errors.shell_other, 2);
  assert.equal(Object.keys(out.counts.operation_uses).length, Object.keys(out.counts.operation_errors).length);
  assert.equal(JSON.stringify(out).includes(SENTINEL), false);
  assert.equal(JSON.stringify(out).includes('git status'), false);
});

test('maps builtin operations and unpaired errors to fixed categories', () => {
  const out = reduceTranscript([
    { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: SENTINEL } },
      { type: 'tool_use', id: 'edit', name: 'Edit', input: { old_string: SENTINEL } },
      { type: 'tool_use', id: 'grep', name: 'Grep', input: { pattern: SENTINEL } },
      { type: 'tool_use', id: 'mcp', name: `mcp__${SENTINEL}__search`, input: {} },
    ] } },
    { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'read', is_error: true, content: SENTINEL },
      { type: 'tool_result', tool_use_id: 'missing', is_error: true, content: SENTINEL },
    ] } },
  ]);
  assert.deepEqual(out.events.map(e => e.operation_category), ['file_read', 'file_write', 'file_discovery', 'mcp', 'file_read', 'other']);
  assert.equal(out.counts.operation_errors.file_read, 1);
  assert.equal(out.counts.operation_errors.other, 1);
  assert.equal(JSON.stringify(out).includes(SENTINEL), false);
});

test('repeated identical calls group stably within one run without exposing signatures', () => {
  const messages = [{ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'one', name: 'Read', input: { file_path: '/a' } },
    { type: 'tool_use', id: 'two', name: 'Read', input: { file_path: '/a' } },
    { type: 'tool_use', id: 'three', name: 'Read', input: { file_path: '/b' } },
    { type: 'tool_use', id: 'four', name: 'mcp__private__search', input: { query: 'private query' } },
  ] } }];
  const out = reduceTranscript(messages);
  assert.deepEqual(out.events.map(e => e.repeat_group), [1, 1, 2, 3]);
  assert.equal(out.counts.repeated_call_groups, 1);
  assert.equal(JSON.stringify(out).includes('/a'), false);
  assert.equal(out.events[3].tool_name, 'mcp');
});

test('different MCP and unknown names do not coalesce despite identical inputs', () => {
  const out = reduceTranscript([{ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'mcp__one__search', input: { q: 'same' } },
    { type: 'tool_use', name: 'mcp__two__search', input: { q: 'same' } },
    { type: 'tool_use', name: 'private_one', input: { q: 'same' } },
    { type: 'tool_use', name: 'private_two', input: { q: 'same' } },
  ] } }]);
  assert.deepEqual(out.events.map(event => event.repeat_group), [1, 2, 3, 4]);
  assert.deepEqual(out.events.map(event => event.tool_name), ['mcp', 'mcp', 'other', 'other']);
});

test('uses assistant message indexes and bounded aggregate counts', () => {
  const out = reduceTranscript([
    { type: 'assistant', message: { content: [] } }, { type: 'user', message: { content: [] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Grep', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', is_error: false, content: 'output' }] } },
    { type: 'result', subtype: 'error_max_turns', duration_ms: 1_372_086, num_turns: 61 },
  ]);
  assert.equal(out.events[0].assistant_message_index, 1);
  assert.equal(out.result.subtype, 'error_max_turns');
  assert.equal(out.result.duration_ms, 1_372_086);
  assert.equal(out.result.num_turns, 61);
  assert.equal(out.events[1].output_bytes, 6);
});

function invoke(temp) { return spawnSync(process.execPath, [script], { env: { ...process.env, RUNNER_TEMP: temp }, encoding: 'utf8' }); }
function diagnostics(temp) { return JSON.parse(fs.readFileSync(path.join(temp, 'claude-autofix-diagnostics', 'diagnostics.json'), 'utf8')); }

test('missing, truncated, malformed, and oversized inputs yield fixed availability metadata', () => {
  for (const [name, bytes, expected] of [
    ['missing', null, 'missing'], ['truncated', '[{"type":"assistant"', 'malformed'],
    ['malformed', `${SENTINEL} not json`, 'malformed'], ['oversized', 'x'.repeat(16 * 1024 * 1024 + 1), 'oversized'],
  ]) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `diag-${name}-`));
    if (bytes !== null) fs.writeFileSync(path.join(temp, 'claude-execution-output.json'), bytes);
    const child = invoke(temp);
    assert.equal(child.status, 0);
    assert.equal(diagnostics(temp).availability, expected);
    assert.equal(child.stdout.includes(SENTINEL), false);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('rejects transcript symlinks and preserves no source content in diagnostics', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-link-'));
  const outside = path.join(os.tmpdir(), `diag-secret-${process.pid}`);
  fs.writeFileSync(outside, JSON.stringify([{ type: SENTINEL }]));
  fs.symlinkSync(outside, path.join(temp, 'claude-execution-output.json'));
  const child = invoke(temp);
  assert.equal(child.status, 0);
  const output = fs.readFileSync(path.join(temp, 'claude-autofix-diagnostics', 'diagnostics.json'), 'utf8');
  assert.equal(JSON.parse(output).availability, 'unsafe_input');
  assert.equal(output.includes(SENTINEL), false);
  fs.rmSync(temp, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });
});

test('rejects a FIFO without blocking while opening the transcript', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-fifo-'));
  execFileSync('mkfifo', [path.join(temp, 'claude-execution-output.json')]);
  const child = spawnSync(process.execPath, [script], { env: { ...process.env, RUNNER_TEMP: temp }, encoding: 'utf8', timeout: 2000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.equal(diagnostics(temp).availability, 'unsafe_input');
  fs.rmSync(temp, { recursive: true, force: true });
});

test('rejects a preexisting output-directory symlink and writes only a fixed failure status', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-out-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-outside-'));
  fs.writeFileSync(path.join(temp, 'claude-execution-output.json'), '[]');
  fs.symlinkSync(outside, path.join(temp, 'claude-autofix-diagnostics'));
  const outputFile = path.join(temp, 'action-output.txt');
  fs.writeFileSync(outputFile, '');
  const child = spawnSync(process.execPath, [script], { env: { ...process.env, RUNNER_TEMP: temp, GITHUB_OUTPUT: outputFile }, encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, 'diagnostics_status=write_failed\n');
  assert.equal(fs.readdirSync(outside).length, 0);
  assert.equal(fs.readFileSync(outputFile, 'utf8'), 'status=write_failed\n');
  fs.rmSync(temp, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('action outputs expose only the trusted summary path and a fixed status', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-output-'));
  fs.writeFileSync(path.join(temp, 'claude-execution-output.json'), JSON.stringify([{ type: 'result', subtype: 'error_max_turns', num_turns: 61 }]));
  const outputFile = path.join(temp, 'action-output.txt');
  fs.writeFileSync(outputFile, '');
  const child = spawnSync(process.execPath, [script], { env: { ...process.env, RUNNER_TEMP: temp, GITHUB_OUTPUT: outputFile }, encoding: 'utf8' });
  assert.equal(child.status, 0);
  const lines = fs.readFileSync(outputFile, 'utf8').trim().split('\n');
  assert.equal(lines[0], `summary-path=${fs.realpathSync(temp)}/claude-autofix-diagnostics/diagnostics.json`);
  assert.equal(lines[1], 'status=available');
  assert.equal(fs.statSync(lines[0].slice('summary-path='.length)).isFile(), true);
  fs.rmSync(temp, { recursive: true, force: true });
});

test('caps event rows and rejects unsafe result counters and subtype strings', () => {
  const parts = Array.from({ length: 700 }, (_, i) => ({ type: 'tool_use', id: String(i), name: 'Read', input: { n: i } }));
  const out = reduceTranscript([{ type: 'assistant', message: { content: parts } }, { type: 'result', subtype: SENTINEL, duration_ms: -1, num_turns: '61' }]);
  assert.equal(out.events.length, 500);
  assert.equal(out.schema_version, 2);
  assert.equal(out.counts.operation_uses.file_read, 700);
  assert(Buffer.byteLength(JSON.stringify(out)) <= 256 * 1024);
  assert.equal(out.result.subtype, 'other');
  assert.equal(out.result.duration_ms, null);
  assert.equal(out.result.num_turns, null);
  assert.equal(JSON.stringify(out).includes(SENTINEL), false);
});
