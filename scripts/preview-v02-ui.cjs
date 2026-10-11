// Visual QA of the production renderer and a real uv plan.
const fs = require('node:fs/promises');
const path = require('node:path');
const { ProjectService } = require('../dist/core.js');
const { content } = require('../dist/render.js');
async function main() {
  const root = path.join(__dirname, '..');
  const helperPath = path.join(root, 'python/inspect_project.py');
  const playwright = require(process.env.ENV_FOLLOW_PLAYWRIGHT_MODULE || 'playwright');
  const browser = await playwright.chromium.launch({ headless: true, channel: 'msedge' });
  const state = await new ProjectService({ root: path.join(root, 'examples/demo'), helperPath }).scan();
  const css = await fs.readFile(path.join(root, 'media/panel.css'), 'utf8');
  const js = await fs.readFile(path.join(root, 'media/panel.js'), 'utf8');
  const output = path.resolve(process.env.ENV_FOLLOW_PREVIEW_OUTPUT || path.join(root, '.test-work', 'ui-v02.png'));
  const planOutput = output.replace(/\.png$/, '-plan.png');
  const recoveryOutput = output.replace(/\.png$/, '-recovery.png');
  const variables = ':root { --vscode-font-family: "Segoe UI", "Microsoft YaHei", sans-serif; --vscode-editor-font-family: Consolas, monospace; --vscode-foreground: #e4e7ea; --vscode-sideBar-background: #171b22; --vscode-editor-background: #1c222b; --vscode-descriptionForeground: #929ca9; --vscode-widget-border: #303945; --vscode-input-background: #202630; --vscode-input-foreground: #e4e7ea; --vscode-textLink-foreground: #85b9ed; --vscode-focusBorder: #62b4e8; --vscode-errorForeground: #eb8585; --vscode-editorWarning-foreground: #e9b568; }';
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 980 }, deviceScaleFactor: 1.5 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<html lang="zh-CN"><head><meta charset="utf-8"><style>${variables}${css}</style></head><body><main id="content">${content({ state, projectNames: ['demo'], ignored: [] })}</main></body></html>`);
    await page.addScriptTag({ content: 'window.acquireVsCodeApi=()=>({ getState:()=>({}), setState:()=>{}, postMessage:m=>{window.lastAction=m} });' });
    await page.addScriptTag({ content: js });
    async function click(label, action) {
      await page.getByRole('button', { name: label, exact: true }).click();
      if ((await page.evaluate(() => window.lastAction.action)) !== action) throw new Error(label + ' message failed');
    }
    async function render(model) {
      await page.evaluate(html => window.dispatchEvent(new MessageEvent('message', { data: { type: 'render', html, busy: false } })), content(model));
    }
    async function verifyWidths() {
      for (const width of [360, 240]) {
        await page.setViewportSize({ width, height: 980 });
        if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error(width + 'px horizontal overflow');
      }
      await page.setViewportSize({ width: 360, height: 980 });
    }
    await click('预览并添加全部', 'addAll');
    await click('预览同步', 'sync');
    await click('选择依赖组', 'groups');
    await page.getByRole('searchbox').fill('numpy');
    if (await page.locator('.dependency:visible').count() !== 1) throw new Error('search filter failed');
    await page.getByRole('searchbox').fill('');
    if (await page.locator('.dependency:visible').count() !== 2) throw new Error('dependency rows did not return');
    await verifyWidths();
    await page.screenshot({ path: output, fullPage: true });

    const service = new ProjectService({ root: path.join(root, 'examples/existing-project'), helperPath });
    const existing = await service.scan();
    const preview = await service.preview([], 'requirements');
    await render({ state: existing, preview, projectNames: ['existing-project'], ignored: [] });
    await click('预览导入 requirements.txt', 'importRequirements');
    await click('确认应用计划', 'confirmAdd');
    if (await page.locator('.preview article').count() < 2) throw new Error('resolved transitives missing');
    await verifyWidths();
    await page.screenshot({ path: planOutput, fullPage: true });
    if (await fs.stat(path.join(service.options.root, '.venv')).then(() => true, () => false)) throw new Error('preview mutated example');

    // Error rendering scenario, independently of the real plan above.
    await render({ state: existing, error: 'No solution found: incompatible version constraints', recovery: { title: '依赖版本冲突', advice: '核对 pyproject.toml 或 requirements.txt 中的版本约束，然后重新生成计划。', category: 'conflict', stage: '解析依赖…', canRepair: false }, projectNames: ['existing-project'], ignored: [] });
    await click('重新扫描', 'refresh');
    await verifyWidths();
    await page.screenshot({ path: recoveryOutput, fullPage: true });
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(JSON.stringify({ success: true, output, planOutput, recoveryOutput, changes: preview.changes, checks: ['生产渲染器', '真实 requirements 完整解析计划', '预览不创建示例 .venv', '添加/同步/分组/导入/确认/重扫按钮', '包名搜索', '三种页面 360px / 240px 无溢出', '错误建议呈现', '无前端异常'] }, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
