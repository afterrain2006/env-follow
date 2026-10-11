const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseUpdates, checkOutcome, CommandError } = require('../dist/core.js');
const { renderMaintenance } = require('../dist/render.js');

test('update parser preserves installed and available versions and rejects unknown schemas', () => {
  assert.deepEqual(parseUpdates([{ name: 'Requests', version: '2.32.3', latest_version: '2.34.2', latest_filetype: 'wheel' }]), [{ name: 'requests', version: '2.32.3', latest: '2.34.2' }]);
  for (const raw of [{}, [{ name: '--evil', version: '1', latest_version: '2' }], [{ name: 'foo', version: '1' }], [{ name: 'foo', version: '1', latest_version: '2' }, { name: 'Foo', version: '1', latest_version: '2' }]]) assert.throws(() => parseUpdates(raw));
});
test('health checks distinguish incompatible dependencies from execution errors', () => {
  const conflict = new CommandError('uv', ['pip', 'check'], '', 'Found 1 incompatibility\nrequests requires idna, but it is not installed', 1);
  assert.match(checkOutcome(conflict), /idna/);
  for (const error of [new CommandError('uv', [], '', 'unsupported command', 1), new CommandError('uv', [], '', 'Found 1 incompatibility', 2), new Error('spawn failed')]) assert.throws(() => checkOutcome(error));
});
test('maintenance renderer escapes package output and offers upgrades only for project dependencies', () => {
  const base = { root: 'example', checkedAt: '2026-10-11T00:00:00Z', fingerprint: 'example' };
  const state = { inspection: { manifest: { declared: [{ name: 'requests' }], lockExists: true } } };
  const html = renderMaintenance(state, {
    tree: { ...base, name: 'urllib3', forward: '<script>bad()</script>', reverse: 'urllib3\n└── requests' },
    health: { ...base, status: 'issues', output: '<img src=x> Missing idna' },
    updates: { ...base, items: [{ name: 'requests', version: '2.32.3', latest: '2.34.2' }, { name: 'urllib3', version: '2', latest: '3' }] }
  });
  assert.ok(!html.includes('<script>') && !html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('哪些包依赖它'));
  assert.ok(html.includes('发现依赖兼容性问题'));
  assert.ok(html.includes('data-action="upgrade" data-name="requests"'));
  assert.ok(!html.includes('data-action="upgrade" data-name="urllib3"'));
  assert.ok(html.includes('data-action="repair"'));
});
