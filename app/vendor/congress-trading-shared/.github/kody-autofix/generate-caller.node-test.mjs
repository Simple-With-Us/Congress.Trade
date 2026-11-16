import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { generateCaller, parseArguments, validateOptions, yamlString, PROFILES,
  DEFAULT_MODEL, DEFAULT_MODEL_BASE_URL, MODEL_BASE_URLS, MODEL_PATTERN } from './generate-caller.mjs';
import * as fleet from './fleet.mjs';

const valid = (overrides = {}) => ({'repository-id': '123456789', profile: 'web',
  'source-prefixes': '["src/","server/"]', 'shared-sha': 'a'.repeat(40), ...overrides});
const script = new URL('./generate-caller.mjs', import.meta.url);
const workflowPath = new URL('../workflows/kody-autofix-reusable.yml', import.meta.url);
const fleetWorkflowPath = new URL('../workflows/kody-fleet-autofix.yml', import.meta.url);
const yaml = await readFile(workflowPath, 'utf8');
const fleetYaml = await readFile(fleetWorkflowPath, 'utf8');
const job = (name) => {
  const section = yaml.split(`\n  ${name}:\n`)[1];
  assert(section, `Missing job ${name}`);
  return section.split(/\n  [a-z][a-z_-]*:\n/)[0];
};
const permissions = (section) => section.split('    permissions:\n')[1]?.split(/^    \S/m)[0];
const condition = (text) => text.split('    if: >-\n')[1]?.split(/^    \S/m)[0].trim();
const identityClauses = [
  "vars.SWU_KODY_AUTOFIX_ENABLED == 'true'",
  "github.event_name == 'check_run'", "github.event.action == 'completed'",
  'github.run_attempt == 1', 'github.event.check_run.app.id == 413034',
  "github.event.sender.type == 'Bot'", 'github.event.sender.id == 148880201',
  "github.event.sender.login == 'kody-ai[bot]'", "github.event.check_run.conclusion == 'success'",
  'github.event.check_run.pull_requests[0].number != null', 'github.event.check_run.pull_requests[1] == null',
];

test('offline caller defaults to no paid attempts and no implicit enablement', () => {
  const caller = generateCaller(valid());
  assert.match(caller, /daily_attempt_limit: 0\n/);
  assert.match(caller, /budget_policy_id: 'pending'\n/);
  assert.match(caller, /repository_id: '123456789'\n/);
  assert.match(caller, /source_prefixes: '\["src\/","server\/"\]'\n/);
  // The provider key is forwarded explicitly and only once; secrets are never inherited.
  assert(caller.endsWith("    secrets:\n      MODEL_API_KEY: ${{ secrets.MINIMAX_API_KEY }}\n      USAGE_INGEST_TOKEN: ${{ secrets.USAGE_INGEST_TOKEN }}\n"));
  // The only other forwarded secret is the optional Usage Monitor ingest token (UM-1593).
  assert.equal((caller.match(/secrets\./g) ?? []).length, 2);
  assert(!caller.includes('secrets: inherit'));
  assert.match(caller, /^name: Kody MiniMax M3 Fix Proposals$/m);
  assert.match(caller, /model: 'MiniMax-M3'\n/);
  assert.match(caller, /model_base_url: 'https:\/\/api\.minimax\.io\/v1'\n/);
  assert(!caller.includes('workflow_dispatch'));
  assert(!caller.includes('pull_request_review:'));
  assert(!caller.includes('issue_comment:'));
  assert.match(caller, /check_run:\n    types: \[completed\]/);
  assert.match(caller, /congress-trading-shared\/\.github\/workflows\/kody-autofix-reusable\.yml@a{40}/);
  assert.equal((caller.match(/^    uses:/gm) ?? []).length, 1);
});

test('caller and shared workflow both require every identity and event gate', () => {
  for (const text of [generateCaller(valid()), yaml]) {
    const clauses = condition(text).split('&&').map(value => value.trim());
    assert(!condition(text).includes('||'), 'Admission must not contain an OR bypass.');
    for (const clause of identityClauses) assert(clauses.includes(clause), `Missing admission clause ${clause}`);
  }
  assert(condition(yaml).includes('inputs.daily_attempt_limit > 0'));
  assert(condition(yaml).includes("inputs.budget_policy_id != 'pending'"));
  assert(condition(yaml).includes("inputs.profile != 'blocked'"));
});

test('profile is explicit rather than treating every repository as JavaScript', () => {
  for (const profile of PROFILES) assert.equal(validateOptions(valid({profile})).profile, profile);
  assert.equal(validateOptions(valid({profile:'blocked', 'source-prefixes':'[]'})).prefixes.length, 0);
  for (const profile of ['', 'javascript', 'unknown', '${{ secrets.KEY }}']) {
    assert.throws(() => generateCaller(valid({profile})));
  }
  assert.throws(() => generateCaller(valid({'source-prefixes':'[]'})));
  assert.match(generateCaller(valid({profile:'static', 'source-prefixes':'["index.html"]'})), /source_prefixes: '\["index.html"\]'/);
  assert.match(generateCaller(valid({profile:'python', 'source-prefixes':'["catalog.py"]'})), /source_prefixes: '\["catalog.py"\]'/);
  assert.throws(() => generateCaller(valid({profile:'web', 'source-prefixes':'["catalog.py"]'})));
  assert.throws(() => generateCaller(valid({'source-prefixes':JSON.stringify(Array.from({length:9}, (_, index) => `src${index}/`))})));
});

test('positive allocation requires all explicit approval arguments and never enables a caller', () => {
  for (const changes of [
    {'daily-attempt-limit':'1'},
    {'daily-attempt-limit':'1', 'budget-policy-id':'approved-budget'},
    {'daily-attempt-limit':'1', 'acknowledge-paid-attempts':true},
    {'daily-attempt-limit':'1', 'budget-policy-id':'pending', 'acknowledge-paid-attempts':true},
    {'acknowledge-paid-attempts':true},
    {'daily-attempt-limit':'1', 'budget-policy-id':'approved-budget', 'acknowledge-paid-attempts':'true'},
    {profile:'blocked', 'daily-attempt-limit':'1', 'budget-policy-id':'approved-budget', 'acknowledge-paid-attempts':true},
  ]) assert.throws(() => generateCaller(valid(changes)));
  const caller = generateCaller(valid({'daily-attempt-limit':'2', 'budget-policy-id':'approved-owner-20261005', 'acknowledge-paid-attempts':true}));
  assert.match(caller, /daily_attempt_limit: 2\n/);
  assert.match(caller, /budget_policy_id: 'approved-owner-20261005'/);
  assert(condition(caller).includes("vars.SWU_KODY_AUTOFIX_ENABLED == 'true'"));
  for (const value of ['-1', '1.5', '01', '1e2', 'Infinity', '6', '1000', '${{ 1 }}']) {
    assert.throws(() => generateCaller(valid({'daily-attempt-limit':value})));
  }
});

test('caller input is validated and YAML scalars are escaped without expression injection', () => {
  assert.equal(yamlString("a'b\"c"), "'a''b\"c'");
  for (const [key, values] of Object.entries({
    'repository-id':['', '0', '123\nsecrets: inherit', '${{ github.repository_id }}', '1e9', '9999999999999999', 123],
    'shared-sha':['main', 'v1', '0'.repeat(40), 'a'.repeat(39), 'a'.repeat(40)+'\n', 'A'.repeat(40)],
    'source-prefixes':['null', '{}', '[1]', '["../"]', '["src/../"]', '["/"]', '["src"]',
      '[".github/"]', '["src/.hidden/"]', '["src//"]', '["src/","src/"]', '["node_modules/"]',
      '["src/${{ secrets.KEY }}/"]', '["src/\\n  secrets: inherit/"]', '["src/quote\\\"/"]'],
    'budget-policy-id':['', 'approved-budget'.repeat(9), 'unapproved-policy', 'approved\nsecrets: inherit', '${{ secrets.KEY }}', "abc'def"],
  })) for (const value of values) assert.throws(() => generateCaller(valid({[key]:value})), `${key}: ${value}`);
  assert.throws(() => generateCaller({...valid(), unrelated:'no'}));
});

test('CLI argument parser rejects ambiguous, duplicate, missing and unknown options', () => {
  const args = Object.entries(valid()).flatMap(([key,value]) => [`--${key}`, value]);
  assert.deepEqual(parseArguments(args), valid());
  assert.throws(() => parseArguments([...args, '--profile', 'swift']));
  assert.throws(() => parseArguments([...args, '--unrecognized', 'x']));
  assert.throws(() => parseArguments(['--profile']));
  assert.throws(() => parseArguments(['--profile', '--shared-sha']));
  assert.throws(() => parseArguments(['web']));
  assert.throws(() => parseArguments(['--acknowledge-paid-attempts', '--acknowledge-paid-attempts']));
});

test('CLI produces YAML on stdout only, or fails without partial YAML', () => {
  const args = Object.entries(valid()).flatMap(([key,value]) => [`--${key}`, value]);
  const accepted = spawnSync(process.execPath, [script.pathname, ...args], {encoding:'utf8'});
  assert.equal(accepted.status, 0);
  assert.equal(accepted.stderr, '');
  assert.equal(accepted.stdout, generateCaller(valid()));
  const rejected = spawnSync(process.execPath, [script.pathname, '--repository-id', 'bad'], {encoding:'utf8'});
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /^Caller generation refused:/);
});

test('all dependency actions and shared helper checkouts use immutable pinned versions', () => {
  const expected = new Map([
    ['actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'],
    ['actions/setup-node', '949feb2413d6458794dcd2491c4babbbce0c15c1'],
    ['actions/upload-artifact', 'cf430e030ddbb5b0abf93d22962f4752f3646cd9'],
    ['actions/download-artifact', '9000827ccba6bdab643e8b6fd33ac0654aef8333'],
  ]);
  // The usage reporter (UM-1593) lives in this repository, so it is pinned to a published commit of its own.
  const reporter = 'Simple-With-Us/congress-trading-shared/.github/actions/ci-usage-report';
  for (const match of yaml.matchAll(/uses: ([^\s]+)@([^\s]+)/g)) {
    if (match[1] === reporter) assert.match(match[2], /^[a-f0-9]{40}$/, `Unpinned reporter ${match[0]}`);
    else assert.equal(match[2], expected.get(match[1]), `Unexpected action or pin ${match[0]}`);
  }
  assert.equal((yaml.match(/uses: Simple-With-Us\/congress-trading-shared\/\.github\/actions\/ci-usage-report@/g) ?? []).length, 1);
  const refs = [...yaml.matchAll(/ref: '([a-f0-9]{40})'/g)].map(match => match[1]);
  assert.equal(refs.length, 4);
  assert.equal(new Set(refs).size, 1);
  for (const name of ['prepare','reserve','generate','publish']) {
    assert.match(job(name), /repository: Simple-With-Us\/congress-trading-shared/);
    assert.match(job(name), /persist-credentials: false/);
    assert.match(job(name), /sparse-checkout: \.github\/kody-autofix/);
    assert(!job(name).includes('ref: ${{ github.sha }}'));
  }
  // The key-bearing job installs nothing global and runs no third-party CLI or install scripts.
  assert(!job('generate').includes('npm install'));
  assert(!job('generate').includes('claude-code'));
  assert(!yaml.includes('DEEPSEEK'));
});

test('split-privilege jobs never expose write credentials in generation', () => {
  assert.match(yaml, /^permissions: \{\}$/m);
  assert.match(permissions(job('prepare')), /contents: read/);
  assert.match(permissions(job('prepare')), /pull-requests: read/);
  assert.match(permissions(job('prepare')), /checks: read/);
  assert(!permissions(job('prepare')).includes('write'));
  assert.match(permissions(job('reserve')), /contents: write/);
  assert.match(permissions(job('reserve')), /pull-requests: read/);
  assert.match(permissions(job('generate')), /contents: read/);
  assert.match(permissions(job('generate')), /actions: read/);
  assert(!permissions(job('generate')).includes('write'));
  assert.match(permissions(job('publish')), /contents: write/);
  assert.match(permissions(job('publish')), /pull-requests: write/);
  assert(!job('generate').includes('GH_TOKEN:'));
  assert(!job('generate').includes('GITHUB_TOKEN:'));
  assert.equal((yaml.match(/GH_TOKEN:/g) ?? []).length, 3);
  // MODEL_API_KEY twice (required check and generation step) plus the optional ingest token in `meter`.
  assert.equal((yaml.match(/secrets\./g) ?? []).length, 3);
  assert.match(job('generate'), /environment: kody-autofix/);
  assert.match(job('generate'), /MODEL_API_KEY: \$\{\{ secrets\.MODEL_API_KEY \}\}/);
  assert.match(job('generate'), /KODY_MODEL: \$\{\{ inputs\.model \}\}/);
  assert.match(job('generate'), /KODY_MODEL_BASE_URL: \$\{\{ inputs\.model_base_url \}\}/);
  assert.match(yaml, /    secrets:\n      MODEL_API_KEY:\n        description: [^\n]+\n        required: true\n/);
  assert(!yaml.includes('secrets: inherit'));
  assert(!yaml.includes('GH_PAT'));
  // No GitHub credential is ever passed as a token input.  The one `token:` is the optional Usage Monitor
  // ingest credential, which only the key-free `meter` job sees, so it can neither push nor reach the provider key.
  assert.deepEqual(yaml.match(/token: \$\{\{ secrets\.[A-Z_]+ \}\}/g), ['token: ${{ secrets.USAGE_INGEST_TOKEN }}']);
  assert.match(job('meter'), /token: \$\{\{ secrets\.USAGE_INGEST_TOKEN \}\}/);
  assert.match(permissions(job('meter')), /^\s*actions: read\s*$/);
  assert(!permissions(job('meter')).includes('write'));
  assert(!job('meter').includes('MODEL_API_KEY'));
  assert(!job('meter').includes('environment:'));
  assert.match(yaml, /      USAGE_INGEST_TOKEN:\n        description: [^\n]+\n        required: false\n/);
});

test('generate requires a forwarded provider credential before checkout or scans', () => {
  const generation = job('generate');
  assert.match(generation, /- name: Require Forwarded Provider Credential\n/);
  assert(generation.indexOf('Require Forwarded Provider Credential') < generation.indexOf('Check Out Trusted Helper Only'));
  assert(generation.indexOf('Require Forwarded Provider Credential') < generation.indexOf('fleet.mjs scan '));
  assert.match(generation, /MODEL_API_KEY: \$\{\{ secrets\.MODEL_API_KEY \}\}/);
});

test('prepare does not request invalid GITHUB_TOKEN permission scopes', () => {
  const prepare = job('prepare');
  assert(!prepare.includes('environments:'));
  assert(!prepare.includes('Verify Host Spend Environment'));
});

test('verified fixed scanner runs before the sole provider-key step', () => {
  const generation = job('generate');
  assert.match(generation, /gitleaks\/releases\/download\/v8\.30\.1\/gitleaks_8\.30\.1_linux_x64\.tar\.gz/);
  assert.match(generation, /551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/);
  assert.match(generation, /sha256sum --check --strict/);
  assert(generation.indexOf('sha256sum --check --strict') < generation.indexOf('tar --extract'));
  assert(generation.indexOf('fleet.mjs scan ') < generation.indexOf('fleet.mjs generate '));
  const generateStep = generation.split('      - name: Generate One Bounded Proposal\n')[1].split('      - name:')[0];
  assert(generateStep.includes('secrets.MODEL_API_KEY'));
  assert(generation.indexOf('fleet.mjs generate ') < generation.indexOf('fleet.mjs scan-answer '));
  const answerScan = generation.split('      - name: Reject Secret-Bearing Generated Results\n')[1].split('      - uses:')[0];
  assert(!answerScan.includes('secrets.'));
  assert(!answerScan.includes('GH_TOKEN'));
  assert.match(generation, /kody-autofix\/answer-scan\.json/);
  const beforeContextScan = generation.slice(0, generation.indexOf('fleet.mjs scan '));
  assert.match(beforeContextScan, /Require Forwarded Provider Credential/);
});

test('artifact transport is run-scoped, required, short lived, and isolated under runner.temp', () => {
  // Context, reservation, and answer are required;  the usage counts are optional because a run that
  // failed before the provider answered has none.
  assert.equal((yaml.match(/retention-days: 1/g) ?? []).length, 4);
  assert.equal((yaml.match(/if-no-files-found: error/g) ?? []).length, 3);
  assert.equal((yaml.match(/if-no-files-found: ignore/g) ?? []).length, 1);
  for (const match of yaml.matchAll(/name: (kody-(?:context|reservation|answer|usage)-.*)/g)) {
    assert(match[1].includes('${{ github.run_id }}-${{ github.run_attempt }}'));
  }
  assert(!yaml.includes('merge-multiple: true'));
  assert(!yaml.includes('pattern:'));
  // Eight context transports, plus the usage upload (generate) and its download (meter).
  assert.equal((yaml.match(/path: \$\{\{ runner\.temp \}\}\/kody-autofix/g) ?? []).length, 10);
  assert.match(job('generate'), /- uses: actions\/upload-artifact@[a-f0-9]{40} # v7\.0\.2\n        if: always\(\)\n        with:\n          name: kody-usage-/);
  assert.match(job('meter'), /needs: \[prepare, generate\]/);
  assert.match(job('meter'), /if: \$\{\{ always\(\) && needs\.generate\.result != 'skipped' \}\}/);
  assert.match(job('reserve'), /needs: prepare/);
  assert.match(job('reserve'), /if: needs\.prepare\.outputs\.eligible == 'true'/);
  assert.match(job('generate'), /if: needs\.reserve\.outputs\.reserved == 'true'/);
  assert.match(job('publish'), /needs: \[prepare, reserve, generate\]/);
});

test('caller and callee concurrency cannot deadlock through an identical key', () => {
  const caller = generateCaller(valid());
  // One autofix per PR across every bot: the group is shared with PR Autofix and Claude Code Autofix.
  assert(caller.includes("group: pr-autofix-${{ github.repository }}-${{ github.event.check_run.pull_requests[0].number || github.event.check_run.id }}\n  cancel-in-progress: false\n"));
  assert(!yaml.includes('group: pr-autofix-'));
  assert.match(job('reserve'), /group: kody-reserve-.*needs\.prepare\.outputs\.utc_day/);
  assert.match(job('publish'), /group: kody-publish-.*needs\.prepare\.outputs\.pr_number/);
  assert.equal((yaml.match(/cancel-in-progress: false/g) ?? []).length, 2);
  assert(!yaml.includes('cancel-in-progress: true'));
  assert(!yaml.includes('pull_request_target'));
});


test('dedicated hosted validation runs only read-only offline tests on narrow paths', async () => {
  const validation = await readFile(new URL('../workflows/kody-autofix-validation.yml', import.meta.url), 'utf8');
  assert.match(validation, /permissions:\n  contents: read/);
  assert(!validation.includes('write'));
  assert(!validation.includes('secrets.'));
  assert(!validation.includes('pull_request_target'));
  assert.match(validation, /pull_request:\n    paths:/);
  assert.match(validation, /push:\n    paths:/);
  assert.match(validation, /node-version: 24/);
  assert.match(validation, /persist-credentials: false/);
  assert.match(validation, /run: node --test \.github\/kody-autofix\/\*\.node-test\.mjs/);
  assert(!validation.includes('claude-cli-fixture'));
  assert(!validation.includes('npm install'));
  assert(!validation.includes('fleet.mjs generate'));
  for (const match of validation.matchAll(/uses: ([^\s]+)@([^\s]+)/g)) assert.match(match[2], /^[a-f0-9]{40}$/);
});

test('provider model and endpoint options are validated and match the helper allowlist', () => {
  assert.equal(DEFAULT_MODEL, fleet.MODEL);
  assert.equal(DEFAULT_MODEL_BASE_URL, fleet.DEFAULT_MODEL_BASE_URL);
  assert.deepEqual([...MODEL_BASE_URLS], [...fleet.MODEL_BASE_URLS]);
  assert.equal(String(MODEL_PATTERN), String(fleet.MODEL_PATTERN));
  assert.match(yaml, /      model:\n[\s\S]*?default: MiniMax-M3\n/);
  assert.match(yaml, /      model_base_url:\n[\s\S]*?default: https:\/\/api\.minimax\.io\/v1\n/);
  assert.equal([...yaml.matchAll(/ref: 'd06ac2d47bc3b9182ea43deee9f0a91ffdf33ab0'/g)].length, 4);
  const native = generateCaller(valid({ model: 'muse-spark-1.3-contributor', 'model-base-url': 'https://api.meta.ai/v1' }));
  assert.match(native, /model: 'muse-spark-1\.3-contributor'\n      model_base_url: 'https:\/\/api\.meta\.ai\/v1'\n/);
  const oldGateway = generateCaller(valid({ model: 'minimax/minimax-m3', 'model-base-url': 'https://ai-gateway.vercel.sh/v1' }));
  assert.match(oldGateway, /model: 'minimax\/minimax-m3'\n      model_base_url: 'https:\/\/ai-gateway\.vercel\.sh\/v1'\n/);
  assert.match(oldGateway, /MODEL_API_KEY: \$\{\{ secrets\.VERCEL_AI_GATEWAY_API_KEY \}\}/);
  const oldMeta = generateCaller(valid({ model: 'muse-spark-1.3-contributor', 'model-base-url': 'https://api.meta.ai/v1' }));
  assert.match(oldMeta, /MODEL_API_KEY: \$\{\{ secrets\.VERCEL_AI_GATEWAY_API_KEY \}\}/);
  for (const url of ['https://ai-gateway.vercel.sh/v1', 'https://api.meta.ai/v1'])
    assert.throws(() => validateOptions(valid({ 'model-base-url': url })), /--model is required/);
  for (const model of ['', '../x', 'a/b/c', "x'y", '${{ secrets.KEY }}', 'x\nsecrets: inherit'])
    assert.throws(() => validateOptions(valid({ model })), /Model/);
  assert.equal(validateOptions(valid({ model: 'MiniMax-M3' })).model, 'MiniMax-M3');
  assert.match(generateCaller(valid({ model: 'MiniMax-M3', 'model-base-url': 'https://api.minimax.io/v1' })),
    /model: 'MiniMax-M3'\n      model_base_url: 'https:\/\/api\.minimax\.io\/v1'\n/);
  for (const url of ['', 'https://evil.example/v1', 'http://ai-gateway.vercel.sh/v1', 'https://ai-gateway.vercel.sh/v1/'])
    assert.throws(() => validateOptions(valid({ 'model-base-url': url })), /base URL/);
});

test('fleet caller pins the published MiniMax workflow without changing its display name', () => {
  assert.match(fleetYaml, /^name: Kody MiniMax M3 Fix Proposals$/m);
  assert.match(fleetYaml, /kody-autofix-reusable\.yml@488c83ee8ed7c1c8479769905f96cfb54e1cbbe9/);
  assert.match(fleetYaml, /model: 'MiniMax-M3'\n/);
  assert.match(fleetYaml, /model_base_url: 'https:\/\/api\.minimax\.io\/v1'\n/);
  assert.match(fleetYaml, /MODEL_API_KEY: \$\{\{ secrets\.MINIMAX_API_KEY \}\}/);
});
