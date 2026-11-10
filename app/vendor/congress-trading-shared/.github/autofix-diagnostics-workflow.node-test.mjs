import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('./workflows/codex-autofix-reusable.yml', import.meta.url), 'utf8');
const steps = workflow.slice(workflow.indexOf('    steps:')).split(/\n      - /).slice(1);
const model = steps.find(step => step.includes('uses: anthropics/claude-code-action@'));
const reducer = steps.find(step => step.includes('id: diagnostics'));
const upload = steps.find(step => step.includes('uses: actions/upload-artifact@'));

test('failed model steps remain failed and diagnostics run afterward without raw logs', () => {
  assert(model && reducer && upload);
  assert(!model.includes('continue-on-error'));
  assert.match(model, /show_full_output: "false"/);
  assert.match(workflow, /--max-turns 120\n/);
  assert(steps.indexOf(model) < steps.indexOf(reducer));
  assert(steps.indexOf(reducer) < steps.indexOf(upload));
  assert.match(reducer, /if: \$\{\{ always\(\) \}\}/);
  assert.match(reducer, /uses: Simple-With-Us\/congress-trading-shared\/\.github\/actions\/autofix-diagnostics@[a-f0-9]{40}\s/);
});

test('failure artifacts contain only the reducer output and expire after seven days', () => {
  assert.match(upload, /if: \$\{\{ always\(\) && steps\.diagnostics\.outputs\.summary-path != '' \}\}/);
  assert.match(upload, /path: \$\{\{ steps\.diagnostics\.outputs\.summary-path \}\}\n/);
  assert.equal((upload.match(/\n\s+path:/g) || []).length, 1);
  assert(!upload.includes('claude-execution-output'));
  assert(!upload.includes('runner.temp'));
  assert.match(upload, /if-no-files-found: error/);
  assert.match(upload, /retention-days: 7\s*$/);
});
