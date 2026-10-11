import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PythonInfo, EditorInterpreter } from './types';
import { pythonInfo } from './environment';

export async function canonicalInterpreter(input: string): Promise<string> {
  let target = path.resolve(input);
  try {
    if ((await fs.stat(target)).isDirectory()) target = path.join(target, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  } catch { /* invalid selections remain visible */ }
  // Do not realpath the executable on POSIX: different venvs may symlink the same binary.
  const directory = await fs.realpath(path.dirname(target)).catch(() => path.dirname(target));
  const value = path.join(directory, path.basename(target));
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
export async function compareInterpreter(selected: string | undefined, project: PythonInfo | undefined, venvExists: boolean): Promise<EditorInterpreter> {
  if (!selected) return { status: 'unavailable', detail: '未取得 Python 扩展的活动解释器。运行按钮仍可使用已创建的项目环境。' };
  let info: PythonInfo;
  try {
    let executable = selected;
    if ((await fs.stat(selected)).isDirectory()) executable = path.join(selected, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    info = await pythonInfo(executable);
  } catch (error) { return { path: selected, status: 'invalid', detail: String(error) }; }
  const aligned = venvExists && project && await canonicalInterpreter(info.path) === await canonicalInterpreter(project.path);
  return { path: info.path, version: info.version, status: aligned ? 'aligned' : 'mismatch', detail: aligned ? '编辑器与项目使用同一个解释器' : venvExists ? '编辑器选择与项目 .venv 不一致' : '尚无项目环境，编辑器正在使用其他解释器' };
}
export async function projectRunSpec(root: string, file: string, python: PythonInfo | undefined, venvExists: boolean): Promise<{ executable: string; args: string[]; cwd: string; env: Record<string, string> }> {
  if (!venvExists || !python) throw new Error('请先创建有效的项目 Python 环境。');
  const actualRoot = await fs.realpath(root);
  const actualFile = await fs.realpath(file);
  const relative = path.relative(actualRoot, actualFile);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !actualFile.endsWith('.py')) throw new Error('请选择所选项目中的 Python 源文件。');
  const source = path.join(actualRoot, 'src');
  const paths = [actualRoot];
  if ((await fs.stat(source).catch(() => undefined))?.isDirectory()) paths.push(source);
  return { executable: python.path, args: ['-X', 'utf8', actualFile], cwd: actualRoot, env: { VIRTUAL_ENV: path.join(actualRoot, '.venv'), PYTHONPATH: paths.join(path.delimiter), PYTHONIOENCODING: 'utf-8' } };
}
