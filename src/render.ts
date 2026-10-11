import { ProjectState, Preview, Dependency, RecoveryInfo, MaintenanceReports } from './types';
export interface PanelModel { state?: ProjectState; error?: string; recovery?: RecoveryInfo; busy?: string; preview?: Preview; maintenance?: MaintenanceReports; projectNames: string[]; ignored: string[] }
export const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const e = escapeHtml;
const button = (label: string, action: string, attrs = '', kind = ''): string => `<button class="${kind}" data-action="${action}" ${attrs}>${label}</button>`;
const bytes = (value: number): string => value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${(value / 1024 ** 3).toFixed(2)} GB`;
const STATUS: Record<Dependency['status'], [string, string]> = {
  ready: ['已就绪', 'good'], missing: ['缺失依赖', 'bad'], undeclared: ['未声明', 'warn'],
  'out-of-sync': ['环境未同步', 'bad'], 'possibly-unused': ['可能未使用', 'muted'],
  'installed-only': ['环境内其他包', 'muted'], conditional: ['分组 / 条件依赖', 'muted'], 'version-drift': ['版本与锁文件不同', 'warn']
};
const source = (file: string, line: number, label?: string) => button(e(label || `${file}:${line}`), 'source', `data-file="${e(file)}" data-line="${line}"`, 'source');

function renderPreview(plan: Preview): string {
  const changes = plan.changes || [];
  const known = plan.items.filter(item => item.directWheelBytes !== undefined);
  const total = known.length ? bytes(known.reduce((sum, item) => sum + item.directWheelBytes!, 0)) : changes.length ? '未知' : '无需变更环境包';
  const rows = changes.map(change => {
    const item = plan.items.find(row => row.name === change.name);
    return `<article><div class="dep-heading"><strong>${e(change.name)}</strong><span class="pill ${change.action === 'remove' ? 'bad' : change.action === 'replace' ? 'warn' : 'good'}">${change.action === 'install' ? '新增' : change.action === 'replace' ? '版本调整' : '移除'}</span></div>
      <div class="plan-version">${e(change.from || '未安装')} → ${e(change.to || '移除')}</div>
      ${item ? `<div class="hint">${item.direct ? '直接依赖' : '传递依赖 / 已有声明'} · wheel ${item.directWheelBytes === undefined ? '体积未知' : bytes(item.directWheelBytes)}</div><div class="hint">缓存：${item.cached ? item.cached.present ? '发现相关包文件（不保证可复用）' : '未发现对应文件' : '未能判断'}</div>` : ''}
      ${item?.error ? `<p class="hint warn">${e(item.error)}</p>` : ''}</article>`;
  }).join('');
  return `<section class="preview"><div class="section-heading"><h2>安装变更预览</h2>${button('关闭', 'closePreview', '', 'source')}</div>
    ${plan.upgrade ? `<div class="upgrade-summary"><strong>升级 ${e(plan.upgrade.name)}</strong><p class="hint">当前安装 ${e(plan.upgrade.installed)} · 解析后的锁定版本 ${e(plan.upgrade.target.join(' / ') || '未找到')}</p><p class="hint">保留约束：${e(plan.upgrade.constraints.join('；'))}</p>${plan.upgrade.lockChanges.length ? `<details open><summary>锁文件版本变化 (${plan.upgrade.lockChanges.length})</summary>${plan.upgrade.lockChanges.map(row => `<p class="hint"><strong>${e(row.name)}</strong> ${e(row.before.join(' / ') || '无')} → ${e(row.after.join(' / ') || '无')}</p>`).join('')}</details>` : '<p class="hint">当前约束下锁定版本未变化；环境仍可能需要同步。</p>'}<p class="hint">锁文件包含其他 Python / 平台及未启用组的版本；本环境实际变更见下方。</p></div>` : ''}
    <p class="plan-counts">新增 ${changes.filter(row => row.action === 'install').length} · 替换 ${changes.filter(row => row.action === 'replace').length} · 移除 ${changes.filter(row => row.action === 'remove').length}</p>
    ${plan.scope && plan.scope !== 'runtime' ? `<p class="hint">声明写入 ${e(plan.scope)}；安装取决于启用的依赖组。</p>` : ''}
    ${plan.requested?.length && !plan.upgrade ? `<details><summary>本次声明 (${plan.requested.length})</summary><p class="hint">${e(plan.requested.join(', '))}</p></details>` : ''}
    ${rows || '<p class="hint">环境包无需调整；声明或锁文件仍可能更新。</p>'}
    <div class="estimate"><span>已知 wheel 体积合计</span><strong>${total}</strong></div><p class="hint">${e(plan.note)}</p>
    ${button('确认应用计划', 'confirmAdd')}<p class="hint">确认时检查计划是否过期。保留额外包，只安装 wheel。</p></section>`;
}
function renderDependency(item: Dependency): string {
  const [label, color] = STATUS[item.status];
  const location = item.locations[0];
  return `<article class="dependency" data-search="${e([item.name, ...item.modules].join(' ').toLowerCase())}" ${item.status === 'installed-only' ? 'data-extra="true"' : ''}>
    <div class="dep-heading"><strong>${e(item.name)}</strong><span class="version">${e(item.version || '—')}</span></div>
    <div class="dep-status"><span class="pill ${color}">${label}</span>${item.scopes.filter(scope => scope !== 'runtime').map(scope => `<span class="scope">${e(scope)}</span>`).join('')}</div>
    <div class="state-line">${[['使用', item.used], ['声明', item.declared], ['安装', item.installed]].map(([label, checked]) => `<span class="${checked ? 'checked' : ''}">${checked ? '●' : '○'} ${label}</span>`).join('')}</div>
    ${item.modules.length ? `<div class="hint">import ${e(item.modules.join(', '))}</div>` : ''}
    ${location ? `<div class="dep-bottom">${source(location.file, location.line)}${item.used && !item.declared ? button('预览添加', 'add', `data-name="${e(item.name)}"`, 'small') : ''}</div>` : ''}
    ${item.installed ? `<div class="actions">${button('依赖关系', 'tree', `data-name="${e(item.name)}"`, 'source')}${item.declared ? button('预览升级', 'upgrade', `data-name="${e(item.name)}"`, 'source') : ''}</div>` : ''}
    ${item.status === 'possibly-unused' ? '<div class="hint">静态 import 未发现使用，已保留此依赖。</div>' : ''}
    ${item.status === 'version-drift' ? `<div class="hint">锁定版本：${e(item.lockedVersions.join(', '))}</div>` : ''}</article>`;
}
export function renderMaintenance(state: ProjectState, reports: MaintenanceReports = {}): string {
  const { health, tree, updates } = reports;
  const time = (date: string) => e(new Date(date).toLocaleTimeString('zh-CN'));
  const healthHtml = `<section class="maintenance"><div class="section-heading"><h2>环境健康检查</h2>${button('检查环境', 'health', '', 'secondary small')}</div>
    ${health ? `<p class="${health.status === 'healthy' ? 'good' : 'bad'}">${health.status === 'healthy' ? '已安装依赖兼容' : '发现依赖兼容性问题'}</p><p class="hint">${time(health.checkedAt)} · 仅检查当前项目环境</p><details ${health.status === 'issues' ? 'open' : ''}><summary>uv 检查结果</summary><pre>${e(health.output)}</pre></details>${health.status === 'issues' && state.inspection.manifest.lockExists ? button('预览按锁文件修复', 'repair', '', 'secondary small') : ''}` : '<p class="hint">检查传递依赖缺失和版本冲突。尚未检查。</p>'}
    ${health?.status === 'issues' ? '<p class="hint">核对结果中的缺失包和版本约束。按锁文件修复会保留额外包；额外包引起的冲突可能需要单独处理。</p>' : ''}<p class="hint">只读检查，不执行项目代码。</p></section>`;
  const treeHtml = `<section class="maintenance"><div class="section-heading"><h2>环境依赖树</h2>${button('查看完整树', 'tree', '', 'secondary small')}</div><div class="actions">${button('搜索包关系', 'treePackage', '', 'source')}</div>
    ${tree ? `<p class="hint">${tree.name ? '聚焦 ' + e(tree.name) : '当前已安装环境'} · ${time(tree.checkedAt)} · 最多 8 层</p><details open><summary>${tree.name ? '它依赖哪些包' : '已安装包之间的关系'}</summary><pre class="dependency-tree">${e(tree.forward || '环境中没有包。')}</pre></details>${tree.reverse !== undefined ? `<details open><summary>哪些包依赖它</summary><pre class="dependency-tree">${e(tree.reverse || '没有找到反向依赖。')}</pre></details>` : ''}${tree.truncated ? '<p class="hint warn">结果超过显示上限，已截断；请搜索具体包查看。</p>' : ''}<p class="hint">依赖要求来自已安装包元数据；不代表代码实际调用关系。</p>` : '<p class="hint">查看谁依赖谁，或搜索包名反查引入关系。</p>'}</section>`;
  const updatesHtml = `<section class="maintenance"><div class="section-heading"><h2>依赖更新</h2>${button('检查更新', 'updates', '', 'secondary small')}</div><p class="hint">联网查询已安装包。包源的新版本未必满足项目约束；预览升级后才确定允许的版本。</p>
    ${updates ? `<p class="hint">检查于 ${time(updates.checkedAt)} · ${updates.items.length} 个包发现更新</p>${updates.items.map(row => {
      const declared = state.inspection.manifest.declared.some(item => item.name === row.name);
      return `<article class="update-row"><strong>${e(row.name)}</strong><div class="plan-version">${e(row.version)} → ${e(row.latest)}</div><div class="actions">${declared ? button('预览升级', 'upgrade', `data-name="${e(row.name)}"`, 'secondary small') : '<span class="hint">传递依赖 / 环境额外包，请从项目依赖维护。</span>'}${button('依赖关系', 'tree', `data-name="${e(row.name)}"`, 'source')}</div></article>`;
    }).join('') || '<p class="hint">本次包源查询未发现新版本。</p>'}` : ''}<div class="actions">${button('选择项目依赖升级', 'upgrade', '', 'source')}</div></section>`;
  return healthHtml + treeHtml + updatesHtml;
}
export function content(model: PanelModel): string {
  const state = model.state;
  const top = `<header><div class="eyebrow"><span class="logo">⬡</span> ENV FOLLOW <span class="tag">v0.3</span></div><h1>代码在写，<br>环境跟上。</h1><p class="subtitle">You write code. Your environment follows.</p></header>`;
  const toolbar = `<div class="toolbar">${button('选择项目', 'select', '', 'secondary')}${button('刷新', 'refresh', '', 'secondary')}${button('日志', 'log', '', 'secondary')}</div>`;
  const recovery = model.recovery;
  const error = model.error ? `<section class="error"><strong>${e(recovery?.title || '操作未完成')}</strong><p>${e(recovery?.advice || '')}</p>${recovery?.stage ? `<p class="hint">停在：${e(recovery.stage)}</p>` : ''}${recovery?.changedPackages?.length ? `<p>检测到环境已变化：${e(recovery.changedPackages.join(', '))}</p>` : ''}<details><summary>完整错误</summary><pre>${e(model.error)}</pre></details><div class="actions">${button('重新扫描', 'refresh')}${recovery?.canRepair && state?.inspection.manifest.lockExists ? button('预览按锁文件修复', 'repair', '', 'secondary') : ''}${button('查看日志', 'log', '', 'secondary')}</div></section>` : '';
  if (!state) return `${top}${toolbar}${model.busy ? `<p>${e(model.busy)}</p>` : ''}${error}<section class="empty"><h2>打开一个 Python 项目</h2><p>打开含 .py 文件的文件夹，或选择工作区项目。</p>${button('打开文件夹', 'openFolder')}</section>`;
  const { environment: env, inspection, dependencies, resolutions, editor } = state;
  const addable = dependencies.filter(item => item.used && !item.declared);
  const unknown = resolutions.filter(item => !item.ignored && item.confidence !== 'high');
  const newItems = resolutions.filter(item => !item.ignored && item.package && addable.some(dep => dep.name === item.package));
  const issues = dependencies.filter(item => ['missing', 'undeclared', 'out-of-sync', 'version-drift'].includes(item.status)).length + unknown.length + Number(['mismatch', 'invalid'].includes(editor?.status || '')) + Number(model.maintenance?.health?.status === 'issues');
  const project = `<div class="project"><span class="label">PROJECT ENVIRONMENT</span><h2>${e(inspection.manifest.name)}</h2><div class="path">${e(state.root)}</div><div class="health ${issues ? 'warn' : 'good'}"><span class="dot"></span>${issues ? `${issues} 项需要确认` : '依赖状态已就绪'}${model.busy ? `<span class="working">${e(model.busy)}</span>` : ''}</div></div>`;
  const editorLabel = editor?.status === 'aligned' ? '与项目一致' : editor?.status === 'mismatch' ? '与项目不一致' : editor?.status === 'invalid' ? '解释器不可用' : '尚未连接 Python 扩展';
  const overview = `<section class="overview"><div class="env-row"><span>项目 Python</span><strong>${e(env.python?.version || '未检测到')}</strong></div><div class="path">${e(env.python?.path || '请配置 Python')}</div>${inspection.manifest.requiresPython ? `<div class="hint">项目要求 ${e(inspection.manifest.requiresPython)}</div>` : ''}
    <div class="env-row border"><span>编辑器 Python</span><strong>${e(editor?.version || '—')}</strong></div><div class="path">${e(editor?.path || '安装 Microsoft Python 扩展后可检测')}</div><div class="hint ${editor?.status === 'aligned' ? 'good' : editor?.status === 'mismatch' || editor?.status === 'invalid' ? 'warn' : 'muted'}">${editorLabel}</div>
    <div class="env-row border"><span>项目环境</span><strong class="${env.venvExists ? 'good' : 'warn'}">${env.venvExists ? '.venv 已创建' : '尚未创建'}</strong></div><div class="env-row border"><span>依赖管理器</span><strong title="${e(env.uvVersion || env.uvError)}" class="${env.uvVersion ? 'good' : 'bad'}">${e(env.uvVersion?.match(/^uv\s+\S+/)?.[0] || '未找到 uv')}</strong></div><div class="hint">${inspection.manifest.exists ? 'pyproject.toml ✓' : 'pyproject.toml 待创建'} · ${inspection.manifest.lockExists ? 'uv.lock ✓' : 'uv.lock 待生成'}</div>
    <div class="actions">${button(env.venvExists ? '切换到项目 Python' : '创建环境', env.venvExists ? 'interpreter' : 'create')}${button('预览同步', 'sync', '', 'secondary')}${env.venvExists ? button('运行当前文件', 'run', '', 'secondary') : ''}${inspection.manifest.lockExists ? button('预览修复', 'repair', '', 'source') : ''}</div></section>`;
  const selection = state.selection;
  const groups = `<section class="groups"><div class="section-heading"><h2>安装范围</h2>${button('选择依赖组', 'groups', '', 'source')}</div><p class="hint">运行依赖 · ${selection?.noDev ? '不启用 dev' : 'uv 默认组'}${selection?.groups.length ? ' · group: ' + e(selection.groups.join(', ')) : ''}${selection?.extras.length ? ' · extra: ' + e(selection.extras.join(', ')) : ''}</p></section>`;
  const req = inspection.requirements;
  const requirements = req?.exists ? `<section class="requirements"><div class="section-heading"><h2>接入已有项目</h2><span class="pill muted">requirements.txt</span></div><p class="hint">检测到 ${req.entries.length} 条依赖声明。${req.unsupported.length ? `${req.unsupported.length} 行需处理，文件核实后才能导入。` : '保留版本约束，先预览再导入。'}</p>${button('预览导入 requirements.txt', 'importRequirements', '', 'secondary small')}</section>` : '';
  const counts = `<div class="counts">${[['代码使用', dependencies.filter(item => item.used).length], ['项目声明', dependencies.filter(item => item.declared).length], ['环境安装', inspection.installed.length]].map(([label, count]) => `<div><strong>${count}</strong><span>${label}</span></div>`).join('')}</div>`;
  const suggestions = newItems.length ? `<section class="suggestions"><div class="section-heading"><h2>发现新依赖</h2><span class="number">${addable.length}</span></div>${newItems.map(item => `<div class="mapping"><code>${e(item.module)}</code><span>→</span><strong>${e(item.package)}</strong><span class="pill good">高置信度</span></div>`).join('')}<p class="hint">确认前解析实际版本及传递依赖。</p><div class="actions">${button('预览并添加全部', 'addAll')}${button('添加到其他组', 'addScoped', '', 'secondary small')}</div></section>` : '';
  const unresolved = unknown.length ? `<section><div class="section-heading"><h2>需要核实的 import</h2><span class="number">${unknown.length}</span></div>${unknown.map(item => `<article class="unknown"><div class="dep-heading"><code>${e(item.module)}</code><span class="pill warn">${item.confidence === 'unknown' ? '未知' : '有歧义'}</span></div><p>${e(item.reason)}</p>${item.candidates.length ? `<p class="hint">可能相关：${e(item.candidates.join(' / '))}。若为拼写错误，请先修改代码。</p>` : ''}<div class="actions">${button('确认包名映射', 'map', `data-module="${e(item.module)}"`, 'secondary small')}${button('忽略', 'ignore', `data-module="${e(item.module)}"`, 'secondary small')}${item.locations[0] ? source(item.locations[0].file, item.locations[0].line, '查看代码') : ''}</div></article>`).join('')}</section>` : '';
  const warnings = [...inspection.warnings, ...(inspection.scan.truncated ? ['达到扫描文件上限，结果不完整。'] : []), ...(inspection.scan.errors.length ? [`${inspection.scan.errors.length} 个文件无法解析，未使用判断可能不完整。`] : []), ...(env.pythonError ? ['项目 Python 检测异常，请检查项目版本要求和解释器。'] : [])];
  const warningHtml = warnings.length ? `<details class="warnings" open><summary>扫描提示 (${warnings.length})</summary>${warnings.map(value => `<p>${e(value)}</p>`).join('')}${inspection.scan.errors.slice(0, 10).map(row => `<div>${source(row.file, row.line)}<p>${e(row.message)}</p></div>`).join('')}</details>` : '';
  const filtered = Object.values(inspection.scan.filtered).reduce((sum, values) => sum + values.length, 0);
  return `${top}${toolbar}${project}${error}${overview}${groups}${requirements}${counts}${model.preview ? renderPreview(model.preview) : ''}${suggestions}${unresolved}${warningHtml}${renderMaintenance(state, model.maintenance)}
    <section><div class="section-heading"><h2>依赖状态</h2><span class="number">${dependencies.length}</span></div><input id="search" class="search" type="search" aria-label="搜索依赖" placeholder="搜索包名 / import…"><label class="toggle"><input id="showExtra" type="checkbox">显示环境内其他包（含传递依赖）</label><div id="dependencies">${dependencies.map(renderDependency).join('') || '<div class="empty">还没有依赖。添加 import 并保存。</div>'}</div></section>
    ${model.ignored.length ? `<details><summary>已忽略 (${model.ignored.length})</summary><p>${e(model.ignored.join(', '))}</p>${button('恢复所有忽略项', 'resetIgnored', '', 'secondary small')}</details>` : ''}
    <footer>已扫描 ${inspection.scan.fileCount} 个文件 · 过滤 ${filtered} 项<br>保存 .py 后自动刷新 · ${e(new Date(state.scannedAt).toLocaleTimeString('zh-CN'))}<br>运行按钮直接使用项目环境，不自动安装依赖。<br>静态分析无法覆盖动态导入和插件使用。</footer>`;
}
