const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ProjectService } = require('../dist/core.js');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'env-follow-rollback-'));
  await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "sample"\ndependencies = []\n');
  await fs.writeFile(path.join(root, 'uv.lock'), 'original-lock');
  const service = new ProjectService({ root, helperPath: 'unused' });
  service.scan = async () => ({ inspection: { manifest: { exists: true, hasProjectTable: true }, warnings: [] } });
  return { root, service };
}
test('installation failure restores uv-owned declaration and lock changes', async () => {
  const { root, service } = await fixture();
  const original = await fs.readFile(path.join(root, 'pyproject.toml'));
  service.uv = async args => {
    if (args[0] === 'add') {
      await fs.writeFile(path.join(root, 'pyproject.toml'), 'updated-by-uv');
      await fs.writeFile(path.join(root, 'uv.lock'), 'updated-lock');
    } else throw new Error('simulated install failure');
  };
  await assert.rejects(service.add(['numpy']), /simulated install failure/);
  assert.ok((await fs.readFile(path.join(root, 'pyproject.toml'))).equals(original));
  assert.equal(await fs.readFile(path.join(root, 'uv.lock'), 'utf8'), 'original-lock');
  assert.equal(service.busy, false);
});
test('failure recovery preserves concurrent user edits and reports conflict', async () => {
  const { root, service } = await fixture();
  service.uv = async args => {
    if (args[0] === 'add') await fs.writeFile(path.join(root, 'pyproject.toml'), 'updated-by-uv');
    else {
      await fs.writeFile(path.join(root, 'pyproject.toml'), 'concurrent-user-change');
      throw new Error('failed');
    }
  };
  await assert.rejects(service.add(['numpy']), /操作期间被修改/);
  assert.equal(await fs.readFile(path.join(root, 'pyproject.toml'), 'utf8'), 'concurrent-user-change');
});
test('uv workspace member cannot mutate an ancestor lockfile', async () => {
  const { service } = await fixture();
  service.scan = async () => ({ inspection: { manifest: { exists: true, hasProjectTable: true, uvWorkspaceRoot: 'ancestor' }, warnings: [] } });
  service.uv = async () => { assert.fail('uv should not execute'); };
  await assert.rejects(service.sync(), /上级锁文件/);
});

test('prepared-plan installation failure restores both exact manifest snapshots', async () => {
  const { root, service } = await fixture();
  const original = await fs.readFile(path.join(root, 'pyproject.toml'));
  await assert.rejects(service.transaction(async () => {
    await service.writePrepared('pyproject.toml', 'prepared-manifest');
    await service.writePrepared('uv.lock', 'prepared-lock');
    throw new Error('wheel download failed');
  }, false), /wheel download failed/);
  assert.ok((await fs.readFile(path.join(root, 'pyproject.toml'))).equals(original));
  assert.equal(await fs.readFile(path.join(root, 'uv.lock'), 'utf8'), 'original-lock');
  assert.equal(service.busy, false);
});

test('prepared writes never claim ownership of a concurrent lock edit', async () => {
  const { root, service } = await fixture();
  const original = await fs.readFile(path.join(root, 'pyproject.toml'));
  await assert.rejects(service.transaction(async () => {
    await service.writePrepared('pyproject.toml', 'prepared-manifest');
    await fs.writeFile(path.join(root, 'uv.lock'), 'user-lock');
    await service.writePrepared('uv.lock', 'prepared-lock');
  }, false), /操作期间被修改/);
  assert.ok((await fs.readFile(path.join(root, 'pyproject.toml'))).equals(original));
  assert.equal(await fs.readFile(path.join(root, 'uv.lock'), 'utf8'), 'user-lock');
});
