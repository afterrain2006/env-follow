import { ServiceOptions, EnvironmentInfo, TreeReport, HealthReport, UpdatesReport, UpdateItem, ReportBase } from './types';
import { run, CommandError } from './process';
import { inspectEnvironment } from './environment';
import { metadata, fingerprint, assertEditable } from './planning';
import { isPackageName, normalize } from './resolver';

const LIMIT = 40000;
export function parseUpdates(raw: unknown): UpdateItem[] {
  if (!Array.isArray(raw)) throw new Error('uv 更新列表格式不受支持。');
  const seen = new Set<string>();
  return raw.map(item => {
    if (!item || !isPackageName(item.name) || typeof item.version !== 'string' || typeof item.latest_version !== 'string') throw new Error('uv 更新列表包含未知格式。');
    const name = normalize(item.name);
    if (seen.has(name)) throw new Error('uv 更新列表包含重复包名。');
    seen.add(name);
    return { name, version: item.version, latest: item.latest_version };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
export function checkOutcome(error: unknown): string {
  if (error instanceof CommandError && error.exitCode === 1) {
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    // Exit 1 alone also covers broken environments and unsupported commands.
    if (/Found \d+ incompatibilit/i.test(output)) return output;
  }
  throw error;
}
async function context(options: ServiceOptions): Promise<{ env: EnvironmentInfo; base: ReportBase }> {
  const env = await inspectEnvironment(options);
  if (env.uvError) throw new Error(env.uvError);
  if (!env.venvExists || !env.python || env.pythonError) throw new Error('请先创建有效的项目 Python 环境。');
  return { env, base: { root: options.root, checkedAt: new Date().toISOString(), fingerprint: await fingerprint(options, env) } };
}
async function execute(options: ServiceOptions, env: EnvironmentInfo, args: string[], online = false) {
  options.log?.(`\n> uv pip ${args.join(' ')}\n`);
  return run(options.uvPath || 'uv', ['pip', ...args, '--python', env.python!.path, '--no-python-downloads', '--color', 'never', '--no-progress', ...(online ? ['--project', options.root] : ['--offline', '--no-config'])], {
    cwd: options.root, timeout: online ? 120000 : 30000, log: options.log,
    env: { UV_PROJECT: undefined, UV_WORKING_DIR: options.root, VIRTUAL_ENV: undefined, UV_PROJECT_ENVIRONMENT: env.venvPath }
  });
}
async function unchanged(options: ServiceOptions, env: EnvironmentInfo, base: ReportBase): Promise<void> {
  if (await fingerprint(options, env) !== base.fingerprint) throw new Error('预览已过期：检查期间项目或环境发生变化，请重新检查。');
}
export async function dependencyTree(options: ServiceOptions, name?: string): Promise<TreeReport> {
  if (name && !isPackageName(name)) throw new Error('包名无效。');
  const { env, base } = await context(options);
  if (name && !(await metadata(options, env)).installed.some(row => row.name === normalize(name))) throw new Error('该包未安装在当前项目环境中，请刷新。');
  const selected = name ? ['--package', normalize(name)] : [];
  const forward = await execute(options, env, ['tree', '--depth', '8', '--show-version-specifiers', ...selected]);
  const reverse = name ? await execute(options, env, ['tree', '--depth', '8', '--show-version-specifiers', ...selected, '--invert']) : undefined;
  await unchanged(options, env, base);
  return { ...base, name: name && normalize(name), forward: forward.stdout.slice(0, LIMIT), reverse: reverse?.stdout.slice(0, LIMIT), truncated: forward.stdout.length > LIMIT || (reverse?.stdout.length || 0) > LIMIT };
}
export async function healthCheck(options: ServiceOptions): Promise<HealthReport> {
  const { env, base } = await context(options);
  let output: string, status: HealthReport['status'] = 'healthy';
  try {
    const result = await execute(options, env, ['check']);
    output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  } catch (error) { output = checkOutcome(error); status = 'issues'; }
  await unchanged(options, env, base);
  return { ...base, status, output };
}
export async function checkUpdates(options: ServiceOptions): Promise<UpdatesReport> {
  const { env, base } = await context(options);
  const inspection = await metadata(options, env);
  assertEditable(inspection);
  const result = await execute(options, env, ['list', '--outdated', '--format', 'json'], true);
  const items = parseUpdates(JSON.parse(result.stdout));
  await unchanged(options, env, base);
  return { ...base, items };
}
