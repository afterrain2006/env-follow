const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveImports, dependencyStates, isPackageName, wheelScore, run } = require('../dist/core.js');
const usage = name => ({ module: name, locations: [{ file: 'main.py', line: 1, column: 0 }] });
const base = () => ({ manifest: { declared: [], locked: {} }, installed: [] });

test('aliases map while typo and namespace imports require review', () => {
  const rows = resolveImports(['cv2', 'PIL', 'sklearn', 'reqeusts', 'google', 'unfamiliar_xyz'].map(usage), []);
  assert.deepEqual(rows.slice(0, 3).map(row => row.package), ['opencv-python', 'pillow', 'scikit-learn']);
  assert.equal(rows[3].confidence, 'unknown'); assert.equal(rows[3].package, undefined); assert.ok(rows[3].candidates.includes('requests'));
  assert.equal(rows[4].confidence, 'ambiguous'); assert.equal(rows[5].confidence, 'unknown');
});
test('installed metadata overrides a default provider, multiple owners stay ambiguous', () => {
  assert.equal(resolveImports([usage('cv2')], [{ name: 'opencv-python-headless', version: '4', modules: ['cv2'] }])[0].package, 'opencv-python-headless');
  const owners = [{ name: 'one', modules: ['ns'] }, { name: 'two', modules: ['ns'] }];
  assert.equal(resolveImports([usage('ns')], owners)[0].confidence, 'ambiguous');
});
test('unknown import is never mapped to its same-named PyPI distribution implicitly', () => {
  for (const name of ['reqeusts', 'new_module', '__proto__', 'constructor']) {
    const row = resolveImports([usage(name)], [])[0]; assert.equal(row.confidence, 'unknown'); assert.equal(row.package, undefined);
  }
});
test('user mappings validate names and ignores remove dependencies from used state', () => {
  const row = resolveImports([usage('custom')], [], { custom: 'My-Package' }, ['custom'])[0];
  assert.equal(row.package, 'my-package'); assert.equal(row.ignored, true);
  assert.equal(dependencyStates(base(), [row]).length, 0);
  assert.equal(resolveImports([usage('custom')], [], { custom: '--index-url=evil' })[0].package, undefined);
});
test('state comparison distinguishes missing, undeclared, unused and version drift', () => {
  const inspection = base();
  inspection.manifest.declared = ['pandas', 'opencv-python', 'numpy'].map(name => ({ name, scopes: ['runtime'], conditional: false }));
  inspection.manifest.locked.numpy = ['2.0.0'];
  inspection.installed = [{ name: 'pandas', version: '2', modules: ['pandas'] }, { name: 'numpy', version: '1.0.0', modules: ['numpy'] }, { name: 'requests', version: '2', modules: ['requests'] }];
  const rows = dependencyStates(inspection, resolveImports(['torch', 'cv2', 'numpy', 'requests'].map(usage), inspection.installed));
  const statuses = Object.fromEntries(rows.map(row => [row.name, row.status]));
  assert.deepEqual(statuses, { numpy: 'version-drift', 'opencv-python': 'out-of-sync', pandas: 'possibly-unused', requests: 'undeclared', torch: 'missing' });
});
test('development and optional dependencies are not mislabeled unused runtime packages', () => {
  const inspection = base();
  inspection.manifest.declared = [{ name: 'pytest', scopes: ['group:dev'], conditional: false }, { name: 'pandas', scopes: ['extra:data'], conditional: false }];
  assert.ok(dependencyStates(inspection, []).every(row => row.status === 'conditional'));
});
test('package values cannot contain flags, specifiers, URLs or shell syntax', () => {
  for (const name of ['--help', 'a; echo x', '$(whoami)', 'https://host/pkg', 'a>=1', '../path', 'a b', '-bad', 'a[extra]', '', null]) assert.equal(isPackageName(name), false, String(name));
  for (const name of ['numpy', 'Pillow', 'opencv-python', 'a.b_c']) assert.equal(isPackageName(name), true);
});
test('wheel estimate rejects wrong versions and platforms, accepts Windows abi3', () => {
  const py = { major: 3, minor: 13, platform: 'win32', machine: 'AMD64' };
  assert.equal(wheelScore('numpy-2.0-cp312-cp312-win_amd64.whl', py), -1);
  assert.equal(wheelScore('numpy-2.0-cp313-cp313-manylinux.whl', py), -1);
  assert.ok(wheelScore('cv-4.0-cp37-abi3-win_amd64.whl', py) > 0);
  assert.equal(wheelScore('pkg-1.0-py3-none-any.whl', py), 1);
});
test('process runner preserves arguments literally without shell interpretation', async () => {
  const argument = 'spaces & $(do-not-run) `literal`';
  const result = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', argument]);
  assert.equal(result.stdout, argument);
});
test('process failures include real stderr', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'console.error("test failure detail");process.exit(2)']), /test failure detail/);
});
test('isolated Python receives Unicode Windows paths as UTF-8 JSON', async () => {
  const input = JSON.stringify({ root: 'C:\\Users\\测试用户\\项目' });
  const result = await run('python', ['-I', '-S', '-X', 'utf8', '-c', 'import sys,json;print(json.dumps(json.load(sys.stdin)))'], { input });
  assert.deepEqual(JSON.parse(result.stdout), JSON.parse(input));
});
