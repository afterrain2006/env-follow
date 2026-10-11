const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseChanges, selectionArgs, classifyError, buildResolvedPreview } = require('../dist/core.js');

test('uv plan pairs uninstall/install as a version replacement, with removals visible', () => {
  const result = parseChanges({ dry_run: true, sync: { action: 'update', changes: [
    { name: 'Requests', version: '2.31', action: 'uninstalled' },
    { name: 'requests', version: '2.34', action: 'installed' },
    { name: 'old-package', version: '1.0', action: 'uninstalled' }
  ] } });
  assert.deepEqual(result.changes, [{ name: 'old-package', from: '1.0', action: 'remove' }, { name: 'requests', from: '2.31', to: '2.34', action: 'replace' }]);
});
test('unknown uv output and actions are rejected instead of inventing a plan', () => {
  assert.throws(() => parseChanges({}), /格式/);
  assert.throws(() => parseChanges({ dry_run: true, sync: { changes: [{ name: 'foo', version: '1', action: 'surprise' }] } }), /未知/);
});
test('dependency group arguments validate input and preserve explicit selections', () => {
  assert.deepEqual(selectionArgs({ extras: ['pretty'], groups: ['qa'], noDev: true }), ['--extra', 'pretty', '--group', 'qa', '--no-dev']);
  assert.throws(() => selectionArgs({ extras: ['--all-extras'], groups: [], noDev: false }), /无效/);
});
test('error categories provide a recovery action appropriate to the failure', () => {
  for (const [text, category] of [['预览已过期', 'stale'], ['No solution found', 'conflict'], ['No interpreter found', 'python'], ['no wheels with a matching platform tag', 'wheel'], ['certificate failed', 'network']]) assert.equal(classifyError(new Error(text)).category, category);
  assert.equal(classifyError(new Error('No solution found\nPackage has no wheels with a matching platform tag')).category, 'wheel');
  assert.equal(classifyError(new Error('No solution found\nThis package requires Python >=3.13')).category, 'python');
});
test('download preview uses resolved lock versions and includes transitive packages', async () => {
  const inspection = { manifest: { lockPackages: [
    { name: 'requests', version: '2.32.3', wheels: [{ url: 'https://example.invalid/requests-2.32.3-py3-none-any.whl', size: 70000 }] },
    { name: 'urllib3', version: '2.2.0', wheels: [{ url: 'https://example.invalid/urllib3-2.2.0-py3-none-any.whl', size: 120000 }] }
  ] } };
  const result = await buildResolvedPreview([{ name: 'requests', to: '2.32.3', action: 'install' }, { name: 'urllib3', to: '2.2.0', action: 'install' }], ['requests>=2'], inspection, {}, { python: { major: 3, minor: 12, platform: 'win32', machine: 'AMD64' } });
  assert.equal(result.items[0].version, '2.32.3');
  assert.equal(result.items[0].directWheelBytes, 70000);
  assert.equal(result.items[1].direct, false);
  assert.equal(result.items[1].directWheelBytes, 120000);
});
