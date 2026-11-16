#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 500;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_COUNT = 1_000_000;
const BUILTINS = new Set(['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoRead', 'TodoWrite', 'Task', 'Skill', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
const OPERATIONS = ['git_inspect', 'git_branch_update', 'git_commit_push', 'github_review_read', 'github_review_write', 'dependency_install', 'test', 'typecheck', 'build', 'lint', 'file_discovery', 'file_read', 'file_write', 'shell_other', 'web', 'agent', 'utility', 'mcp', 'other'];

function emptyOperations() {
  return Object.fromEntries(OPERATIONS.map(operation => [operation, 0]));
}

function operationFor(tool) {
  if (tool.name === 'Bash') return 'shell_other';
  if (tool.name === 'Read') return 'file_read';
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool.name)) return 'file_write';
  if (['Glob', 'Grep', 'LS'].includes(tool.name)) return 'file_discovery';
  if (tool.category === 'web' || tool.category === 'agent' || tool.category === 'mcp') return tool.category;
  return tool.category === 'utility' ? 'utility' : 'other';
}

function boundedInt(value, maximum = MAX_COUNT) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : null;
}

function safeErrorCategory(value) {
  if (value === true) return 'tool_error';
  if (typeof value !== 'string') return 'none';
  if (/permission|denied|not allowed/i.test(value)) return 'permission';
  if (/timeout|timed out/i.test(value)) return 'timeout';
  if (/not found|enoent/i.test(value)) return 'not_found';
  if (/invalid|malformed|parse/i.test(value)) return 'invalid';
  return 'other';
}

function errorText(content) {
  if (typeof content === 'string') return content.slice(0, 8192);
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content.slice(0, 128)) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    text += block.text.slice(0, 8192 - text.length);
    if (text.length >= 8192) break;
    text += '\n';
  }
  return text;
}

function knownSubtype(value) {
  return new Set(['success', 'error_max_turns', 'error_during_execution', 'error_max_budget_usd', 'error_max_structured_output_retries', 'error_max_tool_use_limit', 'error_max_output_tokens']).has(value) ? value : 'other';
}

function toolClass(name) {
  if (typeof name !== 'string') return { name: 'other', category: 'other' };
  if (BUILTINS.has(name)) {
    const category = ['Bash'].includes(name) ? 'shell' : ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name) ? 'file' : ['WebFetch', 'WebSearch'].includes(name) ? 'web' : ['Task', 'Skill'].includes(name) ? 'agent' : 'utility';
    return { name, category };
  }
  if (/^mcp__/.test(name)) return { name: 'mcp', category: 'mcp' };
  return { name: 'other', category: 'other' };
}

function inputSignature(input) {
  try {
    const s = JSON.stringify(input);
    return typeof s === 'string' && Buffer.byteLength(s) <= 64 * 1024 ? s : null;
  } catch {
    return null;
  }
}

export function reduceTranscript(messages, result = {}) {
  const events = [];
  const toolIds = new Map();
  const repeatGroups = new Map();
  const repeats = new Map();
  let assistantMessageCount = 0;
  const counts = { assistant_messages: 0, user_messages: 0, tool_uses: 0, tool_results: 0 };
  const operationUses = emptyOperations();
  const operationErrors = emptyOperations();
  for (let i = 0; i < messages.length && i < MAX_COUNT; i += 1) {
    const msg = messages[i];
    if (msg && msg.type === 'result') result = msg;
    const type = msg && typeof msg.type === 'string' && ['assistant', 'user', 'system', 'result'].includes(msg.type) ? msg.type : 'other';
    const assistantMessageIndex = type === 'assistant' ? assistantMessageCount++ : null;
    if (type === 'assistant') counts.assistant_messages = Math.min(MAX_COUNT, counts.assistant_messages + 1);
    if (type === 'user') counts.user_messages = Math.min(MAX_COUNT, counts.user_messages + 1);
    const contents = msg && msg.message && Array.isArray(msg.message.content) ? msg.message.content : [];
    for (const part of contents) {
      if (!part || typeof part !== 'object') continue;
      if (type === 'assistant' && part.type === 'tool_use') {
        counts.tool_uses = Math.min(MAX_COUNT, counts.tool_uses + 1);
        const tool = toolClass(part.name);
        const operation = operationFor(tool);
        operationUses[operation] = Math.min(MAX_COUNT, operationUses[operation] + 1);
        const internalToolName = typeof part.name === 'string' && part.name.length <= 256 ? part.name : `opaque-name:${counts.tool_uses}`;
        const signature = inputSignature(part.input);
        const key = JSON.stringify([internalToolName, tool.name, tool.category, signature ?? `unique:${counts.tool_uses}`]);
        if (!repeatGroups.has(key)) repeatGroups.set(key, repeatGroups.size + 1);
        const group = repeatGroups.get(key);
        repeats.set(group, (repeats.get(group) || 0) + 1);
        if (typeof part.id === 'string' && part.id.length <= 1024) toolIds.set(part.id, { ...tool, operation });
        if (events.length < MAX_ROWS) events.push({ event_index: events.length, event_type: 'tool_use', assistant_message_index: assistantMessageIndex, tool_name: tool.name, tool_category: tool.category, operation_category: operation, repeat_group: group, input_bytes: signature === null ? null : Buffer.byteLength(signature) });
      } else if (type === 'user' && part.type === 'tool_result') {
        counts.tool_results = Math.min(MAX_COUNT, counts.tool_results + 1);
        const tool = typeof part.tool_use_id === 'string' ? toolIds.get(part.tool_use_id) : null;
        const operation = tool?.operation ?? 'other';
        if (part.is_error === true) operationErrors[operation] = Math.min(MAX_COUNT, operationErrors[operation] + 1);
        const content = errorText(part.content);
        const outputBytes = typeof part.content === 'string' ? Buffer.byteLength(part.content) : Array.isArray(part.content) ? Math.min(MAX_INPUT_BYTES, Buffer.byteLength(JSON.stringify(part.content))) : null;
        if (events.length < MAX_ROWS) events.push({ event_index: events.length, event_type: 'tool_result', assistant_message_index: null, tool_name: tool?.name ?? 'other', tool_category: tool?.category ?? 'other', operation_category: operation, is_error: part.is_error === true, error_category: part.is_error === true ? safeErrorCategory(content || true) : 'none', output_bytes: outputBytes });
      }
    }
  }
  const repeatedGroups = [...repeats.entries()].filter(([, n]) => n > 1).length;
  return {
    schema_version: 2,
    availability: 'available',
    counts: { ...counts, event_rows: events.length, repeated_call_groups: repeatedGroups, operation_uses: operationUses, operation_errors: operationErrors },
    result: { subtype: knownSubtype(result.subtype), is_error: typeof result.is_error === 'boolean' ? result.is_error : null, duration_ms: boundedInt(result.duration_ms, 86_400_000), num_turns: boundedInt(result.num_turns) },
    events,
  };
}

function unavailable(status) {
  return { schema_version: 2, availability: status, counts: { assistant_messages: 0, user_messages: 0, tool_uses: 0, tool_results: 0, event_rows: 0, repeated_call_groups: 0, operation_uses: emptyOperations(), operation_errors: emptyOperations() }, result: { subtype: 'other', is_error: null, duration_ms: null, num_turns: null }, events: [] };
}

function appendActionOutput(value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) return;
  if (/[\r]/.test(value)) return;
  try { fs.appendFileSync(outputPath, value, { mode: 0o600 }); } catch { /* Fixed status remains available in stdout. */ }
}

function writeActionOutputs(root, status) {
  const summary = path.join(root, 'claude-autofix-diagnostics', 'diagnostics.json');
  if (/[\r\n]/.test(summary) || !['available', 'missing', 'unsafe_input', 'oversized', 'malformed', 'output_limited'].includes(status)) return;
  appendActionOutput(`summary-path=${summary}\nstatus=${status}\n`);
}

function trustedPaths() {
  const temp = process.env.RUNNER_TEMP;
  if (typeof temp !== 'string' || !path.isAbsolute(temp)) throw new Error('bad_temp');
  const root = fs.realpathSync(temp);
  return { root, input: path.join(root, 'claude-execution-output.json'), outputDir: path.join(root, 'claude-autofix-diagnostics') };
}

function loadInput(inputPath) {
  let fd;
  try { fd = fs.openSync(inputPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (e) {
    if (e.code === 'ENOENT') return { status: 'missing' };
    if (e.code === 'ELOOP') return { status: 'unsafe_input' };
    throw new Error('input_io');
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { status: 'unsafe_input' };
    if (stat.size > MAX_INPUT_BYTES) return { status: 'oversized' };
    const bytes = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > MAX_INPUT_BYTES) return { status: 'oversized' };
    let parsed;
    try { parsed = JSON.parse(bytes.subarray(0, offset).toString('utf8')); } catch { return { status: 'malformed' }; }
    if (!Array.isArray(parsed)) return { status: 'malformed' };
    return { messages: parsed };
  } finally {
    fs.closeSync(fd);
  }
}

export function run() {
  let paths;
  try { paths = trustedPaths(); } catch { process.stdout.write('diagnostics_status=bad_temp\n'); return 0; }
  let output;
  try {
    fs.mkdirSync(paths.outputDir, { mode: 0o700 });
    const outPath = path.join(paths.outputDir, 'diagnostics.json');
    const loaded = loadInput(paths.input);
    output = loaded.status ? unavailable(loaded.status) : reduceTranscript(loaded.messages, {});
    const encoded = `${JSON.stringify(output)}\n`;
    if (Buffer.byteLength(encoded) > MAX_OUTPUT_BYTES) output = unavailable('output_limited');
    fs.writeFileSync(outPath, `${JSON.stringify(output)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`diagnostics_status=${output.availability}\n`);
    writeActionOutputs(paths.root, output.availability);
    return 0;
  } catch {
    process.stdout.write('diagnostics_status=write_failed\n');
    appendActionOutput('status=write_failed\n');
    return 0;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) process.exitCode = run();
