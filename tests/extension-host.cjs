const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await sleep(200); }
  throw new Error(message);
}
exports.run = async function () {
  const resultFile = path.join(__dirname, '..', '.test-work', 'host-result.json');
  const checks = [];
  try {
    const extension = vscode.extensions.getExtension('env-follow-local.env-follow');
    assert.ok(extension, 'extension is available in the real VS Code host');
    const api = await extension.activate();
    await until(() => !!api.getState(), 'initial project scan did not complete');
    let state = api.getState();
    assert.deepEqual(state.dependencies.map(item => item.name).sort(), ['numpy', 'opencv-python']);
    assert.deepEqual(state.inspection.scan.filtered.stdlib, ['os']);
    checks.push('扩展激活、项目识别与初次扫描');
    const commands = await vscode.commands.getCommands();
    assert.ok(commands.includes('envFollow.open') && commands.includes('envFollow.addMissing'));
    await vscode.commands.executeCommand('envFollow.open');
    await vscode.commands.executeCommand('envFollow.overview.focus');
    checks.push('活动栏和 webview 面板成功打开');
    const root = vscode.workspace.workspaceFolders[0].uri;
    const file = vscode.Uri.joinPath(root, 'main.py');
    await until(() => vscode.languages.getDiagnostics(file).length === 2, 'dependency diagnostics did not appear');
    checks.push('缺失依赖诊断显示');
    const document = await vscode.workspace.openTextDocument(file);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(file, new vscode.Range(0, 0, document.lineCount, 0), 'import os\nimport numpy\nimport reqeusts\n');
    await vscode.workspace.applyEdit(edit);
    await document.save();
    await until(() => api.getState()?.resolutions.some(row => row.module === 'reqeusts'), 'save did not trigger scanning');
    state = api.getState();
    assert.equal(state.resolutions.find(row => row.module === 'reqeusts').confidence, 'unknown');
    assert.equal(state.dependencies.some(row => row.name === 'opencv-python'), false);
    checks.push('保存触发刷新、删除 import、拼写错误保留为未知');
    const config = vscode.workspace.getConfiguration('envFollow', root);
    await config.update('importMappings', { reqeusts: 'requests' }, vscode.ConfigurationTarget.WorkspaceFolder);
    await until(() => api.getState()?.resolutions.find(row => row.module === 'reqeusts')?.package === 'requests', 'mapping settings did not trigger refresh');
    checks.push('工作区映射设置变更触发刷新');
    assert.equal(await fs.stat(path.join(root.fsPath, 'pyproject.toml')).catch(() => null), null);
    assert.equal(await fs.stat(path.join(root.fsPath, '.venv')).catch(() => null), null);
    checks.push('扫描和设置映射没有自动安装或创建环境');
    await fs.writeFile(resultFile, JSON.stringify({ success: true, checks }, null, 2));
  } catch (error) {
    await fs.mkdir(path.dirname(resultFile), { recursive: true });
    await fs.writeFile(resultFile, JSON.stringify({ success: false, checks, error: error.stack }, null, 2));
    throw error;
  }
};
