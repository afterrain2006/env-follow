import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { run } from './process';
import { EnvironmentInfo, Inspection, PythonInfo, ServiceOptions } from './types';

const INFO = `import sys,json,platform; print(json.dumps(dict(path=sys.executable,version=platform.python_version(),major=sys.version_info.major,minor=sys.version_info.minor,platform=sys.platform,machine=platform.machine(),stdlib=sorted(getattr(sys,'stdlib_module_names',[])))))`;
export async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }
export async function pythonInfo(executable: string, prefix: string[] = []): Promise<PythonInfo> {
  const result = await run(executable, [...prefix, '-I', '-S', '-X', 'utf8', '-c', INFO], { timeout: 15000 });
  return JSON.parse(result.stdout.trim());
}
export async function findAnalysisPython(configured?: string): Promise<PythonInfo> {
  const candidates: [string, string[]][] = configured ? [[configured, []]] : [['python', []], ['python3', []], ...(process.platform === 'win32' ? [['py', ['-3']] as [string, string[]]] : [])];
  const errors: string[] = [];
  for (const [executable, args] of candidates) {
    try {
      const info = await pythonInfo(executable, args);
      if (info.major !== 3 || info.minor < 11) throw new Error('分析工具需要 Python 3.11+');
      return info;
    } catch (error) { errors.push(String(error)); }
  }
  throw new Error('未找到用于扫描的 Python 3.11+。请安装 Python 或设置 envFollow.pythonPath。\n' + errors.join('\n'));
}
export async function inspectEnvironment(options: ServiceOptions): Promise<EnvironmentInfo> {
  const analysisPython = await findAnalysisPython(options.pythonPath);
  const venvPath = path.join(options.root, '.venv');
  const interpreter = path.join(venvPath, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const venvExists = await exists(path.join(venvPath, 'pyvenv.cfg'));
  const result: EnvironmentInfo = { analysisPython, venvPath, venvExists };
  try {
    if (venvExists) result.python = await pythonInfo(interpreter);
    else {
      // Ask uv for the project-compatible Python; never download one during scan.
      const found = await run(options.uvPath || 'uv', ['python', 'find', '--project', options.root, '--no-python-downloads'], { cwd: options.root, timeout: 20000 });
      result.python = await pythonInfo(found.stdout.trim());
    }
  } catch (error) {
    result.pythonError = String(error);
    if (!venvExists) result.python = analysisPython;
  }
  try {
    const uv = await run(options.uvPath || 'uv', ['--version'], { cwd: options.root });
    result.uvVersion = uv.stdout.trim();
    const cache = await run(options.uvPath || 'uv', ['cache', 'dir'], { cwd: options.root });
    result.cacheDir = cache.stdout.trim();
  } catch (error) { result.uvError = String(error); }
  return result;
}
export async function inspectProject(options: ServiceOptions, environment: EnvironmentInfo): Promise<Inspection> {
  const response = await run(environment.analysisPython.path, ['-I', '-S', '-X', 'utf8', options.helperPath], {
    cwd: options.root, timeout: 60000,
    input: JSON.stringify({ root: options.root, maxFiles: options.maxFiles || 4000, exclude: options.exclude || [], stdlib: environment.python?.stdlib?.length ? environment.python.stdlib : environment.analysisPython.stdlib })
  });
  const value = JSON.parse(response.stdout);
  if (value.error) throw new Error(value.error);
  return value;
}
