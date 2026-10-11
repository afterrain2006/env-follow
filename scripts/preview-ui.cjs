// Optional visual QA of the actual panel renderer. Supply Playwright via
// ENV_FOLLOW_PLAYWRIGHT_MODULE if it is not installed in this project.
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
const { ProjectService } = require('../dist/core.js');

async function main() {
  const root = path.join(__dirname, '..');
  const target = path.join(root, '.test-work', 'ui-renderer.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/panel.ts')], bundle: true, platform: 'node', outfile: target,
    plugins: [{ name: 'vscode-render-only', setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
    } }]
  });
  const { content } = require(target);
  const playwright = require(process.env.ENV_FOLLOW_PLAYWRIGHT_MODULE || 'playwright');
  const browser = await playwright.chromium.launch({ headless: true, channel: 'msedge' });
  const state = await new ProjectService({ root: path.join(root, 'examples/demo'), helperPath: path.join(root, 'python/inspect_project.py') }).scan();
  const css = await fs.readFile(path.join(root, 'media/panel.css'), 'utf8');
  const js = await fs.readFile(path.join(root, 'media/panel.js'), 'utf8');
  const model = { state, projectNames: ['demo'], ignored: [] };
  const output = path.resolve(process.env.ENV_FOLLOW_PREVIEW_OUTPUT || path.join(root, '.test-work', 'ui-preview.png'));
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 980 }, deviceScaleFactor: 1.5 });
    const variables = ':root { --vscode-font-family: "Segoe UI", "Microsoft YaHei", sans-serif; --vscode-editor-font-family: Consolas, monospace; --vscode-foreground: #e4e7ea; --vscode-sideBar-background: #171b22; --vscode-editor-background: #1c222b; --vscode-descriptionForeground: #929ca9; --vscode-widget-border: #303945; --vscode-input-background: #202630; --vscode-input-foreground: #e4e7ea; --vscode-textLink-foreground: #85b9ed; --vscode-focusBorder: #62b4e8; --vscode-errorForeground: #eb8585; --vscode-editorWarning-foreground: #e9b568; }';
    await page.setContent(`<html lang="zh-CN"><head><meta charset="utf-8"><style>${variables}${css}</style></head><body><main id="content">${content(model)}</main></body></html>`);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addScriptTag({ content: 'window.acquireVsCodeApi=()=>({ getState:()=>({}), setState:()=>{}, postMessage:m=>{window.lastAction=m} });' });
    await page.addScriptTag({ content: js });
    await page.getByRole('button', { name: '预览并添加全部' }).click();
    if ((await page.evaluate(() => window.lastAction.action)) !== 'addAll') throw new Error('add-all button message failed');
    await page.getByRole('searchbox').fill('numpy');
    if (await page.locator('.dependency:visible').count() !== 1) throw new Error('search filter failed');
    await page.getByRole('searchbox').fill('');
    if (await page.locator('.dependency:visible').count() !== 2) throw new Error('dependency rows did not return');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) throw new Error('panel has horizontal overflow');
    if (errors.length) throw new Error(errors.join('\n'));
    await page.screenshot({ path: output, fullPage: true });
    await page.setViewportSize({ width: 240, height: 900 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('narrow sidebar has horizontal overflow');
    console.log(JSON.stringify({ success: true, output, checks: ['实际面板渲染', '添加全部按钮消息', '包名搜索', '360px / 240px 无横向溢出', '无前端异常'] }, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
