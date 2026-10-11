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
  const checkpoint = async stage => fs.writeFile(resultFile, JSON.stringify({ running: true, stage, checks }, null, 2));
  try {
    const extension = vscode.extensions.getExtension('env-follow-local.env-follow');
    const api = await extension.activate();
    await until(() => !!api.getState(), 'initial scan failed');
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const original = await Promise.all(['pyproject.toml', 'uv.lock'].map(file => fs.readFile(path.join(root, file), 'utf8')));
    await checkpoint('health');
    await vscode.commands.executeCommand('envFollow.checkHealth');
    assert.equal(api.getMaintenance().health?.status, 'healthy');
    checks.push('健康检查命令取得真实 uv 兼容性结果');
    await checkpoint('tree');
    await vscode.commands.executeCommand('envFollow.showTree', 'urllib3');
    assert.match(api.getMaintenance().tree.reverse, /requests/);
    checks.push('包关系命令显示正向与反向依赖');
    await checkpoint('updates');
    await vscode.commands.executeCommand('envFollow.checkUpdates');
    assert.ok(api.getMaintenance().updates.items.some(row => row.name === 'requests'));
    checks.push('更新检查显示已安装与可用版本');
    await checkpoint('upgrade');
    await vscode.commands.executeCommand('envFollow.upgradePackage', 'requests');
    await until(() => api.getPreview()?.kind === 'upgrade', 'upgrade preview did not appear');
    assert.deepEqual(api.getPreview().upgrade.target, ['2.32.3']);
    assert.equal(api.getPreview().changes.length, 0);
    checks.push('固定版本升级预览保留约束，不自动安装');
    await vscode.commands.executeCommand('envFollow.open');
    await vscode.commands.executeCommand('envFollow.overview.focus');
    checks.push('v0.3 面板在真实 VS Code 中打开');
    assert.deepEqual(await Promise.all(['pyproject.toml', 'uv.lock'].map(file => fs.readFile(path.join(root, file), 'utf8'))), original);
    // Changing the file invalidates cached maintenance reports after refresh.
    const config = vscode.workspace.getConfiguration('envFollow', vscode.Uri.file(root));
    await config.update('excludeDev', true, vscode.ConfigurationTarget.WorkspaceFolder);
    await until(() => !Object.keys(api.getMaintenance()).length && !api.getPreview(), 'configuration did not clear old reports/plan');
    checks.push('依赖组配置改变后清除旧报告和计划');
    await fs.writeFile(resultFile, JSON.stringify({ success: true, checks }, null, 2));
  } catch (error) {
    await fs.writeFile(resultFile, JSON.stringify({ success: false, checks, error: error.stack }, null, 2));
    throw error;
  }
};
