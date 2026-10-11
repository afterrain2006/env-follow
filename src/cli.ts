import * as path from 'node:path';
import { ProjectService } from './service';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = args.find(arg => !arg.startsWith('--'));
  if (!root || args.includes('--help')) {
    console.log('Env Follow · 只读扫描\n用法: node dist/cli.js <项目路径> [--json]\n需要 Python 3.11+；可用 ENV_FOLLOW_PYTHON / ENV_FOLLOW_UV 指定可执行文件。');
    return;
  }
  const service = new ProjectService({ root: path.resolve(root), helperPath: path.join(__dirname, '..', 'python', 'inspect_project.py'), pythonPath: process.env.ENV_FOLLOW_PYTHON, uvPath: process.env.ENV_FOLLOW_UV });
  const state = await service.scan();
  if (args.includes('--json')) console.log(JSON.stringify(state, null, 2));
  else {
    console.log(`\nEnv Follow · ${state.inspection.manifest.name}\n${state.root}\nPython ${state.environment.python?.version || '未知'} · ${state.environment.venvExists ? '.venv 已创建' : '尚未创建 .venv'} · ${state.environment.uvVersion || 'uv 未找到'}`);
    console.table(state.dependencies.filter(item => item.status !== 'installed-only').map(item => ({ 包名: item.name, 使用: item.used, 声明: item.declared, 安装: item.installed, 版本: item.version || '—', 状态: item.status })));
    for (const item of state.resolutions.filter(item => item.confidence !== 'high')) console.log(`${item.module}: ${item.confidence} · ${item.reason}${item.candidates.length ? ' · ' + item.candidates.join(', ') : ''}`);
    console.log(`扫描 ${state.inspection.scan.fileCount} 个文件 · 过滤标准库 ${state.inspection.scan.filtered.stdlib.length} · 本地模块 ${state.inspection.scan.filtered.local.length}`);
    for (const error of state.inspection.scan.errors) console.log(`语法/读取错误 ${error.file}:${error.line} ${error.message}`);
    for (const warning of state.inspection.warnings) console.log('提示: ' + warning);
    if (state.inspection.scan.truncated) console.log('警告：达到扫描文件上限，结果不完整。');
  }
}
main().catch(error => { console.error(String(error)); process.exitCode = 1; });
