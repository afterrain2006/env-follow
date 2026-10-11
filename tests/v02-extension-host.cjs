const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
  for (let i = 0; i < 240; i++) { if (predicate()) return; await sleep(250); }
  throw new Error(message);
}
exports.run = async () => {
  const resultFile = path.join(__dirname, '..', '.test-work', 'host-result.json');
  const checks = [];
  try {
    const extension = vscode.extensions.getExtension('env-follow-local.env-follow');
    const api = await extension.activate();
    const checkpoint = async label => { console.log('Env Follow host:', label); await fs.writeFile(resultFile, JSON.stringify({ running: true, checks, stage: label }, null, 2)); };
    await checkpoint('initial scan');
    await until(() => !!api.getState(), 'initial scan failed');
    const root = vscode.workspace.workspaceFolders[0].uri;
    const initial = api.getState();
    assert.ok(initial.environment.venvExists);
    const pythonExtension = vscode.extensions.getExtension('ms-python.python');
    assert.ok(pythonExtension, 'official Python extension is present in the isolated profile');
    const python = await pythonExtension.activate();
    await python.environments.updateActiveEnvironmentPath(initial.environment.analysisPython.path, root);
    await until(() => api.getState()?.editor?.status === 'mismatch', 'interpreter mismatch was not detected');
    checks.push('真实 Python 扩展：解释器切换事件触发不一致提示');
    await checkpoint('select project interpreter');
    await vscode.commands.executeCommand('envFollow.useInterpreter');
    await until(() => api.getState()?.editor?.status === 'aligned', 'one-click project interpreter selection failed');
    checks.push('一键切换项目 Python 并确认对齐');
    await checkpoint('open panel and run task');
    await vscode.commands.executeCommand('envFollow.open');
    await vscode.commands.executeCommand('envFollow.overview.focus');
    checks.push('v0.2 侧边栏在真实 VS Code 中打开');
    const target = vscode.Uri.joinPath(root, 'run-task & 测试.py');
    const outputFile = path.join(root.fsPath, 'task-result.json');
    await fs.writeFile(target.fsPath, 'import sys,json\nfrom pathlib import Path\nfrom local_app import MESSAGE\nPath("task-result.json").write_text(json.dumps({"python": sys.executable, "message": MESSAGE}), encoding="utf-8")\n');
    await fs.rm(outputFile, { force: true });
    const document = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(document);
    await until(() => api.getState()?.inspection.scan.imports.every(row => row.module !== 'local_app'), 'src package did not get filtered');
    await sleep(1500);
    const before = await fs.readFile(path.join(root.fsPath, 'pyproject.toml'));
    const lockBefore = await fs.readFile(path.join(root.fsPath, 'uv.lock'));
    await vscode.commands.executeCommand('envFollow.runFile');
    let result;
    for (let i = 0; i < 120; i++) { try { result = JSON.parse(await fs.readFile(outputFile, 'utf8')); break; } catch { await sleep(250); } }
    assert.ok(result, 'ProcessExecution task did not finish');
    assert.equal(result.python.toLowerCase(), api.getState().environment.python.path.toLowerCase());
    assert.equal(result.message, 'src layout works');
    assert.ok((await fs.readFile(path.join(root.fsPath, 'pyproject.toml'))).equals(before));
    assert.ok((await fs.readFile(path.join(root.fsPath, 'uv.lock'))).equals(lockBefore));
    checks.push('运行按钮使用项目解释器，支持 src 和特殊文件名，不修改声明或锁文件');
    await fs.writeFile(resultFile, JSON.stringify({ success: true, checks }, null, 2));
  } catch (error) {
    await fs.writeFile(resultFile, JSON.stringify({ success: false, checks, error: error.stack }, null, 2));
    throw error;
  }
};
