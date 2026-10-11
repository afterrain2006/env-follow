// Networked acceptance test in an isolated fixture; never mutates examples/demo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ProjectService, run } = require('../dist/core.js');

test('real uv: empty project → AST suggestions → add → installed → unused → failure recovery', { timeout: 600000 }, async () => {
  const parent = path.join(__dirname, '..', '.test-work');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'acceptance-'));
  const service = new ProjectService({ root, helperPath: path.join(__dirname, '..', 'python', 'inspect_project.py'), log: text => process.stderr.write(text) });
  await fs.writeFile(path.join(root, 'main.py'), 'import os\nimport numpy as np\nimport cv2\n', 'utf8');
  let state = await service.scan();
  assert.equal(state.environment.venvExists, false);
  assert.deepEqual(state.resolutions.map(item => item.package).sort(), ['numpy', 'opencv-python']);
  await service.createEnvironment();
  assert.equal((await service.scan()).environment.venvExists, true);
  await service.add(['numpy', 'opencv-python']);
  state = await service.scan();
  assert.ok(state.inspection.manifest.lockExists);
  assert.ok(state.dependencies.filter(item => item.used).every(item => item.status === 'ready'));
  const py = state.environment.python.path;
  await run(py, ['-I', '-c', 'import numpy,cv2;print(numpy.__version__,cv2.__version__)'], { cwd: root });
  // Install an unrelated package directly: sync must preserve it.
  await run('uv', ['pip', 'install', '--python', py, '--no-build', 'colorama'], { cwd: root, timeout: 120000 });
  await fs.writeFile(path.join(root, 'main.py'), 'import numpy\nimport reqeusts\n', 'utf8');
  await service.sync();
  state = await service.scan();
  assert.equal(state.dependencies.find(item => item.name === 'opencv-python').status, 'possibly-unused');
  assert.ok(state.inspection.installed.some(item => item.name === 'colorama'));
  assert.equal(state.resolutions.find(item => item.module === 'reqeusts').confidence, 'unknown');
  const manifestBefore = await fs.readFile(path.join(root, 'pyproject.toml'));
  const lockBefore = await fs.readFile(path.join(root, 'uv.lock'));
  await assert.rejects(service.add(['--malicious']), /包名/);
  await assert.rejects(service.add(['env-follow-test-nonexistent-package-9f810ed4']), /No solution found|not found|找不到|failed/i);
  assert.ok((await fs.readFile(path.join(root, 'pyproject.toml'))).equals(manifestBefore));
  assert.ok((await fs.readFile(path.join(root, 'uv.lock'))).equals(lockBefore));
  await service.sync();
  assert.ok((await service.scan()).dependencies.find(item => item.name === 'numpy').installed);
  console.log('Acceptance fixture:', root);
});
