import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ServiceOptions, EnvironmentInfo, Inspection, Preview, PreviewKind, PlanChange, DependencySelection } from './types';
import { run } from './process';
import { isPackageName, normalize } from './resolver';
import { buildResolvedPreview } from './preview';

export const defaultSelection = (): DependencySelection => ({ extras: [], groups: [], noDev: false });
export function selectionArgs(selection: DependencySelection = defaultSelection()): string[] {
  if (![...selection.extras, ...selection.groups].every(isPackageName)) throw new Error('依赖组名称无效');
  return [...selection.extras.flatMap(name => ['--extra', name]), ...selection.groups.flatMap(name => ['--group', name]), ...(selection.noDev ? ['--no-dev'] : [])];
}
const FILES = ['pyproject.toml', 'uv.lock', 'uv.toml', '.python-version', 'requirements.txt'];
export async function metadata(options: ServiceOptions, environment: EnvironmentInfo, root = options.root): Promise<Inspection> {
  const response = await run(environment.analysisPython.path, ['-I', '-S', '-X', 'utf8', options.helperPath], { input: JSON.stringify({ mode: 'metadata', root }), timeout: 30000 });
  return JSON.parse(response.stdout);
}
export async function fingerprint(options: ServiceOptions, environment: EnvironmentInfo): Promise<string> {
  const hash = createHash('sha256');
  for (const name of [...FILES, '.venv/pyvenv.cfg']) {
    hash.update(name + '\0');
    try { hash.update(await fs.readFile(path.join(options.root, name))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; hash.update('<absent>'); }
  }
  const current = await metadata(options, environment);
  hash.update(JSON.stringify(current.installed));
  hash.update(JSON.stringify([environment.python?.path, environment.python?.version, options.selection || defaultSelection(), options.uvPath || 'uv']));
  return hash.digest('hex');
}
export function parseChanges(raw: unknown): { changes: PlanChange[]; environmentAction: string } {
  const data = raw as { dry_run?: boolean; sync?: { action?: string; changes?: { name: string; version: string; action: string }[] } };
  if (data?.dry_run !== true || !data.sync || !Array.isArray(data.sync.changes)) throw new Error('uv 预览 JSON 格式不受支持，请检查 uv 版本；不会执行安装。');
  const rows = new Map<string, PlanChange>();
  for (const item of data.sync.changes) {
    if (!isPackageName(item.name) || typeof item.version !== 'string' || !['installed', 'uninstalled'].includes(item.action)) throw new Error('uv 返回未知安装动作；不会执行安装。');
    const name = normalize(item.name);
    const row = rows.get(name) || { name, action: 'install' as const };
    if (item.action === 'installed') row.to = item.version;
    else row.from = item.version;
    row.action = row.from && row.to ? 'replace' : row.from ? 'remove' : 'install';
    rows.set(name, row);
  }
  return { changes: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)), environmentAction: data.sync.action || 'unknown' };
}
export function assertEditable(inspection: Inspection): void {
  if (inspection.manifest.exists && !inspection.manifest.hasProjectTable) throw new Error('现有 pyproject.toml 缺少 [project]，请先迁移为 PEP 621 项目；不会覆盖现有配置。');
  if (inspection.manifest.uvWorkspace || inspection.manifest.uvWorkspaceRoot) throw new Error('只读扫描 uv workspace，避免更改上级锁文件。请使用独立项目。');
  if (inspection.warnings.some(message => /pyproject.toml:|uv.lock:/.test(message))) throw new Error('项目 TOML 无法解析，请先修复后重试。');
  if (inspection.manifest.previewBlockers?.length) throw new Error(inspection.manifest.previewBlockers.join('\n'));
}
export async function createPlan(names: string[], options: ServiceOptions, environment: EnvironmentInfo, kind: PreviewKind = 'add', scope = 'runtime'): Promise<Preview> {
  if (environment.uvError) throw new Error(environment.uvError);
  if (!environment.python || environment.pythonError) throw new Error('项目 Python 解释器不可用：' + (environment.pythonError || '未找到符合项目要求的 Python'));
  if (kind === 'add' && (!names.length || !names.every(isPackageName))) throw new Error('仅允许普通 PyPI 包名。');
  if (scope !== 'runtime' && !/^(group|extra):[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scope)) throw new Error('目标依赖组无效');
  const inspection = await metadata(options, environment);
  assertEditable(inspection);
  const upgradeName = kind === 'upgrade' ? names[0] : undefined;
  if (kind === 'upgrade' && (names.length !== 1 || !isPackageName(upgradeName || '') || !inspection.manifest.declared.some(row => row.name === normalize(upgradeName!)) || !inspection.installed.some(row => row.name === normalize(upgradeName!)))) throw new Error('请选择当前项目已声明且已安装的一个依赖进行升级。');
  if (kind === 'upgrade' && !inspection.manifest.lockExists) throw new Error('请先预览同步并生成 uv.lock，再升级依赖。');
  // uv.toml can contain relative source/index settings too: refuse ambiguous copies.
  const uvToml = await fs.readFile(path.join(options.root, 'uv.toml'), 'utf8').catch(() => '');
  if (/\b(?:sources|find-links|workspace)\b/.test(uvToml)) throw new Error('uv.toml 包含本地源或 workspace 配置，当前无法隔离预览。');
  let requested = names;
  if (kind === 'requirements') {
    const requirements = inspection.requirements;
    if (!requirements?.exists || !requirements.entries.length && !requirements.unsupported.length) throw new Error('requirements.txt 没有可导入的依赖。');
    if (requirements.unsupported.length) throw new Error('requirements.txt 包含不支持的内容；没有导入任何依赖：\n' + requirements.unsupported.map(row => `第 ${row.line} 行：${row.reason}`).join('\n'));
    requested = requirements.entries;
  }
  if (kind === 'repair' && !inspection.manifest.lockExists) throw new Error('没有 uv.lock，无法按锁文件修复；请先预览同步。');
  const originalFingerprint = await fingerprint(options, environment);
  const tempRoot = await fs.realpath(os.tmpdir());
  const scratch = await fs.mkdtemp(path.join(tempRoot, 'env-follow-plan-'));
  const execute = async (args: string[], useProjectEnvironment = false) => {
    options.log?.(`\n> uv ${args[0]}（隔离预览）\n`);
    return run(options.uvPath || 'uv', [...args, '--project', scratch, '--no-python-downloads', '--color', 'never', '--no-progress'], {
      cwd: scratch, timeout: 180000, log: options.log,
      env: { UV_PROJECT: undefined, UV_WORKING_DIR: scratch, VIRTUAL_ENV: undefined, UV_PROJECT_ENVIRONMENT: useProjectEnvironment ? path.join(options.root, '.venv') : path.join(scratch, '.venv') }
    });
  };
  try {
    options.onProgress?.('解析安装计划…');
    for (const name of FILES.filter(name => name !== 'requirements.txt')) {
      try { await fs.copyFile(path.join(options.root, name), path.join(scratch, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!inspection.manifest.exists) {
      const projectName = normalize(path.basename(options.root)).replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'python-project';
      // Initialize only the isolated copy. The real project stays byte-for-byte unchanged.
      await fs.writeFile(path.join(scratch, 'pyproject.toml'), `[project]\nname = ${JSON.stringify(projectName)}\nversion = "0.1.0"\nrequires-python = ">=${environment.python.major}.${environment.python.minor}"\ndependencies = []\n`);
    }
    if (kind === 'add' || kind === 'requirements') {
      const destination = scope.startsWith('group:') ? ['--group', scope.slice(6)] : scope.startsWith('extra:') ? ['--optional', scope.slice(6)] : [];
      await execute(['add', '--no-sync', '--no-build', '--python', environment.python.path, ...destination, ...requested]);
    } else if (kind !== 'repair') await execute(['lock', '--no-build', '--python', environment.python.path, ...(upgradeName ? ['--upgrade-package', normalize(upgradeName)] : [])]);
    const raw = await execute(['sync', '--dry-run', '--output-format', 'json', '--locked', '--inexact', '--no-build', '--no-install-project', '--python', environment.python.path, ...selectionArgs(options.selection)], true);
    let decoded: unknown;
    try { decoded = JSON.parse(raw.stdout); } catch { throw new Error('uv 未返回有效的预览 JSON；请检查 uv 版本，不会执行安装。'); }
    const parsed = parseChanges(decoded);
    const prepared = await metadata(options, environment, scratch);
    const preview = await buildResolvedPreview(parsed.changes, requested, prepared, options, environment);
    if (upgradeName) {
      const name = normalize(upgradeName);
      const before = inspection.manifest.locked, after = prepared.manifest.locked;
      preview.upgrade = { name, installed: inspection.installed.find(row => row.name === name)!.version,
        constraints: inspection.manifest.declared.find(row => row.name === name)!.requirements,
        target: after[name] || [],
        lockChanges: [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(pkg => {
          const old = [...(before[pkg] || [])].sort(), next = [...(after[pkg] || [])].sort();
          return JSON.stringify(old) === JSON.stringify(next) ? [] : [{ name: pkg, before: old, after: next }];
        }) };
    }
    if (await fingerprint(options, environment) !== originalFingerprint) throw new Error('预览已过期：生成计划时项目或环境发生了变化。');
    return { ...preview, ...parsed, kind, scope, root: options.root, requested, fingerprint: originalFingerprint,
      selection: options.selection || defaultSelection(), createdAt: new Date().toISOString(),
      manifestText: await fs.readFile(path.join(scratch, 'pyproject.toml'), 'utf8'), lockText: await fs.readFile(path.join(scratch, 'uv.lock'), 'utf8') };
  } finally {
    // Only remove the exact generated scratch directory, within the checked temp root.
    const resolved = path.resolve(scratch);
    if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('env-follow-plan-')) throw new Error('临时目录路径异常，已保留。');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
