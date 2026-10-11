/* Only extension-generated, escaped HTML enters the view. */
const vscode = acquireVsCodeApi();
let busy = false;
const applyFilter = () => {
  const search = (document.getElementById('search')?.value || '').trim().toLowerCase();
  const extra = !!document.getElementById('showExtra')?.checked;
  for (const row of document.querySelectorAll('.dependency')) row.hidden = (!extra && row.dataset.extra === 'true') || !row.dataset.search.includes(search);
  vscode.setState({ search, extra });
};
const restore = () => {
  const saved = vscode.getState() || {};
  const search = document.getElementById('search');
  const extra = document.getElementById('showExtra');
  if (search) search.value = saved.search || '';
  if (extra) extra.checked = !!saved.extra;
  applyFilter();
  document.querySelectorAll('button').forEach(button => { button.disabled = busy && !['log', 'source'].includes(button.dataset.action); });
};
document.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  vscode.postMessage({ action: button.dataset.action, name: button.dataset.name, module: button.dataset.module, file: button.dataset.file, line: Number(button.dataset.line) || 1 });
});
document.addEventListener('input', event => { if (event.target.id === 'search') applyFilter(); });
document.addEventListener('change', event => { if (event.target.id === 'showExtra') applyFilter(); });
window.addEventListener('message', event => {
  if (event.data.type !== 'render') return;
  busy = event.data.busy;
  const position = document.documentElement.scrollTop;
  document.getElementById('content').innerHTML = event.data.html;
  restore();
  document.documentElement.scrollTop = position;
});
restore();
vscode.postMessage({ action: 'ready' });
