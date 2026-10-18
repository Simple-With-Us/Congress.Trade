import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import * as fleet from './fleet.mjs';
import { parseProfile, assertSafeText } from './profiles.mjs';

// All GitHub requests and provider fetches are injected.  A missing mock fails closed.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Real network access is forbidden in this suite.');
process.on('exit', () => { globalThis.fetch = originalFetch; });
const { validateInput, validatePull, sourcePath, selectFindings, collectThreads, api,
  snapshot, budgetPolicy, reserve, validateReservation, validateScan, scanDirectory, applyEdits, generate, publish,
  providerFrom, chatRequest, requestEdits, usageSidecar, SYSTEM_PROMPT, MODEL_BASE_URLS, schema,
  startProxy, claudeArguments, fixBranch, attemptRef, KODY, LIMITS, MODEL, BUDGET_CLI_MODEL,
  BUDGET_PROXY_LIMITS } = fleet;
const head = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const blobSha = 'e'.repeat(40);
const repository = 'Simple-With-Us/Example';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const env = {
  GITHUB_REPOSITORY: repository, EXPECTED_REPOSITORY_ID: '1001',
  GITHUB_EVENT_NAME: 'check_run', GITHUB_RUN_ATTEMPT: '1', GITHUB_REF: 'refs/heads/main',
  CHECK_RUN_ID: '21', PROFILE: 'web', SOURCE_PREFIXES: '["src/"]',
  DAILY_ATTEMPT_LIMIT: '2', BUDGET_POLICY_ID: 'approved-fixture', GITHUB_RUN_ID: '9001',
};
const repositoryData = () => ({ id: 1001, full_name: repository, owner: { id: 336882244 },
  default_branch: 'main', fork: false, archived: false, private: false });
const check = () => ({ id: 21, app: { id: 413034 }, name: 'Kody Code Review', status: 'completed',
  conclusion: 'success', head_sha: head, pull_requests: [{ number: 123 }] });
const event = () => ({ repository: repositoryData(), action: 'completed',
  sender: { type: 'Bot', id: 148880201, login: 'kody-ai[bot]' }, check_run: check() });
const input = validateInput(env, event());
const pull = () => ({ state: 'open', draft: false, user: { type: 'User' },
  head: { repo: { full_name: repository, id: 1001 }, ref: 'feature/example', sha: head },
  base: { repo: { full_name: repository, id: 1001 }, ref: 'main' } });
const thread = (id = 1, path = 'src/example.ts') => ({
  id: `t${id}`, isResolved: false, isOutdated: false, diffSide: 'RIGHT', path, line: 1,
  comments: { nodes: [{ databaseId: id, body: 'Fix off by one.',
    url: `https://github.com/${repository}/pull/123#discussion_r${id}`, replyTo: null,
    commit: { oid: head }, originalCommit: { oid: head },
    author: { __typename: 'Bot', login: KODY.login, id: KODY.id } }] },
});
const packageData = () => ({ version: 1, result: 'eligible', ...structuredClone(input),
  branch: 'feature/example', tree: treeSha,
  findings: selectFindings([thread()], head, 'web', ['src/']),
  files: [{ path: 'src/example.ts', sha: blobSha, content: 'const n = 1;\n', digest: sha256('const n = 1;\n') }],
});
const answer = () => ({ edits: [{ path: 'src/example.ts', old_text: 'const n = 1;', new_text: 'const n = 2;' }] });
const fakeSecret = () => `ghp_${'a'.repeat(30)}`;
function httpError(status) { const e = new Error('Fixture API refusal.'); e.status = status; return e; }
function reservationFor(data = packageData(), now = Date.now(), overrides = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  return { version: 1, result: 'reserved', repository, repositoryId: '1001', number: 123, head,
    runId: env.GITHUB_RUN_ID, day, slotRef: `tags/swu-kody-budget/v1/${day}/1`,
    attemptRef: attemptRef(data), policyId: env.BUDGET_POLICY_ID,
    expiresAt: now + 15 * 60_000, snapshotDigest: sha256(JSON.stringify(data)), ...overrides };
}
function scanReceipt(data = packageData(), edits, now = Date.now(), overrides = {}) {
  return { tool: 'gitleaks', version: '8.30.1', snapshotDigest: sha256(JSON.stringify(data)),
    answerDigest: edits === undefined ? null : sha256(JSON.stringify(edits)), scannedAt: now, ...overrides };
}
function fixture() {
  const reads = [], writes = [], calls = [], refs = new Map(), threads = [thread()];
  const pr = pull(), metadata = repositoryData(), review = check();
  const options = { mode: '100644', type: 'blob', truncated: false, blob: Buffer.from('const n = 1;\n'),
    encoding: 'base64', moveOnRead: 0, prReads: 0, before: null, pages: null };
  const request = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (options.before) await options.before(path, method, body);
    if (method === 'POST' && path !== '/graphql') {
      writes.push({ path, method, body: structuredClone(body) });
      if (path === 'git/trees') return { sha: 'c'.repeat(40) };
      if (path === 'git/commits') return { sha: 'd'.repeat(40) };
      if (path === 'git/refs') {
        assert.equal(body.force, undefined, 'References must be create-only.');
        if (refs.has(body.ref.slice(5))) throw httpError(422);
        refs.set(body.ref.slice(5), body.sha);
        return { ref: body.ref, object: { sha: body.sha } };
      }
      if (path === 'pulls') return { number: 999, html_url: `https://github.com/${repository}/pull/999` };
      assert.fail(`Unexpected write: ${method} ${path}`);
    }
    assert(['GET', 'POST'].includes(method), `Unexpected mutating method: ${method}`);
    reads.push(path);
    if (path === '') return structuredClone(metadata);
    if (path === `check-runs/${review.id}` || /^check-runs\/\d+$/.test(path)) return structuredClone(review);
    if (path === 'pulls/123') {
      options.prReads++;
      const result = structuredClone(pr);
      if (options.moveOnRead && options.prReads >= options.moveOnRead) result.head.sha = 'f'.repeat(40);
      return result;
    }
    if (path.startsWith('git/ref/')) {
      const ref = path.slice('git/ref/'.length);
      if (!refs.has(ref)) throw httpError(404);
      return { ref: `refs/${ref}`, object: { sha: refs.get(ref) } };
    }
    if (path === '/graphql') {
      const page = options.pages ? options.pages(body.variables.cursor) :
        { nodes: structuredClone(threads), pageInfo: { hasNextPage: false, endCursor: null } };
      return { data: { repository: { pullRequest: { reviewThreads: page } } } };
    }
    if (path === `git/commits/${head}`) return { tree: { sha: treeSha } };
    if (path === `git/trees/${treeSha}?recursive=1`) return { truncated: options.truncated,
      tree: [{ path: 'src/example.ts', type: options.type, mode: options.mode, size: options.blob.length, sha: blobSha }] };
    if (path === `git/blobs/${blobSha}`) return { encoding: options.encoding, content: options.blob.toString('base64') };
    assert.fail(`Unexpected mocked API read: ${path}`);
  };
  const seedReservation = (data, now) => {
    const reservation = reservationFor(data, now);
    refs.set(reservation.slotRef, head); refs.set(reservation.attemptRef, head);
    return reservation;
  };
  return { request, calls, reads, writes, refs, threads, pr, metadata, review, options, seedReservation };
}

test('successful completed Kody event on the exact trusted repo/default branch is admitted', () => {
  assert.deepEqual(input, { repository, repositoryId: '1001', number: 123, head,
    checkId: 21, defaultBranch: 'main', profile: 'web', prefixes: ['src/'] });
  const privateEvent = event(); privateEvent.repository.private = true;
  assert.deepEqual(validateInput(env, privateEvent), input);
  const custom = event(); custom.repository.default_branch = 'trunk';
  assert.equal(validateInput({ ...env, GITHUB_REF: 'refs/heads/trunk' }, custom).defaultBranch, 'trunk');
});
test('forged event, sender, app, repository, check identity, and untrusted workflow runs are rejected', () => {
  for (const mutate of [
    e => e.action = 'created', e => e.sender.type = 'User', e => e.sender.id = 1,
    e => e.sender.login = 'kody-ai', e => e.sender = null,
    e => e.repository.owner.id = 1, e => e.repository.id = 1002,
    e => e.repository.full_name = 'Simple-With-Us/Other', e => e.repository.fork = true,
    e => e.repository.archived = true, e => e.check_run.app.id = 1,
    e => e.check_run.status = 'in_progress', e => e.check_run.conclusion = 'neutral',
    e => e.check_run.conclusion = 'failure', e => e.check_run.name = 'Impersonation',
    e => e.check_run.head_sha = 'abc', e => e.check_run.id = 22,
    e => e.check_run.pull_requests = [], e => e.check_run.pull_requests.push({ number: 124 }),
    e => e.check_run.pull_requests[0].number = '123', e => e.check_run.pull_requests[0].number = 0,
  ]) { const data = event(); mutate(data); assert.throws(() => validateInput(env, data)); }
  for (const [key, value] of Object.entries({ GITHUB_REPOSITORY: 'attacker/Example',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/pull/123/merge',
    GITHUB_RUN_ATTEMPT: '2', EXPECTED_REPOSITORY_ID: '1002', CHECK_RUN_ID: '22' })) {
    assert.throws(() => validateInput({ ...env, [key]: value }, event()), key);
  }
});
test('fork, bot, draft, closed, moved-head, other-base, and fixer-loop PRs are rejected', () => {
  assert.equal(validatePull(pull(), input), 'feature/example');
  for (const mutate of [p => p.state = 'closed', p => p.draft = true, p => p.user.type = 'Bot',
    p => p.head.repo = null, p => p.head.repo.full_name = 'attacker/Example',
    p => p.base.repo.full_name = 'Simple-With-Us/Other', p => p.head.sha = 'b'.repeat(40),
    p => p.base.ref = 'release', p => p.head.ref = 'main',
    p => p.head.ref = 'codex/kody-fix-pr-9-a', p => p.head.ref = 'swu/kody-fix-pr-9-a']) {
    const data = pull(); mutate(data); assert.throws(() => validatePull(data, input));
  }
  for (const value of [undefined, null, 123, {}]) {
    const data = pull(); data.head.ref = value;
    assert.throws(() => validatePull(data, input), /Malformed/);
  }
});
test('profile parsing allows only explicit exact files or directory prefixes', () => {
  assert.deepEqual(parseProfile('web', '["src/","main.ts"]'), { profile: 'web', prefixes: ['src/', 'main.ts'] });
  assert.deepEqual(parseProfile('blocked', '[]'), { profile: 'blocked', prefixes: [] });
  for (const [profile, prefixes] of [['ruby', '["src/"]'], ['web', '[]'], ['web', '{}'],
    ['web', 'null'], ['web', '["../src/"]'], ['web', '["src/../lib/"]'],
    ['web', '["src//"]'], ['web', '["src/.hidden/"]'], ['web', '["/src/"]'],
    ['web', JSON.stringify(Array(9).fill('src/'))], ['web', '[7]']]) {
    assert.throws(() => parseProfile(profile, prefixes), `${profile} ${prefixes}`);
  }
});
test('web, Swift, Python, and static profiles enforce extensions and exact scope boundaries', () => {
  for (const [profile, paths] of Object.entries({ web: ['src/a.ts', 'src/a.tsx', 'src/a.js', 'src/a.mjs', 'src/a.css'],
    swift: ['src/App.swift'], python: ['src/app.py'], static: ['src/index.html', 'src/a.css', 'src/a.js', 'src/a.mjs'] })) {
    for (const path of paths) assert(sourcePath(path, profile, ['src/']), path);
  }
  assert(sourcePath('main.ts', 'web', ['main.ts']));
  for (const path of ['main.ts.extra.ts', 'main.ts/a.ts', 'src/a.ts', 'main.tsx']) assert(!sourcePath(path, 'web', ['main.ts']), path);
  for (const path of ['src-other/a.ts', 'src/a.py', 'src/a.swift', 'src/a.html']) assert(!sourcePath(path, 'web', ['src/']), path);
  assert(!sourcePath('src/a.ts', 'blocked', ['src/']));
  assert(!sourcePath('src/a.ts', 'unknown', ['src/']));
});
test('source scope excludes hidden paths, traversal, operational/security/payment files', () => {
  for (const path of ['../src/a.ts', '/src/a.ts', 'src/../a.ts', 'src//a.ts', 'src/.hidden/a.ts',
    '.github/workflows/a.yml', 'src/a.ts\n', 'src\\a.ts', 'src/a.json',
    ...['secret', 'secrets', 'credentials', 'config', 'secret-map', 'knob-map', 'auth', 'authentication',
      'authorization', 'billing', 'payment', 'payments', 'migrations', 'vendor', 'generated', 'fixture',
      'fixtures', 'casks', 'formula', 'infisical', 'storage', 'network', 'rotation'].map(name => `src/${name}/a.ts`)]) {
    assert(!sourcePath(path, 'web', ['src/']), path);
  }
});
test('only exact current Kody root findings qualify and findings remain bounded', () => {
  for (const mutate of [t => t.isResolved = true, t => t.isOutdated = true,
    t => t.comments.nodes[0].author.id = 'imposter', t => t.comments.nodes[0].author.login = 'other',
    t => t.comments.nodes[0].author.__typename = 'User', t => t.diffSide = 'LEFT',
    t => t.comments.nodes[0].originalCommit.oid = 'b'.repeat(40), t => t.comments.nodes[0].commit.oid = 'b'.repeat(40),
    t => t.comments.nodes[0].replyTo = { id: 'reply' }, t => t.path = 'src/auth/a.ts', t => t.line = null,
    t => t.line = 0, t => t.comments.nodes = [], t => t.comments.nodes[0].body = 'x'.repeat(12001)]) {
    const data = thread(); mutate(data); assert.deepEqual(selectFindings([data], head, 'web', ['src/']), []);
  }
  assert.equal(selectFindings([thread()], head, 'web', ['src/']).length, 1);
  assert.equal(selectFindings(Array.from({ length: 20 }, (_, i) => thread(i)), head, 'web', ['src/']).length, LIMITS.findings);
  assert.equal(new Set(selectFindings(Array.from({ length: 20 }, (_, i) => thread(i, `src/a${i}.ts`)), head, 'web', ['src/']).map(f => f.path)).size, LIMITS.files);
});
test('review collection paginates beyond one hundred comments with stable order', async () => {
  const cursors = [];
  const result = await collectThreads(async (_query, variables) => {
    cursors.push(variables.cursor);
    return { repository: { pullRequest: { reviewThreads: { nodes: cursors.length === 1 ?
      Array.from({ length: 100 }, (_, i) => thread(i + 1)) : [thread(101)],
    pageInfo: { hasNextPage: cursors.length === 1, endCursor: 'next' } } } } };
  }, 'Simple-With-Us', 'Example', 123);
  assert.equal(result.length, 101); assert.deepEqual(cursors, [null, 'next']);
});
test('malformed, repeated, missing, and overlong pagination fail closed', async () => {
  for (const pageInfo of [{ hasNextPage: true, endCursor: null }, { hasNextPage: true, endCursor: 'same' }]) {
    await assert.rejects(collectThreads(async () => ({ repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo } } } }), 'Simple-With-Us', 'Example', 123), /pagination/);
  }
  await assert.rejects(collectThreads(async () => ({}), 'Simple-With-Us', 'Example', 123), /Incomplete/);
  let page = 0;
  await assert.rejects(collectThreads(async () => ({ repository: { pullRequest: { reviewThreads: {
    nodes: [], pageInfo: { hasNextPage: true, endCursor: String(++page) } } } } }), 'Simple-With-Us', 'Example', 123), /safety bound/);
  assert.equal(page, 50);
});
test('GitHub API wrapper uses exact repo-relative endpoints, errors, and redirect refusal', async () => {
  const calls = [];
  const request = api('fixture-token', repository, async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://api.github.com/graphql') return new Response(JSON.stringify({ data: { ok: true } }));
    if (url === `https://api.github.com/repos/${repository}`) return new Response(JSON.stringify(repositoryData()));
    if (url === `https://api.github.com/repos/${repository}/pulls/123`) return new Response(JSON.stringify(pull()));
    return new Response('{}');
  });
  await request(''); await request('pulls/123'); await request('/graphql', 'POST', { query: 'fixture' });
  assert.deepEqual(calls.map(c => c.url), [`https://api.github.com/repos/${repository}`, `https://api.github.com/repos/${repository}/pulls/123`, 'https://api.github.com/graphql']);
  for (const call of calls) assert.equal(call.options.redirect, 'error');
  await assert.rejects(request('https://attacker.invalid/'), /Unexpected API path/);
  const denied = api('fixture-token', repository, async () => new Response('{}', { status: 403 }));
  await assert.rejects(denied('pulls/123'), e => e.status === 403);
  const incomplete = api('fixture-token', repository, async () => new Response('{"errors":[{}]}'));
  await assert.rejects(incomplete('/graphql', 'POST', {}), /Incomplete/);
});
test('snapshot includes only reviewed scoped source and allows same-org private metadata', async () => {
  const f = fixture(); f.metadata.private = true;
  assert.deepEqual(await snapshot(f.request, input), packageData());
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.reads.slice(0, 3), ['', 'check-runs/21', 'pulls/123']);
});
test('snapshot revalidates repository metadata and the completed successful Kody check', async () => {
  for (const mutate of [f => f.metadata.id = 1002, f => f.metadata.full_name = 'attacker/Example',
    f => f.metadata.default_branch = 'release', f => f.metadata.archived = true, f => f.metadata.fork = true,
    f => f.review.app.id = 1, f => f.review.status = 'in_progress', f => f.review.conclusion = 'failure',
    f => f.review.name = 'Fake review', f => f.review.head_sha = 'c'.repeat(40),
    f => f.review.pull_requests = [], f => f.review.pull_requests[0].number = 124]) {
    const f = fixture(); mutate(f); await assert.rejects(snapshot(f.request, input)); assert.equal(f.writes.length, 0);
  }
});
test('blocked profile, unsupported finding path, and stale review send no source or writes', async () => {
  const blocked = fixture();
  assert.deepEqual(await snapshot(blocked.request, { ...input, profile: 'blocked', prefixes: [] }), { result: 'profile_blocked' });
  for (const mutate of [f => f.threads[0].isResolved = true, f => f.threads[0].isOutdated = true,
    f => f.threads[0].path = 'src/auth/session.ts', f => f.threads[0].comments.nodes[0].commit.oid = 'f'.repeat(40)]) {
    const f = fixture(); mutate(f);
    assert.deepEqual(await snapshot(f.request, input), { result: 'no_eligible_findings_or_paths' });
    assert(!f.reads.some(path => path.startsWith('git/blobs/'))); assert.equal(f.writes.length, 0);
  }
});
test('snapshot refuses existing proposals, symlinks, gitlinks, executable files, and incomplete trees', async () => {
  const existing = fixture(); existing.refs.set(`heads/${fixBranch(input)}`, head);
  await assert.rejects(snapshot(existing.request, input), /proposal already exists/);
  for (const mode of ['120000', '160000', '100755']) {
    const f = fixture(); f.options.mode = mode; await assert.rejects(snapshot(f.request, input), /ordinary source/);
  }
  const badType = fixture(); badType.options.type = 'tree'; await assert.rejects(snapshot(badType.request, input), /ordinary source/);
  const truncated = fixture(); truncated.options.truncated = true; await assert.rejects(snapshot(truncated.request, input), /Incomplete source tree/);
});
test('snapshot rejects binary, invalid UTF-8, wrong encoding, oversized source, and secret-looking source/reviews', async () => {
  for (const blob of [Buffer.from([0, 65]), Buffer.from([0xff]), Buffer.alloc(LIMITS.fileBytes + 1, 65), Buffer.from(fakeSecret())]) {
    const f = fixture(); f.options.blob = blob; await assert.rejects(snapshot(f.request, input)); assert.equal(f.writes.length, 0);
  }
  const encoding = fixture(); encoding.options.encoding = 'utf-8'; await assert.rejects(snapshot(encoding.request, input));
  const review = fixture(); review.threads[0].comments.nodes[0].body = fakeSecret();
  await assert.rejects(snapshot(review.request, input), /Sensitive-looking/); assert.equal(review.writes.length, 0);
  for (const value of [`sk-${'b'.repeat(24)}`, '-----BEGIN PRIVATE KEY-----', `AKIA${'A'.repeat(16)}`, 'https://user:password@example.invalid/']) assert.throws(() => assertSafeText(value), /Sensitive-looking/);
});
test('daily budget defaults to disabled and caps approval at five', () => {
  assert.deepEqual(budgetPolicy({}), { limit: 0, id: 'pending' });
  assert.deepEqual(budgetPolicy({ DAILY_ATTEMPT_LIMIT: '5', BUDGET_POLICY_ID: 'approved-fixture' }), { limit: 5, id: 'approved-fixture' });
  assert.deepEqual(budgetPolicy({ DAILY_ATTEMPT_LIMIT: '3', BUDGET_POLICY_ID: 'pending' }), { limit: 0, id: 'pending' });
  for (const value of ['6', '-1', '1.0', '01', 'Infinity', '', ' 1', '100']) assert.throws(() => budgetPolicy({ ...env, DAILY_ATTEMPT_LIMIT: value }), /0 through 5/);
  for (const value of ['yes', 'approved-', 'approved-has spaces', `approved-${'a'.repeat(65)}`]) assert.throws(() => budgetPolicy({ ...env, BUDGET_POLICY_ID: value }), /approved allocation/);
});
test('zero or pending budgets perform no API reads or writes', async () => {
  for (const settings of [{}, { ...env, DAILY_ATTEMPT_LIMIT: '0' }, { ...env, BUDGET_POLICY_ID: 'pending' }]) {
    let calls = 0;
    assert.deepEqual(await reserve(async () => { calls++; assert.fail('Disabled budgets must be inert.'); }, packageData(), settings), { result: 'budget_pending' });
    assert.equal(calls, 0);
  }
});
test('reservation creates one durable daily slot and a separate create-only PR/head marker', async () => {
  const f = fixture(), data = packageData(), now = Date.UTC(2026, 9, 5, 12);
  const reservation = await reserve(f.request, data, env, now);
  assert.deepEqual(reservation, reservationFor(data, now));
  assert.deepEqual(f.writes.map(w => w.body.ref), [`refs/${reservation.slotRef}`, `refs/${attemptRef(data)}`]);
  assert(f.writes.every(w => w.method === 'POST' && w.path === 'git/refs' && w.body.sha === head));
});
test('repeat checks with new check-run IDs cannot retry the same PR/head', async () => {
  const f = fixture(), data = packageData();
  await reserve(f.request, data, env);
  const writes = f.writes.length;
  assert.deepEqual(await reserve(f.request, { ...data, checkId: 22 }, { ...env, CHECK_RUN_ID: '22' }), { result: 'attempt_already_reserved' });
  assert.equal(f.writes.length, writes); assert.equal(attemptRef(data), attemptRef({ ...data, checkId: 22 }));
});
test('existing daily slots consume budget and hard-cap writes never exceed five slot attempts', async () => {
  const f = fixture(), now = Date.UTC(2026, 9, 5, 12), day = '2026-10-05';
  for (let i = 1; i <= 5; i++) f.refs.set(`tags/swu-kody-budget/v1/${day}/${i}`, head);
  assert.deepEqual(await reserve(f.request, packageData(), { ...env, DAILY_ATTEMPT_LIMIT: '5' }, now), { result: 'daily_attempt_cap_reached' });
  assert.equal(f.writes.length, 5); assert(!f.refs.has(attemptRef(input)));
});
test('concurrent slot create conflicts are checked and the next approved slot is used', async () => {
  const f = fixture(), now = Date.UTC(2026, 9, 5, 12);
  f.refs.set('tags/swu-kody-budget/v1/2026-10-05/1', head);
  const reservation = await reserve(f.request, packageData(), env, now);
  assert.equal(reservation.slotRef, 'tags/swu-kody-budget/v1/2026-10-05/2');
  assert.equal(f.writes.length, 3);
});
test('concurrent duplicate-head reservations cannot both authorize provider calls', async () => {
  const f = fixture(), data = packageData();
  const results = await Promise.all([reserve(f.request, data, env), reserve(f.request, data, env)]);
  assert.equal(results.filter(r => r.result === 'reserved').length, 1);
  assert.equal(results.filter(r => r.result === 'attempt_already_reserved').length, 1);
});
test('unverified create conflict and uncertain provider-independent API errors are not retried', async () => {
  for (const status of [422, 403, 429, 500, undefined]) {
    const f = fixture(); let writes = 0;
    f.options.before = async (path, method) => {
      if (path === 'git/refs' && method === 'POST') { writes++; throw httpError(status); }
    };
    await assert.rejects(reserve(f.request, packageData(), env)); assert.equal(writes, 1);
  }
});
test('uncertain attempt-marker failure spends the daily slot and does not refund or retry', async () => {
  const f = fixture(); let attemptCreates = 0;
  f.options.before = async (path, method, body) => {
    if (path === 'git/refs' && method === 'POST' && body.ref.includes('swu-kody-attempt')) {
      attemptCreates++; throw httpError(500);
    }
  };
  await assert.rejects(reserve(f.request, packageData(), env));
  assert.equal(attemptCreates, 1);
  assert.equal([...f.refs.keys()].filter(ref => ref.includes('swu-kody-budget')).length, 1);
  assert(f.calls.every(c => c.method !== 'DELETE' && c.method !== 'PATCH'));
});
test('reservation binds repo, PR/head, run, exact snapshot, and canonical ref names', () => {
  const data = packageData(), now = Date.UTC(2026, 9, 5, 12), reservation = reservationFor(data, now);
  validateReservation(reservation, data, env, now);
  for (const overrides of [{ result: 'budget_pending' }, { repository: 'Simple-With-Us/Other' }, { repositoryId: '1002' },
    { number: 124 }, { head: 'f'.repeat(40) }, { runId: '9002' }, { snapshotDigest: 'changed' },
    { attemptRef: `${reservation.attemptRef}-check-22` }, { slotRef: reservation.slotRef.replace('/1', '/6') }]) {
    assert.throws(() => validateReservation({ ...reservation, ...overrides }, data, env, now));
  }
  const changed = structuredClone(data); changed.findings[0].body = 'Changed review';
  assert.throws(() => validateReservation(reservation, changed, env, now));
});
test('reservation expires in fifteen minutes and cannot cross UTC midnight', () => {
  const data = packageData(), now = Date.UTC(2026, 9, 5, 23, 55), reservation = reservationFor(data, now);
  validateReservation(reservation, data, env, now + 4 * 60_000);
  assert.throws(() => validateReservation(reservation, data, env, now + 15 * 60_000), /UTC day|Expired/);
  assert.throws(() => validateReservation(reservation, data, env, Date.UTC(2026, 9, 6)), /UTC day/);
  assert.throws(() => validateReservation({ ...reservation, expiresAt: now + 16 * 60_000 }, data, env, now), /Expired/);
  assert.throws(() => validateReservation({ ...reservation, expiresAt: NaN }, data, env, now), /Expired/);
});
test('disabled, revoked, mismatched, or reduced budget policies invalidate reservations', () => {
  const data = packageData(), now = Date.now(), reservation = reservationFor(data, now);
  for (const settings of [{ ...env, DAILY_ATTEMPT_LIMIT: '0' }, { ...env, BUDGET_POLICY_ID: 'pending' },
    { ...env, BUDGET_POLICY_ID: 'approved-other' }]) {
    assert.throws(() => validateReservation(reservation, data, settings, now));
  }
  assert.throws(() => validateReservation({ ...reservation, slotRef: reservation.slotRef.replace(/\/1$/, '/2') }, data, { ...env, DAILY_ATTEMPT_LIMIT: '1' }, now));
});
test('literal scoped replacements require one unique original match and bounded patch size', () => {
  assert.deepEqual(applyEdits(packageData(), answer()), [{ path: 'src/example.ts', content: 'const n = 2;\n' }]);
  const literal = answer(); literal.edits[0].new_text = '$&';
  assert.equal(applyEdits(packageData(), literal)[0].content, '$&\n');
  for (const mutate of [a => a.extra = true, a => a.edits = [], a => a.edits[0].path = 'src/other.ts',
    a => a.edits[0].old_text = '', a => a.edits[0].old_text = 'not found', a => a.edits[0].new_text = '\0',
    a => a.edits[0].new_text = 'x'.repeat(LIMITS.replacementBytes), a => a.edits[0].command = 'bad',
    a => a.edits[0].new_text = a.edits[0].old_text]) {
    const data = answer(); mutate(data); assert.throws(() => applyEdits(packageData(), data));
  }
  const duplicate = packageData(); duplicate.files[0].content += duplicate.files[0].content;
  assert.throws(() => applyEdits(duplicate, answer()), /exactly once/);
  const overlap = packageData(); overlap.files[0].content = '===';
  const edit = answer(); edit.edits[0].old_text = '==';
  assert.throws(() => applyEdits(overlap, edit), /exactly once/);
});
test('edits cannot overlap, escape profile scope, or reach unrelated distant code', () => {
  const edits = answer(); edits.edits.push({ ...edits.edits[0] });
  assert.throws(() => applyEdits(packageData(), edits), /Overlapping/);
  const distant = packageData(); distant.files[0].content = '\n'.repeat(99) + distant.files[0].content;
  assert.throws(() => applyEdits(distant, answer()), /neighborhood/);
  const escaped = packageData(); escaped.prefixes = ['other/'];
  assert.throws(() => applyEdits(escaped, answer()), /escaped/);
});
test('generation rejects missing, expired, or snapshot-mismatched reservation before any provider call', async () => {
  const data = packageData(); let calls = 0;
  const fetcher = async () => { calls++; assert.fail('Provider calls must be refused.'); };
  for (const reservation of [null, { result: 'budget_pending' }, reservationFor(data, Date.now() - 16 * 60_000),
    reservationFor(data, Date.now(), { snapshotDigest: 'wrong' })]) {
    await assert.rejects(generate(data, '/tmp/not-written-fleet-answer.json', { ...env, MODEL_API_KEY: 'fixture-only' }, reservation, scanReceipt(data), fetcher));
  }
  assert.equal(calls, 0);
});
test('publication creates only a new branch and a draft stacked on the original source branch', async () => {
  const f = fixture(), data = await snapshot(f.request, input), reservation = f.seedReservation(data);
  const result = await publish(f.request, data, answer(), input, reservation, env, scanReceipt(data, answer()));
  assert.equal(result.number, 999); assert.equal(f.writes.length, 4);
  assert.deepEqual(f.writes.map(w => w.path), ['git/trees', 'git/commits', 'git/refs', 'pulls']);
  assert.deepEqual(f.writes[1].body.parents, [head]);
  assert.equal(f.writes[2].body.ref, `refs/heads/${fixBranch(input)}`);
  assert.equal(f.writes[3].body.draft, true); assert.equal(f.writes[3].body.base, 'feature/example');
  assert.equal(f.writes[3].body.maintainer_can_modify, false);
  assert(!f.calls.some(c => /merge|resolve|dispatch/.test(c.path) || ['PATCH', 'PUT', 'DELETE'].includes(c.method)));
});
test('changed head, review, repository, check, reservation ref, or proposal blocks publication before writing', async () => {
  for (const mutate of [f => f.refs.set(`heads/${fixBranch(input)}`, head), f => f.threads[0].isResolved = true,
    f => f.threads[0].comments.nodes[0].body = 'Changed finding text', f => f.pr.head.sha = 'f'.repeat(40),
    f => f.review.conclusion = 'failure', f => f.metadata.default_branch = 'release',
    (f, r) => f.refs.set(r.attemptRef, 'f'.repeat(40)), (f, r) => f.refs.delete(r.slotRef)]) {
    const f = fixture(), data = await snapshot(f.request, input), reservation = f.seedReservation(data);
    mutate(f, reservation);
    await assert.rejects(publish(f.request, data, answer(), input, reservation, env, scanReceipt(data, answer())));
    assert.equal(f.writes.length, 0);
  }
});
test('publication refuses secret-looking generated source before any write', async () => {
  const f = fixture(), data = await snapshot(f.request, input), reservation = f.seedReservation(data), edits = answer();
  edits.edits[0].new_text = fakeSecret();
  await assert.rejects(publish(f.request, data, edits, input, reservation, env, scanReceipt(data, edits)), /Sensitive-looking/);
  assert.equal(f.writes.length, 0);
});
test('late concurrent source push prevents branch creation without force or rollback', async () => {
  const f = fixture(), data = await snapshot(f.request, input), reservation = f.seedReservation(data);
  f.options.moveOnRead = 3;
  await assert.rejects(publish(f.request, data, answer(), input, reservation, env, scanReceipt(data, answer())), /head moved/);
  assert.deepEqual(f.writes.map(w => w.path), ['git/trees', 'git/commits']);
});
test('provider configuration accepts only reviewed endpoints and strict model identifiers', () => {
  assert.equal(MODEL, 'MiniMax-M3');
  assert.deepEqual(providerFrom({}), { url: 'https://api.minimax.io/v1/chat/completions', model: MODEL });
  assert.deepEqual(providerFrom({ KODY_MODEL_BASE_URL: 'https://api.meta.ai/v1', KODY_MODEL: 'muse-spark-1.3-contributor' }),
    { url: 'https://api.meta.ai/v1/chat/completions', model: 'muse-spark-1.3-contributor' });
  assert.deepEqual(providerFrom({ KODY_MODEL_BASE_URL: 'https://api.minimax.io/v1', KODY_MODEL: 'MiniMax-M3' }),
    { url: 'https://api.minimax.io/v1/chat/completions', model: 'MiniMax-M3' });
  assert.deepEqual(providerFrom({ KODY_MODEL_BASE_URL: 'https://ai-gateway.vercel.sh/v1', KODY_MODEL: 'minimax/minimax-m3' }),
    { url: 'https://ai-gateway.vercel.sh/v1/chat/completions', model: 'minimax/minimax-m3' });
  assert.deepEqual([...MODEL_BASE_URLS], ['https://api.minimax.io/v1', 'https://ai-gateway.vercel.sh/v1', 'https://api.meta.ai/v1']);
  for (const url of ['https://evil.example/v1', 'http://ai-gateway.vercel.sh/v1', 'https://ai-gateway.vercel.sh/v1/',
    'https://ai-gateway.vercel.sh.evil.example/v1', 'https://user@ai-gateway.vercel.sh/v1', 'https://api.deepseek.com/anthropic'])
    assert.throws(() => providerFrom({ KODY_MODEL_BASE_URL: url }), /base URL/);
  for (const model of ['../x', 'a/b/c', 'x y', '${{ secrets.KEY }}', 'a'.repeat(70), '-x', 'meta/.x'])
    assert.throws(() => providerFrom({ KODY_MODEL: model }), /model identifier/);
});
test('chat request is tool-free, bounded, schema-shaped, and carries only approved source', () => {
  const data = packageData(); const body = chatRequest(MODEL, data);
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'stream', 'thinking']);
  assert.equal(body.max_tokens, LIMITS.outputTokens); assert.equal(body.stream, false);
  assert.equal(body.reasoning_split, undefined);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.tools, undefined); assert.equal(body.tool_choice, undefined);
  assert.equal(body.messages[0].content, SYSTEM_PROMPT);
  assert(SYSTEM_PROMPT.includes(JSON.stringify(schema)));
  assert.match(SYSTEM_PROMPT, /JSON INSTANCE as your answer, never a JSON Schema/);
  assert.match(SYSTEM_PROMPT, /\{"edits":\[\{"path":"<source path>","old_text":"<exact existing source text>","new_text":"<replacement source text>"\}\]\}/);
  assert.match(SYSTEM_PROMPT, /top-level object must have only the key "edits"; do not return schema-definition keys such as "type", "properties", or "required"/);
  assert.deepEqual(JSON.parse(body.messages[1].content), { findings: data.findings, files: data.files.map(({ path, content }) => ({ path, content })) });
  assert.equal(body.response_format, undefined);
  const gatewayRequest = chatRequest(MODEL, data, 'https://ai-gateway.vercel.sh/v1');
  assert.equal(gatewayRequest.messages[0].content, SYSTEM_PROMPT);
  assert.equal(gatewayRequest.thinking, undefined);
  assert.equal(gatewayRequest.reasoning_split, undefined);
  assert.deepEqual(gatewayRequest.response_format.json_schema.schema, schema);
});
test('scan receipt pins tool version, exact snapshot/answer, and fifteen-minute freshness', () => {
  const data = packageData(), edits = answer(), now = Date.now();
  validateScan(scanReceipt(data, undefined, now), data, undefined, now);
  validateScan(scanReceipt(data, edits, now), data, edits, now);
  for (const receipt of [undefined, {}, scanReceipt(data, undefined, now, { tool: 'other' }),
    scanReceipt(data, undefined, now, { version: '8.30.0' }),
    scanReceipt(data, undefined, now, { snapshotDigest: 'wrong' }),
    scanReceipt(data, undefined, now, { scannedAt: now - 15 * 60_000 - 1 }),
    scanReceipt(data, undefined, now, { scannedAt: now + 30_001 }),
    scanReceipt(data, undefined, now, { scannedAt: 'now' })]) {
    assert.throws(() => validateScan(receipt, data, undefined, now));
  }
  assert.throws(() => validateScan(scanReceipt(data, edits, now), data, undefined, now));
  assert.throws(() => validateScan(scanReceipt(data, undefined, now), data, edits, now));
  const changed = answer(); changed.edits[0].new_text = 'const n = 3;';
  assert.throws(() => validateScan(scanReceipt(data, edits, now), data, changed, now));
});
test('generation refuses absent, stale, or changed-context scan receipts without a provider request', async () => {
  const data = packageData(), reservation = reservationFor(data); let calls = 0;
  const fetcher = async () => { calls++; assert.fail('Provider calls must be refused.'); };
  for (const receipt of [undefined, {}, scanReceipt(data, undefined, Date.now() - 16 * 60_000),
    scanReceipt(data, undefined, Date.now(), { snapshotDigest: 'wrong' })]) {
    await assert.rejects(generate(data, '/tmp/not-written-fleet-answer.json', { ...env, MODEL_API_KEY: 'fixture-only' }, reservation, receipt, fetcher));
  }
  assert.equal(calls, 0);
});
test('publication refuses absent, stale, wrong-answer scan receipt and revoked budget before any API call', async () => {
  const data = packageData(), edits = answer(), reservation = reservationFor(data);
  for (const [settings, receipt] of [[env, undefined], [env, {}],
    [env, scanReceipt(data, edits, Date.now() - 16 * 60_000)], [env, scanReceipt(data)],
    [{ ...env, DAILY_ATTEMPT_LIMIT: '0' }, scanReceipt(data, edits)],
    [{ ...env, BUDGET_POLICY_ID: 'pending' }, scanReceipt(data, edits)]]) {
    let calls = 0;
    await assert.rejects(publish(async () => { calls++; assert.fail('Invalid approval must not reach GitHub.'); },
      data, edits, input, reservation, settings, receipt));
    assert.equal(calls, 0);
  }
});
async function scannerFixture(callback, status = 0) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-offline-scanner-'));
  const scanner = join(dir, 'scanner'), capture = join(dir, 'capture.json');
  const script = `#!${process.execPath}\nimport { readFileSync, readdirSync, writeFileSync } from 'node:fs';\n` +
    `import { join } from 'node:path';
import http from 'node:http';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';\n` +
    `const args=process.argv.slice(2);\n` +
    `writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,env:process.env,texts:readdirSync(args[1]).map(name=>readFileSync(join(args[1],name),'utf8'))}));\n` +
    `process.exit(${status});\n`;
  try {
    await writeFile(scanner, script); await chmod(scanner, 0o700);
    await writeFile(join(dir, 'snapshot.json'), JSON.stringify(packageData()));
    await writeFile(join(dir, 'answer.json'), JSON.stringify(answer()));
    await callback({ dir, scanner, capture });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
test('source scanner sees only bounded source/review text and writes an exact digest receipt', async () => {
  await scannerFixture(async ({ dir, scanner, capture }) => {
    const receipt = await scanDirectory(dir, 'source', scanner);
    validateScan(receipt, packageData());
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'scan.json'), 'utf8')), receipt);
    const scan = JSON.parse(await readFile(capture, 'utf8'));
    assert.deepEqual(scan.texts.sort(), ['const n = 1;\n', 'Fix off by one.'].sort());
    assert.equal(scan.args[0], 'dir');
    for (const arg of ['--redact=100', '--ignore-gitleaks-allow', '--no-banner', '--exit-code=1', '--config']) assert(scan.args.includes(arg));
    assert(scan.args[scan.args.indexOf('--config') + 1].endsWith('/gitleaks.toml'));
    assert.equal(scan.env.HOME, scan.args[1]);
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'MODEL_API_KEY', 'ANTHROPIC_API_KEY']) assert.equal(scan.env[key], undefined);
    await assert.rejects(access(scan.args[1]));
  });
});
test('answer scanner scans reconstructed changed source and binds the exact patch', async () => {
  await scannerFixture(async ({ dir, scanner, capture }) => {
    const receipt = await scanDirectory(dir, 'answer', scanner);
    validateScan(receipt, packageData(), answer());
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'answer-scan.json'), 'utf8')), receipt);
    const scan = JSON.parse(await readFile(capture, 'utf8'));
    assert.deepEqual(scan.texts, ['const n = 2;\n']);
    await assert.rejects(access(scan.args[1]));
  });
});
test('scanner refusal or missing executable never yields a fresh approval receipt', async () => {
  await scannerFixture(async ({ dir, scanner, capture }) => {
    await assert.rejects(scanDirectory(dir, 'source', scanner), /Secret scan failed/);
    await assert.rejects(access(join(dir, 'scan.json')));
    const scan = JSON.parse(await readFile(capture, 'utf8'));
    await assert.rejects(access(scan.args[1]));
    await assert.rejects(scanDirectory(dir, 'source', join(dir, 'missing-scanner')), /Secret scan failed/);
    await assert.rejects(access(join(dir, 'scan.json')));
  }, 1);
});
test('secret-looking source and malicious scoped patches fail before scanner execution', async () => {
  await scannerFixture(async ({ dir, scanner, capture }) => {
    const data = packageData(); data.files[0].content = fakeSecret();
    await writeFile(join(dir, 'snapshot.json'), JSON.stringify(data));
    await assert.rejects(scanDirectory(dir, 'source', scanner), /Sensitive-looking/);
    await assert.rejects(access(capture)); await assert.rejects(access(join(dir, 'scan.json')));
    await writeFile(join(dir, 'snapshot.json'), JSON.stringify(packageData()));
    const edits = answer(); edits.edits[0].path = 'src/auth/session.ts';
    await writeFile(join(dir, 'answer.json'), JSON.stringify(edits));
    await assert.rejects(scanDirectory(dir, 'answer', scanner), /escaped/);
    await assert.rejects(access(capture)); await assert.rejects(access(join(dir, 'answer-scan.json')));
  });
});

const provider = { url: 'https://ai-gateway.vercel.sh/v1/chat/completions', model: MODEL };
const completion = (content, extra = {}) => new Response(JSON.stringify({ model: MODEL,
  base_resp: { status_code: 0, status_msg: 'success' },
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], ...extra }),
{ headers: { 'content-type': 'application/json' } });
test('provider request is one bounded call with the key only in its authorization header', async () => {
  const calls = []; const edits = answer();
  const result = await requestEdits('fixture-only', provider, chatRequest(MODEL, packageData(), 'https://ai-gateway.vercel.sh/v1'), async (url, options) => {
    calls.push({ url, options }); return completion(JSON.stringify(edits));
  });
  assert.deepEqual(result, edits); assert.equal(calls.length, 1); assert.equal(LIMITS.requests, 1);
  const [{ url, options }] = calls;
  assert.equal(url, provider.url); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
  assert(options.signal instanceof AbortSignal);
  assert.deepEqual(options.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-only' });
  assert(!options.body.includes('fixture-only'));
  assert.equal(JSON.parse(options.body).max_tokens, LIMITS.outputTokens);
  assert.equal(JSON.parse(options.body).reasoning_split, undefined);
});
test('native MiniMax-M3 disables thinking and validates base_resp before parsing edits', async () => {
  const minimax = { url: 'https://api.minimax.io/v1/chat/completions', model: 'MiniMax-M3' };
  const request = chatRequest(minimax.model, packageData(), 'https://api.minimax.io/v1');
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.equal(request.reasoning_split, undefined);
  assert.equal(request.messages[0].content, SYSTEM_PROMPT);
  assert(request.messages[0].content.includes(JSON.stringify(schema)));
  assert.equal(request.response_format, undefined);
  const otherNativeModel = chatRequest('MiniMax-M3.1-Flash-Preview', packageData(), 'https://api.minimax.io/v1');
  assert.equal(otherNativeModel.reasoning_split, true);
  assert.equal(otherNativeModel.thinking, undefined);
  const gatewayMiniMax = chatRequest('minimax/minimax-m3', packageData(), 'https://ai-gateway.vercel.sh/v1');
  assert.equal(gatewayMiniMax.reasoning_split, undefined);
  assert.equal(gatewayMiniMax.thinking, undefined);
  assert.deepEqual(gatewayMiniMax.response_format.json_schema.schema, schema);
  const edits = answer(); const reports = [];
  const success = completion(JSON.stringify(edits), { model: minimax.model,
    base_resp: { status_code: 0, status_msg: 'success' } });
  assert.deepEqual(await requestEdits('fixture-only', minimax, request, async () => success, report => reports.push(report)), edits);
  assert.equal(reports.length, 0);
  const editsWithCodeFence = answer(); editsWithCodeFence.edits[0].new_text = 'const note = "```";';
  const rawWithCodeFence = completion(JSON.stringify(editsWithCodeFence), { model: minimax.model,
    base_resp: { status_code: 0, status_msg: 'success' } });
  assert.deepEqual(await requestEdits('fixture-only', minimax, request, async () => rawWithCodeFence), editsWithCodeFence);
  const fenced = completion(` \n\`\`\`json\n${JSON.stringify(edits)}\n\`\`\` \t`, { model: minimax.model,
    base_resp: { status_code: 0, status_msg: 'success' } });
  assert.deepEqual(await requestEdits('fixture-only', minimax, request, async () => fenced), edits);
  const plainFence = completion(`\`\`\`\n${JSON.stringify(edits)}\n\`\`\``, { model: minimax.model,
    base_resp: { status_code: 0, status_msg: 'success' } });
  assert.deepEqual(await requestEdits('fixture-only', minimax, request, async () => plainFence), edits);

  const failure = completion('<think>must not parse edits</think>', { model: minimax.model,
    base_resp: { status_code: 1008, status_msg: 'sensitive provider detail' } });
  await assert.rejects(requestEdits('fixture-provider-secret', minimax, request, async () => failure,
    report => reports.push(report)), /MiniMax rejected/);
  assert.deepEqual(JSON.parse(reports[0]), { event: 'kody_pilot.provider_rejected', keyRef: 'MODEL_API_KEY',
    provider: 'minimax', status: 1008 });
  assert(!reports[0].includes('sensitive provider detail'));
  assert(!reports[0].includes('fixture-provider-secret'));

  for (const base_resp of [undefined, null, 'success', {}, { status_code: '0', status_msg: 'success' },
    { status_code: 0, status_msg: 2 }]) {
    const response = completion(JSON.stringify(edits), { model: minimax.model, base_resp });
    const log = [];
    await assert.rejects(requestEdits('fixture-only', minimax, request, async () => response,
      report => log.push(report)), /invalid response/);
    assert.deepEqual(JSON.parse(log[0]), { event: 'kody_pilot.provider_rejected', keyRef: 'MODEL_API_KEY',
      provider: 'minimax', status: 'malformed_base_resp' });
  }
  for (const content of [
    `prefix\n\`\`\`json\n${JSON.stringify(edits)}\n\`\`\``,
    `\`\`\`json\n${JSON.stringify(edits)}\n\`\`\`\nsuffix`,
    `\`\`\`json\n${JSON.stringify(edits)}\n\`\`\`\n\`\`\``,
    `<think>reasoning</think>${JSON.stringify(edits)}`,
  ]) {
    const response = completion(content, { model: minimax.model,
      base_resp: { status_code: 0, status_msg: 'success' } });
    await assert.rejects(requestEdits('fixture-only', minimax, request, async () => response), /malformed JSON/);
  }
});
test('missing key and oversized requests are refused before any provider call', async () => {
  let calls = 0; const fetcher = async () => { calls++; return completion('{}'); };
  await assert.rejects(requestEdits('', provider, chatRequest(MODEL, packageData(), 'https://ai-gateway.vercel.sh/v1'), fetcher), /MODEL_API_KEY/);
  await assert.rejects(requestEdits('fixture-only', provider, { model: MODEL, padding: 'x'.repeat(LIMITS.requestBytes) }, fetcher), /bound/);
  assert.equal(calls, 0);
});
test('credential, payment, permission, and quota refusals report status only without raw error disclosure', async () => {
  for (const status of [401, 402, 403, 429]) {
    let calls = 0; const reports = [];
    await assert.rejects(requestEdits('fixture-provider-secret', provider, chatRequest(MODEL, packageData(), 'https://ai-gateway.vercel.sh/v1'), async () => {
      calls++; return new Response('sensitive upstream error', { status });
    }, report => reports.push(report)), error => !error.message.includes('sensitive') && !error.message.includes('fixture-provider-secret'));
    assert.equal(calls, 1); assert.equal(reports.length, 1);
    assert.deepEqual(JSON.parse(reports[0]), { event: 'kody_pilot.provider_rejected', keyRef: 'MODEL_API_KEY', status });
    assert(!reports[0].includes('fixture-provider-secret')); assert(!reports[0].includes('sensitive upstream error'));
  }
  const reports = [];
  await assert.rejects(requestEdits('fixture-only', provider, chatRequest(MODEL, packageData(), 'https://ai-gateway.vercel.sh/v1'),
    async () => new Response('server detail', { status: 500 }), report => reports.push(report)), /no proposal/);
  assert.equal(reports.length, 0);
});
test('expired or revoked approval at request time prevents even a mocked provider call', async () => {
  let calls = 0;
  await assert.rejects(requestEdits('fixture-only', provider, chatRequest(MODEL, packageData(), 'https://ai-gateway.vercel.sh/v1'),
    async () => { calls++; return completion('{}'); }, () => {}, () => { throw new Error('Approval expired.'); }), /expired/);
  assert.equal(calls, 0);
});
test('empty, truncated, multi-choice, non-JSON, and oversized provider answers are rejected', async () => {
  const cases = [
    completion(''), completion('   '), completion('not json'), completion(null),
    new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify(answer()) } }] })),
    new Response(JSON.stringify({ choices: [] })),
    new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }, { finish_reason: 'stop', message: { content: '{}' } }] })),
    new Response('not json at all'),
    new Response('x'.repeat(LIMITS.outputBytes + 1)),
  ];
  for (const response of cases)
    await assert.rejects(requestEdits('fixture-only', provider, chatRequest(MODEL, packageData(), 'https://ai-gateway.vercel.sh/v1'), async () => response));
});
test('generation writes only a validated answer and never sends GitHub or unrelated credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-offline-generate-'));
  const data = packageData(), edits = answer(); const calls = [];
  try {
    await generate(data, join(dir, 'answer.json'), { ...env, PATH: '/fixture/bin',
      MODEL_API_KEY: 'fixture-provider-secret', GH_TOKEN: 'fixture-github-secret',
      ANTHROPIC_API_KEY: 'fixture-inherited-secret' }, reservationFor(data), scanReceipt(data),
    async (url, options) => { calls.push({ url, options }); return completion(JSON.stringify(edits)); });
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'answer.json'), 'utf8')), edits);
    assert.equal(calls.length, 1);
    const sent = JSON.stringify(calls[0]);
    for (const secret of ['fixture-github-secret', 'fixture-inherited-secret']) assert(!sent.includes(secret));
    assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-provider-secret');
    const escaped = answer(); escaped.edits[0].path = 'src/other.ts';
    await assert.rejects(generate(data, join(dir, 'escaped.json'), { ...env, MODEL_API_KEY: 'fixture-only' },
      reservationFor(data), scanReceipt(data), async () => completion(JSON.stringify(escaped))));
    await assert.rejects(access(join(dir, 'escaped.json')));
    await assert.rejects(generate(data, join(dir, 'bad-url.json'), { ...env, MODEL_API_KEY: 'fixture-only',
      KODY_MODEL_BASE_URL: 'https://evil.example/v1' }, reservationFor(data), scanReceipt(data),
    async () => assert.fail('Unreviewed endpoints must never be called.')), /base URL/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('usage sidecar reports the provider usage block as counts only', async () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200,
    prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 50 } };
  assert.deepEqual(usageSidecar({ model: 'MiniMax-M3', usage, choices: [{ finish_reason: 'stop' }] }, provider, 321), {
    schema: 1, model: 'MiniMax-M3', inputTokens: 600, outputTokens: 200, cacheReadTokens: 400, reasoningTokens: 50,
    durationMs: 321, outcome: 'complete' });
  assert.equal(usageSidecar({ model: 'x' }, provider, 1), null);
  assert.equal(usageSidecar({ usage: [] }, provider, 1), null);
  const hostile = usageSidecar({ usage: { prompt_tokens: -1, completion_tokens: 'many', prompt_tokens_details: { cached_tokens: 9 } },
    choices: [{ finish_reason: 'length' }] }, provider, -4);
  assert.deepEqual(hostile, { schema: 1, model: MODEL, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
    durationMs: 0, outcome: 'incomplete' });
  assert(!JSON.stringify(usageSidecar({ usage, choices: [{ message: { content: 'ANSWER-TEXT' } }] }, provider, 1)).includes('ANSWER-TEXT'));
});
test('usage is recorded before validation can reject the answer and a failing recorder changes nothing', async () => {
  const seen = [];
  const withUsage = (content, finish = 'stop') => completion(content, { usage: { prompt_tokens: 10, completion_tokens: 5 },
    choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }] });
  const request = chatRequest(MODEL, packageData(), 'https://ai-gateway.vercel.sh/v1');
  await assert.rejects(requestEdits('fixture-only', provider, request, async () => withUsage('{"edits":[]}', 'length'), console.error, () => {},
    (result, ms) => seen.push([result.usage.completion_tokens, ms >= 0])), /did not finish/);
  assert.deepEqual(seen, [[5, true]]);
  const edits = answer();
  assert.deepEqual(await requestEdits('fixture-only', provider, request, async () => withUsage(JSON.stringify(edits)), console.error, () => {},
    () => { throw new Error('recorder broke'); }), edits);
});
test('generation leaves a usage sidecar beside the answer, even when the answer is then rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-offline-usage-'));
  const data = packageData(), edits = answer();
  const withUsage = (content) => completion(content, { usage: { prompt_tokens: 120, completion_tokens: 30 } });
  try {
    await generate(data, join(dir, 'answer.json'), { ...env, MODEL_API_KEY: 'fixture-only' }, reservationFor(data), scanReceipt(data),
      async () => withUsage(JSON.stringify(edits)));
    const sidecar = JSON.parse(await readFile(join(dir, 'usage.json'), 'utf8'));
    assert.equal(sidecar.inputTokens, 120); assert.equal(sidecar.outputTokens, 30); assert.equal(sidecar.outcome, 'complete');
    assert(!JSON.stringify(sidecar).includes('fixture-only'));
    await rm(join(dir, 'usage.json'));
    const escaped = answer(); escaped.edits[0].path = 'src/other.ts';
    await assert.rejects(generate(data, join(dir, 'escaped.json'), { ...env, MODEL_API_KEY: 'fixture-only' },
      reservationFor(data), scanReceipt(data), async () => withUsage(JSON.stringify(escaped))));
    assert.equal(JSON.parse(await readFile(join(dir, 'usage.json'), 'utf8')).outputTokens, 30);
    await rm(join(dir, 'usage.json'));
    await generate(data, join(dir, 'answer.json'), { ...env, MODEL_API_KEY: 'fixture-only' }, reservationFor(data), scanReceipt(data),
      async () => completion(JSON.stringify(edits)));
    await assert.rejects(access(join(dir, 'usage.json')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('CLI configuration removes tools, hooks, session state, and unrelated settings', () => {
  const args = claudeArguments();
  assert(args.includes('--bare')); assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert(args.includes('--strict-mcp-config')); assert(args.includes('--no-session-persistence'));
  assert(args.includes('--no-chrome')); assert(!args.includes('--dangerously-skip-permissions'));
  assert.equal(args[args.indexOf('--model') + 1], BUDGET_CLI_MODEL);
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '0.50');
});

// Exercise the proxy handler with synthetic streams, never a listening socket.
async function withInMemoryServer(callback) {
  const original = http.createServer; let handler;
  const server = { once() { return this; }, listen(_port, host, done) {
    assert.equal(host, '127.0.0.1'); queueMicrotask(done);
  }, address() { return { port: 12345 }; }, closeAllConnections() {}, close(done) { done(); } };
  http.createServer = callback => { handler = callback; return server; };
  syncBuiltinESMExports();
  const request = async (body, options = {}) => {
    const req = Readable.from([Buffer.from(options.raw ?? JSON.stringify(body))]);
    req.method = options.method ?? 'POST'; req.url = options.path ?? '/v1/messages';
    const response = { status: null, body: '', headersSent: false,
      writeHead(status) { this.status = status; this.headersSent = true; },
      write(chunk) { this.body += Buffer.from(chunk).toString(); },
      end(chunk) { if (chunk) this.body += String(chunk); } };
    await handler(req, response); return response;
  };
  try { await callback(request); }
  finally { http.createServer = original; syncBuiltinESMExports(); }
}
test('in-memory proxy rejects unrelated routes and hard-caps request count before the budget gateway', async () => {
  await withInMemoryServer(async request => {
    const calls = [];
    const proxy = await startProxy({ request: async body => {
      calls.push(body); return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    } });
    try {
      assert.equal((await request({}, { path: '/evil' })).status, 400);
      assert.equal((await request({}, { method: 'GET' })).status, 400);
      assert.equal((await request({ model: 'other' })).status, 429);
      assert.equal((await request({}, { raw: 'x'.repeat(LIMITS.requestBytes + 1) })).status, 413);
      for (let n = 0; n < BUDGET_PROXY_LIMITS.requests; n++) assert.equal((await request({ model: BUDGET_CLI_MODEL })).status, 200);
      assert.equal((await request({ model: BUDGET_CLI_MODEL })).status, 429);
      assert.equal(calls.length, BUDGET_PROXY_LIMITS.requests);
      assert.equal((await request({}, { raw: 'invalid-json' })).status, 502);
    } finally { await proxy.close(); }
  });
});
test('missing gateway and ambiguous budget/provider failures lock the proxy without raw error disclosure', async () => {
  for (const gateway of [null, { request: async () => { throw new Error('sensitive upstream error'); } }]) {
    await withInMemoryServer(async request => {
      const proxy = await startProxy(gateway);
      try {
        const first = await request({ model: BUDGET_CLI_MODEL });
        assert.equal(first.status, 502); assert(!first.body.includes('sensitive'));
        assert.equal((await request({ model: BUDGET_CLI_MODEL })).status, 502);
      } finally { await proxy.close(); }
    });
  }
});
test('expired or revoked approval at proxy request time prevents even a mocked gateway call', async () => {
  await withInMemoryServer(async request => {
    let calls = 0;
    const proxy = await startProxy({ request: async () => { calls++; return new Response('{}'); } },
      () => { throw new Error('Approval expired.'); });
    try { assert.equal((await request({ model: BUDGET_CLI_MODEL })).status, 502); assert.equal(calls, 0); }
    finally { await proxy.close(); }
  });
});
test('generation remains disabled before CLI launch even with otherwise valid local receipts', async () => {
  const data = packageData();
  await assert.rejects(generate(data, '/tmp/not-written-disabled-budget.json', { ...env, DEEPSEEK_API_KEY: 'fixture-only' },
    reservationFor(data), scanReceipt(data), async () => assert.fail('No network allowed.')), /gateway is disabled|MODEL_API_KEY/);
});
test('generation uses only approved source and a credential-free CLI environment with fake processes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-offline-generate-budget-'));
  const originalSpawn = childProcess.spawn; const launched = [];
  const data = packageData(), edits = answer();
  childProcess.spawn = (command, args, options) => {
    launched.push({ command, args, options });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = new EventEmitter();
    child.stdin.end = text => {
      launched.at(-1).prompt = JSON.parse(text);
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ is_error: false, structured_output: edits })));
        child.emit('close', 0);
      });
    };
    return child;
  };
  syncBuiltinESMExports();
  try {
    await withInMemoryServer(async () => {
      await generate(data, join(dir, 'answer.json'), { ...env, PATH: '/fixture/bin',
        SWU_KODY_FLEET_BUDGET_ENABLED: 'true', FLEET_BUDGET_URL: 'https://usage.jays.services/api/ingest/fleet-budget',
        FLEET_BUDGET_TOKEN: 'synthetic-budget-token-for-offline-tests-only',
        DEEPSEEK_API_KEY: 'fixture-provider-secret', GH_TOKEN: 'fixture-github-secret',
        ANTHROPIC_API_KEY: 'fixture-inherited-secret' }, reservationFor(data), scanReceipt(data),
      async () => assert.fail('Synthetic child must not call a provider.'));
    });
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'answer.json'), 'utf8')), edits);
    assert.equal(launched.length, 1); const child = launched[0];
    assert.equal(child.command, 'claude'); assert.deepEqual(child.args, claudeArguments());
    assert.deepEqual(child.prompt, { findings: data.findings, files: data.files.map(({ path, content }) => ({ path, content })) });
    assert.equal(child.options.env.ANTHROPIC_API_KEY, 'pilot-proxy');
    assert.equal(child.options.env.FLEET_BUDGET_TOKEN, undefined); assert.equal(child.options.env.MINIMAX_API_KEY, undefined);
    assert.equal(child.options.env.GH_TOKEN, undefined); assert.equal(child.options.env.DEEPSEEK_API_KEY, undefined);
    assert.equal(child.options.env.HOME, child.options.cwd);
    assert(child.options.env.ANTHROPIC_BASE_URL.startsWith('http://127.0.0.1:'));
    await assert.rejects(access(child.options.cwd));
  } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true }); }
});
test('source push after branch creation prevents PR publication and never force-updates the branch', async () => {
  const f = fixture(), data = await snapshot(f.request, input), reservation = f.seedReservation(data);
  f.options.moveOnRead = 4;
  await assert.rejects(publish(f.request, data, answer(), input, reservation, env, scanReceipt(data, answer())), /head moved/);
  assert.deepEqual(f.writes.map(w => w.path), ['git/trees', 'git/commits', 'git/refs']);
  assert(f.calls.every(c => !['PATCH', 'PUT', 'DELETE'].includes(c.method)));
});
test('uncertain publication writes are attempted once, with no merge, ref replacement, or rollback', async () => {
  for (const target of ['git/trees', 'git/commits', 'git/refs', 'pulls']) {
    const f = fixture(), data = await snapshot(f.request, input), reservation = f.seedReservation(data);
    let attempts = 0;
    f.options.before = async (path, method) => {
      if (path === target && method === 'POST') { attempts++; throw httpError(500); }
    };
    await assert.rejects(publish(f.request, data, answer(), input, reservation, env, scanReceipt(data, answer())));
    assert.equal(attempts, 1); assert(f.calls.every(c => !['PATCH', 'PUT', 'DELETE'].includes(c.method)));
  }
});

test('reservation expiry during snapshot reread prevents every publication write', async () => {
  const realNow = Date.now, startedAt = Date.UTC(2026, 9, 5, 12); let now = startedAt;
  Date.now = () => now;
  try {
    const f = fixture(), data = await snapshot(f.request, input), reservation = f.seedReservation(data, startedAt);
    const receipt = scanReceipt(data, answer(), startedAt);
    f.options.before = async (path, method) => {
      if (method === 'GET' && path === `git/blobs/${blobSha}`) now += 16 * 60_000;
    };
    await assert.rejects(publish(f.request, data, answer(), input, reservation, env, receipt), /Expired/);
    assert.equal(f.writes.length, 0);
  } finally { Date.now = realNow; }
});
test('scan expiry during snapshot reread prevents every publication write', async () => {
  const realNow = Date.now, startedAt = Date.UTC(2026, 9, 5, 12); let now = startedAt;
  Date.now = () => now;
  try {
    const f = fixture(), data = await snapshot(f.request, input), reservation = f.seedReservation(data, startedAt);
    const receipt = scanReceipt(data, answer(), startedAt - 14 * 60_000);
    f.options.before = async (path, method) => {
      if (method === 'GET' && path === `git/blobs/${blobSha}`) now += 2 * 60_000;
    };
    await assert.rejects(publish(f.request, data, answer(), input, reservation, env, receipt), /Expired secret scan/);
    assert.equal(f.writes.length, 0);
  } finally { Date.now = realNow; }
});

test('approval expiry after each awaited write or freshness read stops subsequent publication writes', async () => {
  for (const kind of ['reservation', 'scan']) {
    for (const boundary of ['after-tree', 'after-commit', 'before-ref', 'before-pull']) {
      const realNow = Date.now, startedAt = Date.UTC(2026, 9, 5, 12); let now = startedAt;
      Date.now = () => now;
      try {
        const f = fixture(), data = await snapshot(f.request, input), reservation = f.seedReservation(data, startedAt);
        const receipt = scanReceipt(data, answer(), kind === 'scan' ? startedAt - 14 * 60_000 : startedAt);
        f.options.before = async (path, method) => {
          if ((boundary === 'after-tree' && method === 'POST' && path === 'git/trees') ||
            (boundary === 'after-commit' && method === 'POST' && path === 'git/commits') ||
            (boundary === 'before-ref' && method === 'GET' && path === 'pulls/123' && f.options.prReads === 2) ||
            (boundary === 'before-pull' && method === 'GET' && path === 'pulls/123' && f.options.prReads === 3)) {
            now = startedAt + (kind === 'scan' ? 2 : 16) * 60_000;
          }
        };
        await assert.rejects(publish(f.request, data, answer(), input, reservation, env, receipt), /Expired/, `${kind} ${boundary}`);
        assert.equal(f.writes.length, { 'after-tree': 1, 'after-commit': 2, 'before-ref': 2, 'before-pull': 3 }[boundary], `${kind} ${boundary}`);
      } finally { Date.now = realNow; }
    }
  }
});

test('normalized camelCase, PascalCase, acronyms, and snake_case cannot evade sensitivity exclusions', () => {
  for (const path of ['src/myAuth.ts', 'src/getOAuth.ts', 'src/FooOAuth.ts', 'src/authenticate.ts',
    'src/authorize.ts', 'src/SessionProvider.tsx', 'src/cookieStore.ts', 'src/paymentProcessor.ts',
    'src/configLoader.ts', 'src/node_modules/package/index.js', 'src/myCredentials.ts']) {
    assert(!sourcePath(path, 'web', ['src/']), path);
  }
  for (const path of ['src/auth_service.py', 'src/config_helpers.py', 'src/oauth_client.py', 'src/my_auth_module.py',
    'src/session_store.py', 'src/cookie_manager.py', 'src/payment_service.py']) {
    assert(!sourcePath(path, 'python', ['src/']), path);
  }
  assert(!sourcePath('src/AuthenticationService.swift', 'swift', ['src/']));
  for (const path of ['src/author.ts', 'src/authoring.ts', 'src/configurable.ts', 'src/networkingDiagram.ts']) {
    assert(sourcePath(path, 'web', ['src/']), path);
  }
});
