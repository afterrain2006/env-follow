import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ServiceOptions, ProjectState, Preview, PreviewKind, RecoveryInfo } from './types';
import { inspectEnvironment, inspectProject, exists } from './environment';
import { dependencyStates, isPackageName, normalize, resolveImports } from './resolver';
import { run } from './process';
import { createPlan, fingerprint, assertEditable, selectionArgs } from './planning';
import { classifyError } from './errors';
import { dependencyTree, healthCheck, checkUpdates } from './maintenance';

export class OperationFailure extends Error {
  constructor(message: string, public recovery: RecoveryInfo) { super(message); this.name = 'OperationFailure'; }
}

export class ProjectService {
  private mutating = false;
  constructor(public readonly options: ServiceOptions) {}
  get busy(): boolean { return this.mutating; }
  dependencyTree(name?: string) { return dependencyTree(this.options, name); }
  healthCheck() { return healthCheck(this.options); }
  checkUpdates() { return checkUpdates(this.options); }
  async scan(): Promise<ProjectState> {
    const environment = await inspectEnvironment(this.options);
    const inspection = await inspectProject(this.options, environment);
    const resolutions = resolveImports(inspection.scan.imports, inspection.installed, this.options.mappings, this.options.ignored);
    return { root: this.options.root, environment, inspection, resolutions, dependencies: dependencyStates(inspection, resolutions), scannedAt: new Date().toISOString(), selection: this.options.selection };
  }
  async preview(names: string[], kind: PreviewKind = 'add', scope = 'runtime'): Promise<Preview> {
    const environment = await inspectEnvironment(this.options);
    return createPlan(names, this.options, environment, kind, scope);
  }
  private async uv(args: string[]): Promise<void> {
    this.options.onProgress?.(args[0] === 'sync' ? '准备同步环境…' : args[0] === 'add' || args[0] === 'lock' ? '解析依赖…' : '创建项目环境…');
    this.options.log?.(`\n> uv ${args.join(' ')}\n`);
    const scoped = args[0] === 'init' ? [...args, this.options.root] : [...args, '--project', this.options.root];
    const result = await run(this.options.uvPath || 'uv', [...scoped, '--no-python-downloads', '--color', 'never', '--no-progress'], {
      cwd: this.options.root, timeout: 10 * 60 * 1000, log: value => {
        this.options.log?.(value);
        if (/Downloading|Downloaded/i.test(value)) this.options.onProgress?.('下载依赖…');
        if (/Prepared|Installing|Installed/i.test(value)) this.options.onProgress?.('安装依赖…');
      },
      // The selected workspace always owns .venv; do not inherit an unrelated active env.
      env: { UV_PROJECT_ENVIRONMENT: path.join(this.options.root, '.venv'), UV_WORKING_DIR: this.options.root, UV_PROJECT: undefined, VIRTUAL_ENV: undefined }
    });
    if (result.stdout) this.options.log?.(result.stdout);
  }
  private async ensureProject(): Promise<void> {
    if (!await exists(path.join(this.options.root, 'pyproject.toml'))) {
      const env = await inspectEnvironment(this.options);
      await this.uv(['init', '--bare', '--no-package', '--vcs', 'none', '--no-workspace', '--no-pin-python', '--python', env.python?.path || env.analysisPython.path]);
    }
  }
  private async transaction(action: () => Promise<void>, initialize = true): Promise<void> {
    if (this.mutating) throw new Error('此项目已有 uv 操作进行中，请等待它完成。');
    this.mutating = true;
    const files = ['pyproject.toml', 'uv.lock'];
    const before = new Map<string, Buffer | null>();
    const expected = new Map<string, Buffer | null>();
    let initial: ProjectState | undefined;
    const read = async (name: string): Promise<Buffer | null> => { try { return await fs.readFile(path.join(this.options.root, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };
    try {
      const state = await this.scan();
      initial = state;
      assertEditable(state.inspection);
      for (const file of files) before.set(file, await read(file));
      // Capture uv-owned manifest changes immediately after each manifest operation.
      this.capture = async () => { for (const file of files) expected.set(file, await read(file)); };
      this.writePrepared = async (file, text) => {
        const current = await read(file);
        const owned = expected.get(file);
        if (!(current === null && owned === null || current && owned && current.equals(owned))) throw new Error(`${file} 操作期间被修改，已保留当前内容。请重新预览。`);
        const content = Buffer.from(text, 'utf8');
        await fs.writeFile(path.join(this.options.root, file), content);
        expected.set(file, content);
      };
      if (initialize) await this.ensureProject();
      await this.capture();
      await action();
    } catch (error) {
      const notes: string[] = [];
      for (const [file, original] of before) {
        if (!expected.has(file)) continue;
        try {
          const current = await read(file);
          const owned = expected.get(file);
          if (current?.equals(owned || Buffer.alloc(0)) || current === null && owned === null) {
            if (original === null) await fs.rm(path.join(this.options.root, file), { force: true });
            else await fs.writeFile(path.join(this.options.root, file), original);
          } else notes.push(`${file} 操作期间被修改，已保留当前内容。`);
        } catch (recoveryError) { notes.push(`${file} 无法恢复：${String(recoveryError)}`); }
      }
      const recovery = classifyError(error);
      if (initial?.inspection.installed) {
        try {
          const after = await this.scan();
          const old = new Map(initial.inspection.installed.map(row => [row.name, row.version]));
          recovery.changedPackages = [...new Set([...old.keys(), ...after.inspection.installed.map(row => row.name)])].filter(name => old.get(name) !== after.inspection.installed.find(row => row.name === name)?.version);
          recovery.canRepair = recovery.canRepair && after.inspection.manifest.lockExists;
        } catch { /* preserve the original failure when inspection also fails */ }
      }
      throw new OperationFailure(String(error) + (before.size ? '\n已尝试恢复本次操作的声明和锁文件；.venv 可能部分更新。\n' + notes.join('\n') : ''), recovery);
    } finally { this.capture = undefined; this.writePrepared = undefined; this.mutating = false; }
  }
  private capture?: () => Promise<void>;
  private writePrepared?: (file: string, text: string) => Promise<void>;
  async applyPreview(preview: Preview): Promise<void> {
    const environment = await inspectEnvironment(this.options);
    if (preview.root !== this.options.root || !preview.fingerprint || !preview.manifestText || !preview.lockText || await fingerprint(this.options, environment) !== preview.fingerprint) throw new Error('预览已过期：项目声明、锁文件、依赖组或环境已经改变。请重新生成计划。');
    await this.transaction(async () => {
      if (await fingerprint(this.options, environment) !== preview.fingerprint) throw new Error('预览已过期：项目在确认期间发生变化。');
      await this.writePrepared!('pyproject.toml', preview.manifestText!);
      await this.writePrepared!('uv.lock', preview.lockText!);
      await this.uv(['sync', '--locked', '--inexact', '--no-build', '--no-install-project', '--python', environment.python!.path, ...selectionArgs(this.options.selection)]);
      this.options.onProgress?.('检查安装结果…');
      const state = await this.scan();
      for (const change of preview.changes || []) {
        if (change.to && !state.inspection.installed.some(row => row.name === change.name && row.version === change.to)) throw new Error(`安装结果检查失败：${change.name} 未处于预览版本 ${change.to}`);
        if (!change.to && state.inspection.installed.some(row => row.name === change.name)) throw new Error(`安装结果检查失败：${change.name} 仍在环境中`);
      }
    }, false);
  }
  async add(names: string[]): Promise<void> {
    if (!names.length || !names.every(isPackageName)) throw new Error('仅允许普通 PyPI 包名，拒绝命令参数、URL 和路径。');
    const packages = [...new Set(names.map(normalize))];
    await this.transaction(async () => {
      await this.uv(['add', '--no-sync', '--no-build', ...packages]);
      await this.capture?.();
      // --inexact deliberately preserves unrelated installed packages.
      await this.uv(['sync', '--locked', '--inexact', '--no-build', '--no-install-project']);
    });
  }
  async createEnvironment(): Promise<void> {
    await this.transaction(async () => {
      if (await exists(path.join(this.options.root, '.venv', 'pyvenv.cfg'))) return;
      if (await exists(path.join(this.options.root, '.venv'))) throw new Error('.venv 已存在但不是有效环境；请自行检查，不会清空该目录。');
      await this.uv(['venv', '.venv']);
    });
  }
  async sync(): Promise<void> {
    await this.transaction(async () => {
      await this.uv(['sync', '--inexact', '--no-build', '--no-install-project', ...selectionArgs(this.options.selection)]);
    });
  }
}
