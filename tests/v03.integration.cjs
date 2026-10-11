const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ProjectService, run } = require('../dist/core.js');
const parent = path.join(__dirname, '..', '.test-work');
const helperPath = path.join(__dirname, '..', 'python/inspect_project.py');
async function fixture(name, requirement) {
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, name));
  const manifest = `[project]\nname = "maintenance-demo"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = ["${requirement}", "colorama==0.4.6"]\n# preserve this comment\n`;
  await fs.writeFile(path.join(root, 'pyproject.toml'), manifest);
  await fs.writeFile(path.join(root, 'main.py'), 'import requests\n');
  const service = new ProjectService({ root, helperPath, log: text => process.stderr.write(text) });
  await run('uv', ['lock', '--project', root, '--upgrade-package', 'requests==2.32.3', '--no-build', '--no-python-downloads'], { cwd: root, timeout: 120000 });
  await service.applyPreview(await service.preview([], 'repair'));
  return { root, service, manifest };
}
async function files(root) { return Promise.all(['pyproject.toml', 'uv.lock', '.venv/pyvenv.cfg'].map(file => fs.readFile(path.join(root, file), 'utf8'))); }

test('v0.3 real tree/reverse/check/updates are read-only; reviewed upgrade preserves constraints and survives repair', { timeout: 300000 }, async () => {
  const { root, service, manifest } = await fixture('v03-maintenance-', 'requests>=2.32,<3');
  const before = await files(root);
  const initial = await service.scan();
  const tree = await service.dependencyTree();
  assert.match(tree.forward, /requests v2\.32\.3/);
  assert.match(tree.forward, /urllib3/);
  const reverse = await service.dependencyTree('urllib3');
  assert.match(reverse.reverse, /requests/);
  assert.match(reverse.forward, /urllib3/);
  assert.equal((await service.healthCheck()).status, 'healthy');
  const updates = await service.checkUpdates();
  assert.ok(updates.items.some(row => row.name === 'requests' && row.version === '2.32.3'));
  assert.deepEqual(await files(root), before);
  await assert.rejects(service.dependencyTree('--bad'), /包名/);
  await assert.rejects(service.preview(['urllib3'], 'upgrade'), /已声明/);
  const plan = await service.preview(['requests'], 'upgrade');
  assert.equal(plan.manifestText, manifest);
  assert.ok(plan.upgrade.target.length);
  assert.ok(!plan.upgrade.target.includes('2.32.3'));
  assert.ok(plan.changes.some(row => row.name === 'requests' && row.action === 'replace' && row.from === '2.32.3'));
  assert.ok(!plan.upgrade.lockChanges.some(row => row.name === 'colorama'));
  assert.deepEqual(await files(root), before);
  await fs.appendFile(path.join(root, 'pyproject.toml'), '# concurrent edit\n');
  await assert.rejects(service.applyPreview(plan), /预览已过期/);
  const fresh = await service.preview(['requests'], 'upgrade');
  await service.applyPreview(fresh);
  const upgraded = await service.scan();
  for (const change of fresh.changes.filter(row => row.to)) assert.ok(upgraded.inspection.installed.some(row => row.name === change.name && row.version === change.to));
  assert.equal(await fs.readFile(path.join(root, 'pyproject.toml'), 'utf8'), manifest + '# concurrent edit\n');
  assert.equal((await service.healthCheck()).status, 'healthy');
  // Remove a transitive dependency, verify uv diagnoses it, then restore from the lock.
  const python = initial.environment.python.path;
  await run('uv', ['pip', 'uninstall', '--python', python, 'idna'], { cwd: root });
  const missing = await service.healthCheck();
  assert.equal(missing.status, 'issues');
  assert.match(missing.output, /idna/);
  await service.applyPreview(await service.preview([], 'repair'));
  assert.equal((await service.healthCheck()).status, 'healthy');
  // Introduce an incompatible version independently of the lock.
  await run('uv', ['pip', 'install', '--python', python, '--no-deps', '--no-build', 'idna==2.0'], { cwd: root, timeout: 120000 });
  assert.equal((await service.healthCheck()).status, 'issues');
  await service.applyPreview(await service.preview([], 'repair'));
  assert.equal((await service.healthCheck()).status, 'healthy');
  await fs.writeFile(path.join(root, 'v03-plan.json'), JSON.stringify({ kind: fresh.kind, changes: fresh.changes, upgrade: fresh.upgrade }, null, 2));
  console.log('v0.3 fixture:', root);
});

test('v0.3 exact constraints stay pinned and absent project environments are never replaced by system Python', { timeout: 180000 }, async () => {
  const { root, service, manifest } = await fixture('v03-pinned-', 'requests==2.32.3');
  const before = await files(root);
  const plan = await service.preview(['requests'], 'upgrade');
  assert.deepEqual(plan.upgrade.target, ['2.32.3']);
  assert.equal(plan.upgrade.lockChanges.length, 0);
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.manifestText, manifest);
  assert.deepEqual(await files(root), before);
  const empty = await fs.mkdtemp(path.join(parent, 'v03-no-env-'));
  const absent = new ProjectService({ root: empty, helperPath });
  await assert.rejects(absent.dependencyTree(), /项目 Python 环境/);
  await assert.rejects(absent.healthCheck(), /项目 Python 环境/);
  await assert.rejects(absent.checkUpdates(), /项目 Python 环境/);
  assert.equal(await fs.stat(path.join(empty, '.venv')).catch(() => null), null);
  console.log('v0.3 pinned fixture:', root);
});
