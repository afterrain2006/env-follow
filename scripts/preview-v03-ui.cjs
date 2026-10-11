// Real installed environment + production renderer visual and interaction checks.
const fs = require('node:fs/promises');
const path = require('node:path');
const { ProjectService, run } = require('../dist/core.js');
const { content } = require('../dist/render.js');
async function main() {
  const project = path.join(__dirname, '..');
  const helperPath = path.join(project, 'python/inspect_project.py');
  const root = await fs.mkdtemp(path.join(project, '.test-work', 'v03-visual-'));
  await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "upgrade-demo"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = ["requests>=2.32,<3"]\n');
  await fs.writeFile(path.join(root, 'main.py'), 'import requests\n');
  await run('uv', ['lock', '--project', root, '--upgrade-package', 'requests==2.32.3', '--no-build', '--no-python-downloads'], { cwd: root, timeout: 120000 });
  const service = new ProjectService({ root, helperPath });
  await service.applyPreview(await service.preview([], 'repair'));
  const state = await service.scan();
  const maintenance = { tree: await service.dependencyTree('urllib3'), health: await service.healthCheck(), updates: await service.checkUpdates() };
  const preview = await service.preview(['requests'], 'upgrade');
  const before = await fs.readFile(path.join(root, 'uv.lock'));
  const css = await fs.readFile(path.join(project, 'media/panel.css'), 'utf8');
  const js = await fs.readFile(path.join(project, 'media/panel.js'), 'utf8');
  const playwright = require(process.env.ENV_FOLLOW_PLAYWRIGHT_MODULE || 'playwright');
  const browser = await playwright.chromium.launch({ headless: true, channel: 'msedge' });
  const variables = ':root { --vscode-font-family: "Segoe UI", "Microsoft YaHei", sans-serif; --vscode-editor-font-family: Consolas, monospace; --vscode-foreground: #e4e7ea; --vscode-sideBar-background: #171b22; --vscode-editor-background: #1c222b; --vscode-descriptionForeground: #929ca9; --vscode-widget-border: #303945; --vscode-input-background: #202630; --vscode-input-foreground: #e4e7ea; --vscode-textLink-foreground: #85b9ed; --vscode-focusBorder: #62b4e8; --vscode-errorForeground: #eb8585; --vscode-editorWarning-foreground: #e9b568; }';
  const output = path.join(project, '.test-work', 'ui-v03.png');
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 980 }, deviceScaleFactor: 1.5 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<html lang="zh-CN"><head><meta charset="utf-8"><style>${variables}${css}</style></head><body><main id="content">${content({ state, preview, maintenance, projectNames: ['upgrade-demo'], ignored: [] })}</main></body></html>`);
    await page.addScriptTag({ content: 'window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>{window.lastAction=m}});' });
    await page.addScriptTag({ content: js });
    for (const [label, action] of [['检查环境', 'health'], ['查看完整树', 'tree'], ['搜索包关系', 'treePackage'], ['检查更新', 'updates'], ['确认应用计划', 'confirmAdd']]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      if ((await page.evaluate(() => window.lastAction.action)) !== action) throw new Error(label + ' message failed');
    }
    await page.locator('[data-action="upgrade"][data-name="requests"]').first().click();
    if ((await page.evaluate(() => window.lastAction.name)) !== 'requests') throw new Error('upgrade package message failed');
    await page.getByRole('searchbox').fill('requests');
    if (await page.locator('.dependency:visible').count() !== 1) throw new Error('search failed');
    await page.getByRole('searchbox').fill('');
    for (const width of [360, 240]) {
      await page.setViewportSize({ width, height: 980 });
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error(width + 'px overflow');
    }
    await page.setViewportSize({ width: 360, height: 980 });
    await page.screenshot({ path: output, fullPage: true });
    await page.locator('.preview').screenshot({ path: output.replace('.png', '-upgrade.png') });
    await page.locator('.maintenance').filter({ has: page.getByRole('heading', { name: '环境依赖树', exact: true }) }).screenshot({ path: output.replace('.png', '-tree.png') });
    // Display actual failure evidence from removing an installed transitive dependency.
    await run('uv', ['pip', 'uninstall', '--python', state.environment.python.path, 'idna'], { cwd: root });
    maintenance.health = await service.healthCheck();
    if (maintenance.health.status !== 'issues') throw new Error('missing dependency not diagnosed');
    await page.evaluate(html => window.dispatchEvent(new MessageEvent('message', { data: { type: 'render', html, busy: false } })), content({ state: await service.scan(), maintenance: { health: maintenance.health }, projectNames: ['upgrade-demo'], ignored: [] }));
    await page.locator('.maintenance').filter({ has: page.getByRole('heading', { name: '环境健康检查', exact: true }) }).screenshot({ path: output.replace('.png', '-health.png') });
    await page.setViewportSize({ width: 240, height: 900 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('health state overflow');
    await service.applyPreview(await service.preview([], 'repair'));
    if (!(await fs.readFile(path.join(root, 'uv.lock'))).equals(before)) throw new Error('read-only checks changed lock');
    if (errors.length) throw new Error(errors.join('\n'));
    const result = { success: true, root, output, checks: ['真实安装环境与升级计划', '正反依赖树', '真实缺失依赖错误', '健康/树/搜索包/更新/升级/确认按钮', '依赖搜索', '360px/240px 无溢出', '无前端异常'] };
    await fs.writeFile(path.join(project, '.test-work', 'ui-v03-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
