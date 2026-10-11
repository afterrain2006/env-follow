import * as vscode from 'vscode';
import * as path from 'node:path';
import { EnvironmentPanel, PanelModel } from './panel';
import { ProjectService, OperationFailure } from './service';
import { ProjectState, Preview, ServiceOptions, PreviewKind, RecoveryInfo, EditorInterpreter, MaintenanceReports } from './types';
import { isPackageName } from './resolver';
import { compareInterpreter, projectRunSpec } from './interpreter';
import { classifyError } from './errors';
import { defaultSelection, fingerprint } from './planning';

interface PythonApi { environments: { getActiveEnvironmentPath(resource?: vscode.Uri): { path: string }; updateActiveEnvironmentPath(value: string, resource?: vscode.Uri): Promise<void>; onDidChangeActiveEnvironmentPath: vscode.Event<unknown> } }

interface ViewMessage { action: string; name?: string; module?: string; file?: string; line?: number }
class Controller implements vscode.Disposable {
  private folder?: vscode.WorkspaceFolder;
  private state?: ProjectState;
  private preview?: Preview;
  private maintenance: MaintenanceReports = {};
  private error?: string;
  private recovery?: RecoveryInfo;
  private pythonApi?: PythonApi;
  private stage?: string;
  private busy?: string;
  private scanning = false;
  private pending = false;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly output = vscode.window.createOutputChannel('Env Follow');
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('env-follow');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  readonly panel: EnvironmentPanel;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = new EnvironmentPanel(context.extensionUri, message => { void this.receive(message).catch(error => this.report(error)); });
    this.folder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file');
    this.status.command = 'envFollow.open';
    this.disposables.push(this.output, this.status, this.diagnostics,
      vscode.workspace.onDidSaveTextDocument(doc => { if (this.inProject(doc.uri) && /(?:\.py|pyproject\.toml|uv\.lock|uv\.toml|requirements\.txt|\.python-version|pyvenv\.cfg)$/.test(doc.fileName)) this.schedule(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (!this.folder || !vscode.workspace.workspaceFolders?.some(folder => folder.uri.toString() === this.folder!.uri.toString())) this.setFolder(vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file'));
        this.render();
      }),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('envFollow')) { this.preview = undefined; this.maintenance = {}; this.schedule(); } }),
      vscode.extensions.onDidChange(() => { void this.connectPython().then(() => this.schedule()).catch(error => this.output.appendLine(String(error))); })
    );
    const watcher = vscode.workspace.createFileSystemWatcher('**/{*.py,pyproject.toml,uv.lock,uv.toml,.python-version,requirements.txt,pyvenv.cfg}');
    this.disposables.push(watcher, watcher.onDidCreate(uri => { if (this.inProject(uri)) this.schedule(); }), watcher.onDidChange(uri => { if (this.inProject(uri)) this.schedule(); }), watcher.onDidDelete(uri => { if (this.inProject(uri)) this.schedule(); }));
    this.render();
    void this.refresh();
  }
  private async connectPython(): Promise<void> {
    if (this.pythonApi) return;
    const extension = vscode.extensions.getExtension<PythonApi>('ms-python.python');
    if (!extension) return;
    const api = await extension.activate();
    if (!api?.environments?.getActiveEnvironmentPath || this.pythonApi) return;
    this.pythonApi = api;
    this.disposables.push(api.environments.onDidChangeActiveEnvironmentPath(() => this.schedule()));
  }
  private async editorStatus(state: ProjectState): Promise<EditorInterpreter> {
    try {
      await this.connectPython();
      const selected = this.pythonApi?.environments.getActiveEnvironmentPath(vscode.Uri.file(state.root)).path;
      return await compareInterpreter(selected, state.environment.python, state.environment.venvExists);
    } catch (error) { return { status: 'unavailable', detail: String(error) }; }
  }
  private inProject(uri: vscode.Uri): boolean {
    if (!this.folder || uri.scheme !== 'file') return false;
    const relative = path.relative(this.folder.uri.fsPath, uri.fsPath);
    const segments = relative.split(path.sep);
    return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative) && !segments.some(segment => ['.venv', 'venv', '.git', 'node_modules', '__pycache__', '.test-work'].includes(segment));
  }
  private ignoredKey(): string { return 'ignored:' + this.folder?.uri.toString(); }
  private ignored(): string[] { return this.context.workspaceState.get<string[]>(this.ignoredKey(), []); }
  private service(): ProjectService {
    if (!this.folder) throw new Error('请先打开一个本地项目文件夹。');
    if (!vscode.workspace.isTrusted) throw new Error('请先信任工作区后使用环境管理功能。');
    const config = vscode.workspace.getConfiguration('envFollow', this.folder.uri);
    const options: ServiceOptions = {
      root: this.folder.uri.fsPath, helperPath: vscode.Uri.joinPath(this.context.extensionUri, 'python', 'inspect_project.py').fsPath,
      uvPath: config.get<string>('uvPath', 'uv'), pythonPath: config.get<string>('pythonPath', '') || undefined,
      maxFiles: config.get<number>('maxFiles', 4000), exclude: config.get<string[]>('excludeDirectories', []),
      mappings: config.get<Record<string, string>>('importMappings', {}), ignored: this.ignored(), log: text => this.output.append(text),
      selection: { extras: config.get<string[]>('activeExtras', []), groups: config.get<string[]>('activeGroups', []), noDev: config.get<boolean>('excludeDev', false) },
      onProgress: stage => { this.stage = stage; if (this.busy) this.busy = stage; this.render(); }
    };
    return new ProjectService(options);
  }
  private render(): void {
    const model: PanelModel = { state: this.state, maintenance: this.maintenance, error: this.error, recovery: this.recovery, busy: this.busy || (this.scanning ? '正在扫描…' : undefined), preview: this.preview, projectNames: vscode.workspace.workspaceFolders?.map(folder => folder.name) || [], ignored: this.ignored() };
    this.panel.update(model);
    if (this.state) {
      const count = this.state.dependencies.filter(item => ['missing', 'undeclared', 'out-of-sync', 'version-drift'].includes(item.status)).length + this.state.resolutions.filter(item => !item.ignored && item.confidence !== 'high').length + Number(['mismatch', 'invalid'].includes(this.state.editor?.status || '')) + Number(this.maintenance.health?.status === 'issues');
      this.status.text = `$(package) Env Follow ${count ? '· ' + count + ' 项待确认' : '· 已就绪'}`;
      this.status.tooltip = `${this.state.root}\nPython ${this.state.environment.python?.version || '未知'} · ${this.state.environment.venvExists ? '.venv' : '无项目环境'}\n点击打开环境面板`;
      this.status.show();
    } else this.status.hide();
  }
  report(error: unknown): void { this.error = error instanceof Error ? error.message : String(error); this.recovery = error instanceof OperationFailure ? error.recovery : classifyError(error); this.recovery.stage = this.stage; this.output.appendLine('\n' + this.error); this.render(); }
  private schedule(): void {
    clearTimeout(this.timer);
    const delay = vscode.workspace.getConfiguration('envFollow', this.folder?.uri).get<number>('scanDelay', 700);
    this.timer = setTimeout(() => { void this.refresh(); }, delay);
  }
  async refresh(): Promise<void> {
    if (this.busy || this.scanning) { this.pending = true; return; }
    if (!this.folder || !vscode.workspace.isTrusted) { this.render(); return; }
    const generation = this.generation;
    this.scanning = true; this.render();
    try {
      const service = this.service();
      const state = await service.scan();
      state.editor = await this.editorStatus(state);
      if (generation !== this.generation) return;
      if (Object.keys(this.maintenance).length) {
        const current = await fingerprint(service.options, state.environment);
        if (generation !== this.generation) return;
        this.maintenance = Object.fromEntries(Object.entries(this.maintenance).filter(([, report]) => report.root === state.root && report.fingerprint === current));
      }
      if (generation !== this.generation) return;
      this.state = state;
      if (state.environment.uvError) this.output.appendLine(state.environment.uvError);
      if (state.environment.pythonError) this.output.appendLine(state.environment.pythonError);
      this.publishDiagnostics(state);
    } catch (error) { if (generation === this.generation) this.report(error); }
    finally {
      this.scanning = false; this.render();
      if (this.pending) { this.pending = false; this.schedule(); }
    }
  }
  private publishDiagnostics(state: ProjectState): void {
    this.diagnostics.clear();
    const grouped = new Map<string, vscode.Diagnostic[]>();
    for (const usage of state.resolutions.filter(item => !item.ignored)) {
      const dependency = state.dependencies.find(item => item.name === usage.package);
      if (usage.confidence === 'high' && !dependency || dependency?.status === 'ready' || dependency?.status === 'possibly-unused') continue;
      let message = usage.confidence === 'high' ? `${usage.package}: ${dependency?.status === 'undeclared' ? '代码使用此包，但 pyproject.toml 未声明。' : dependency?.status === 'version-drift' ? '已安装版本与 uv.lock 不同。' : '项目环境缺少此依赖。'} 在 Env Follow 面板中确认添加或同步。` : `${usage.module}: ${usage.reason}${usage.candidates.length ? '。可能相关：' + usage.candidates.join(', ') : ''}。不会自动安装。`;
      for (const location of usage.locations) {
        const file = path.join(state.root, location.file);
        const line = Math.max(0, location.line - 1);
        const diagnostic = new vscode.Diagnostic(new vscode.Range(line, location.column, line, location.column + 1), message, usage.confidence === 'unknown' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning);
        diagnostic.source = 'Env Follow';
        diagnostic.code = dependency?.status || usage.confidence;
        const rows = grouped.get(file) || []; rows.push(diagnostic); grouped.set(file, rows);
      }
    }
    for (const [file, rows] of grouped) this.diagnostics.set(vscode.Uri.file(file), rows);
  }
  private setFolder(folder?: vscode.WorkspaceFolder): void { this.folder = folder; this.generation++; this.state = undefined; this.preview = undefined; this.maintenance = {}; this.error = undefined; this.recovery = undefined; this.diagnostics.clear(); this.render(); this.schedule(); }
  async selectProject(): Promise<void> {
    if (this.busy) return;
    const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') || [];
    if (!folders.length) { await vscode.commands.executeCommand('vscode.openFolder'); return; }
    const choice = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { placeHolder: '选择要管理的 Python 项目' });
    if (choice) this.setFolder(choice.folder);
  }
  async inspectMaintenance(kind: 'tree' | 'health' | 'updates', name?: string): Promise<void> {
    if (this.busy) return;
    const service = this.service(), generation = this.generation;
    delete this.maintenance[kind];
    this.busy = kind === 'tree' ? '读取环境依赖树…' : kind === 'health' ? '检查环境兼容性…' : '联网检查可用更新…';
    this.error = undefined; this.recovery = undefined; this.stage = this.busy; this.render();
    try {
      const report = kind === 'tree' ? await service.dependencyTree(name) : kind === 'health' ? await service.healthCheck() : await service.checkUpdates();
      if (generation !== this.generation) return;
      this.maintenance = Object.fromEntries(Object.entries(this.maintenance).filter(([, previous]) => previous.fingerprint === report.fingerprint && previous.root === report.root));
      if (kind === 'tree') this.maintenance.tree = report as MaintenanceReports['tree'];
      else if (kind === 'health') this.maintenance.health = report as MaintenanceReports['health'];
      else this.maintenance.updates = report as MaintenanceReports['updates'];
    } catch (error) { if (generation === this.generation) this.report(error); }
    finally { this.busy = undefined; this.render(); await this.refresh(); }
    await vscode.commands.executeCommand('envFollow.open');
  }
  async upgradePackage(name?: string): Promise<void> {
    if (this.busy || !this.state) return;
    const root = this.state.root;
    const choices = this.state.dependencies.filter(row => row.declared && row.installed);
    if (!name) {
      const selected = await vscode.window.showQuickPick(choices.map(row => ({ label: row.name, description: '当前 ' + row.version, name: row.name })), { title: '选择要预览升级的项目依赖', placeHolder: '保留声明约束，只解析这个包的升级及相关变化' });
      if (!selected) return;
      name = selected.name;
    }
    if (this.state?.root !== root) throw new Error('所选项目已改变，请重新选择依赖。');
    if (!choices.some(row => row.name === name)) throw new Error('请选择已声明且已安装的项目依赖，传递依赖请从引入它的项目依赖升级。');
    await this.showPreview([name], 'upgrade');
  }
  async chooseTreePackage(): Promise<void> {
    if (this.busy || !this.state) return;
    const root = this.state.root;
    const choice = await vscode.window.showQuickPick(this.state.inspection.installed.map(row => ({ label: row.name, description: row.version, name: row.name })), { title: '搜索已安装包，查看依赖与反向依赖' });
    if (choice) {
      if (this.state?.root !== root) throw new Error('所选项目已改变，请重新选择包。');
      await this.inspectMaintenance('tree', choice.name);
    }
  }
  async showPreview(names?: string[], kind: PreviewKind = 'add', scope = 'runtime'): Promise<void> {
    if (this.busy) return;
    if (this.scanning) { await vscode.window.showInformationMessage('正在扫描，请稍后再预览。'); return; }
    const allowed = this.state?.dependencies.filter(item => item.used && !item.declared).map(item => item.name) || [];
    const selected = names || (kind === 'add' ? allowed : []);
    if (kind === 'add' && !selected.length) { await vscode.window.showInformationMessage('没有需要添加的已识别依赖。'); return; }
    if (kind === 'add' && !selected.every(name => allowed.includes(name) && isPackageName(name))) throw new Error('建议已发生变化，请先刷新。');
    this.busy = '生成安装计划…'; this.error = undefined; this.recovery = undefined; this.preview = undefined; this.render();
    try { this.preview = await this.service().preview(selected, kind, scope); }
    catch (error) { this.report(error); }
    finally { this.busy = undefined; this.render(); if (this.pending) { this.pending = false; this.schedule(); } }
    await vscode.commands.executeCommand('envFollow.open');
  }
  async mutate(kind: 'create' | 'sync' | 'add'): Promise<void> {
    if (this.busy || this.scanning) { await vscode.window.showInformationMessage('当前操作进行中，请稍后重试。'); return; }
    if (this.state?.environment.uvError) throw new Error('未找到可用的 uv。请安装 uv，或在设置中配置 envFollow.uvPath。');
    const service = this.service();
    if (kind === 'sync') { await this.showPreview([], 'sync'); return; }
    const plan = this.preview;
    const packages = kind === 'add' ? plan?.requested || [] : [];
    if (kind === 'add' && !plan) { await this.showPreview(); return; }
    const allowed = this.state?.dependencies.filter(item => item.used && !item.declared).map(item => item.name) || [];
    if (kind === 'add' && plan?.kind === 'add' && !packages.every(name => allowed.includes(name))) throw new Error('待添加依赖已变化，请关闭预览并重新扫描。');
    const label = kind === 'create' ? '创建环境' : plan?.kind === 'upgrade' ? '升级依赖' : plan?.kind === 'requirements' ? '导入依赖' : plan?.kind === 'repair' ? '按锁文件修复' : plan?.kind === 'sync' ? '同步环境' : '添加依赖';
    const counts = plan?.changes || [];
    const detail = kind === 'add' ? `将应用已解析计划：新增 ${counts.filter(row => row.action === 'install').length} 个包，替换 ${counts.filter(row => row.action === 'replace').length} 个包，移除 ${counts.filter(row => row.action === 'remove').length} 个包。\n${packages.length ? '依赖：' + packages.join(', ') : ''}\n会更新 pyproject.toml、uv.lock 和 .venv，可能联网下载。` : '将在所选项目内创建 .venv。若没有 pyproject.toml，会初始化项目声明。不覆盖已有环境。';
    this.busy = '等待确认…'; this.render();
    let answer: string | undefined;
    try { answer = await vscode.window.showWarningMessage(`${label} · ${this.folder!.name}`, { modal: true, detail: `${detail}\n\n${service.options.root}` }, label); }
    finally { this.busy = undefined; this.render(); }
    if (answer !== label) { if (this.pending) { this.pending = false; this.schedule(); } return; }
    if (this.folder?.uri.fsPath !== service.options.root) throw new Error('所选项目已改变，请重新生成预览。');
    this.busy = `${label}中…`; this.error = undefined; this.recovery = undefined; this.preview = undefined; this.maintenance = {}; this.render();
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Env Follow · ${label}`, cancellable: false }, async () => {
        if (kind === 'create') await service.createEnvironment();
        else await service.applyPreview(plan!);
      });
      void vscode.window.showInformationMessage(`${label}完成。`);
    } catch (error) { this.report(error); this.output.show(true); }
    finally { this.busy = undefined; this.pending = false; await this.refresh(); }
  }
  async useInterpreter(): Promise<void> {
    const python = this.state?.environment.python;
    if (!this.folder || !this.state?.environment.venvExists || !python) throw new Error('请先创建有效的项目环境。');
    await this.connectPython();
    if (this.pythonApi) {
      const api = this.pythonApi;
      if (api.environments.updateActiveEnvironmentPath) {
        await api.environments.updateActiveEnvironmentPath(python.path, this.folder.uri);
        await this.refresh();
        void vscode.window.showInformationMessage('已将 VS Code Python 解释器切换到项目 .venv。');
        return;
      }
    }
    await vscode.workspace.getConfiguration('python', this.folder.uri).update('defaultInterpreterPath', python.path, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.env.clipboard.writeText(python.path);
    void vscode.window.showInformationMessage('已保存默认解释器并复制路径。若已选择过解释器，请运行 Python: Select Interpreter，粘贴此路径。');
  }
  async runCurrentFile(): Promise<void> {
    if (this.busy) throw new Error('请等待当前环境操作完成。');
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.folder || editor.document.languageId !== 'python') throw new Error('请先打开所选项目中的 Python 文件。');
    if (!this.inProject(editor.document.uri)) throw new Error('当前文件不属于所选项目。');
    if (editor.document.isDirty && !await editor.document.save()) return;
    // Refresh the executable immediately before running. Never sync/install implicitly.
    const state = await this.service().scan();
    const spec = await projectRunSpec(this.folder.uri.fsPath, editor.document.uri.fsPath, state.environment.python, state.environment.venvExists);
    const definition: vscode.TaskDefinition = { type: 'envFollow', task: 'runFile' };
    const task = new vscode.Task(definition, this.folder, `运行 ${path.basename(editor.document.fileName)}`, 'Env Follow', new vscode.ProcessExecution(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env }), []);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true, showReuseMessage: false };
    await vscode.tasks.executeTask(task);
  }
  async selectGroups(): Promise<void> {
    if (this.busy || !this.state || !this.folder) return;
    const current = this.state.selection || defaultSelection();
    const choices = [
      { label: '启用 dev 开发组', description: '其他默认组仍由 uv 配置决定', key: 'dev', picked: !current.noDev },
      ...(this.state.inspection.manifest.groups || []).filter(name => name !== 'dev').map(name => ({ label: `开发组 · ${name}`, description: '', key: 'group:' + name, picked: current.groups.includes(name) })),
      ...(this.state.inspection.manifest.extras || []).map(name => ({ label: `可选依赖 · ${name}`, description: '', key: 'extra:' + name, picked: current.extras.includes(name) }))
    ];
    const result = await vscode.window.showQuickPick(choices, { canPickMany: true, title: '选择本项目要启用的依赖组', placeHolder: '只保存选择；之后点击预览同步，确认后安装' });
    if (!result) return;
    const config = vscode.workspace.getConfiguration('envFollow', this.folder.uri);
    await config.update('activeExtras', result.filter(row => row.key.startsWith('extra:')).map(row => row.key.slice(6)), vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update('activeGroups', result.filter(row => row.key.startsWith('group:')).map(row => row.key.slice(6)), vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update('excludeDev', !result.some(row => row.key === 'dev'), vscode.ConfigurationTarget.WorkspaceFolder);
    this.preview = undefined; await this.refresh();
  }
  private async chooseAddScope(): Promise<void> {
    if (this.busy || !this.state) return;
    const choices = [{ label: '运行依赖', scope: 'runtime' }, { label: '开发依赖 · dev', scope: 'group:dev' }, ...(this.state.inspection.manifest.extras || []).map(name => ({ label: '可选依赖 · ' + name, scope: 'extra:' + name }))];
    const selected = await vscode.window.showQuickPick(choices, { title: '将已识别依赖添加到哪个组？' });
    if (selected) await this.showPreview(undefined, 'add', selected.scope);
  }
  private async mapImport(module: string): Promise<void> {
    const resolution = this.state?.resolutions.find(item => item.module === module && item.confidence !== 'high');
    if (!resolution || !this.folder) return;
    const value = await vscode.window.showInputBox({ title: `确认 ${module} 的发行包名`, prompt: '输入你核实过的 PyPI 包名。映射不会修复 import 拼写错误；拼写错误请先修改代码。此操作不会安装。', validateInput: value => isPackageName(value) ? undefined : '请输入普通包名，例如 beautifulsoup4；不支持版本、URL、路径或命令参数。' });
    if (!value) return;
    const config = vscode.workspace.getConfiguration('envFollow', this.folder.uri);
    const current = config.get<Record<string, string>>('importMappings', {});
    await config.update('importMappings', { ...current, [module]: value }, vscode.ConfigurationTarget.WorkspaceFolder);
    this.preview = undefined;
    await this.refresh();
  }
  private async openSource(file: string, line = 1): Promise<void> {
    if (!this.folder || !this.state || typeof file !== 'string') return;
    const allowed = this.state.inspection.scan.imports.some(item => item.locations.some(location => location.file === file)) || this.state.inspection.scan.errors.some(item => item.file === file);
    const target = path.resolve(this.folder.uri.fsPath, file);
    const relative = path.relative(this.folder.uri.fsPath, target);
    if (!allowed || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('源文件不属于所选项目。');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    const editor = await vscode.window.showTextDocument(doc);
    const position = new vscode.Position(Math.min(doc.lineCount - 1, Math.max(0, Math.floor(Number.isFinite(line) ? line : 1) - 1)), 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }
  private async receive(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object' || typeof (raw as ViewMessage).action !== 'string') return;
    const message = raw as ViewMessage;
    if (this.busy && !['log', 'source', 'ready'].includes(message.action)) return;
    switch (message.action) {
      case 'ready': this.render(); break;
      case 'refresh': this.error = undefined; this.recovery = undefined; await this.refresh(); break;
      case 'select': await this.selectProject(); break;
      case 'openFolder': await vscode.commands.executeCommand('vscode.openFolder'); break;
      case 'log': this.output.show(true); break;
      case 'create': await this.mutate('create'); break;
      case 'sync': await this.mutate('sync'); break;
      case 'add': if (typeof message.name === 'string') await this.showPreview([message.name]); break;
      case 'addAll': await this.showPreview(); break;
      case 'confirmAdd': await this.mutate('add'); break;
      case 'closePreview': this.preview = undefined; this.render(); break;
      case 'interpreter': await this.useInterpreter(); break;
      case 'run': await this.runCurrentFile(); break;
      case 'groups': await this.selectGroups(); break;
      case 'addScoped': await this.chooseAddScope(); break;
      case 'importRequirements': await this.showPreview([], 'requirements'); break;
      case 'repair': await this.showPreview([], 'repair'); break;
      case 'tree': await this.inspectMaintenance('tree', typeof message.name === 'string' ? message.name : undefined); break;
      case 'treePackage': await this.chooseTreePackage(); break;
      case 'health': await this.inspectMaintenance('health'); break;
      case 'updates': await this.inspectMaintenance('updates'); break;
      case 'upgrade': await this.upgradePackage(typeof message.name === 'string' ? message.name : undefined); break;
      case 'source': if (typeof message.file === 'string') await this.openSource(message.file, message.line); break;
      case 'map': if (typeof message.module === 'string') await this.mapImport(message.module); break;
      case 'ignore':
        if (message.module && this.state?.resolutions.some(item => item.module === message.module)) { await this.context.workspaceState.update(this.ignoredKey(), [...new Set([...this.ignored(), message.module])]); await this.refresh(); } break;
      case 'resetIgnored': await this.context.workspaceState.update(this.ignoredKey(), []); await this.refresh(); break;
    }
  }
  dispose(): void { clearTimeout(this.timer); this.generation++; for (const disposable of this.disposables) disposable.dispose(); }
  snapshot(): ProjectState | undefined { return this.state ? JSON.parse(JSON.stringify(this.state)) : undefined; }
  maintenanceSnapshot(): MaintenanceReports { return JSON.parse(JSON.stringify(this.maintenance)); }
  previewSnapshot(): Pick<Preview, 'kind' | 'changes' | 'upgrade'> | undefined { return this.preview ? JSON.parse(JSON.stringify({ kind: this.preview.kind, changes: this.preview.changes, upgrade: this.preview.upgrade })) : undefined; }
}
export function activate(context: vscode.ExtensionContext) {
  const controller = new Controller(context);
  context.subscriptions.push(controller,
    vscode.window.registerWebviewViewProvider('envFollow.overview', controller.panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('envFollow.open', () => vscode.commands.executeCommand('workbench.view.extension.envFollow')),
    vscode.commands.registerCommand('envFollow.refresh', () => controller.refresh()),
    vscode.commands.registerCommand('envFollow.createEnvironment', () => controller.mutate('create').catch(error => controller.report(error))),
    vscode.commands.registerCommand('envFollow.sync', () => controller.mutate('sync').catch(error => controller.report(error))),
    vscode.commands.registerCommand('envFollow.addMissing', () => controller.showPreview().catch(error => controller.report(error))),
    vscode.commands.registerCommand('envFollow.selectProject', () => controller.selectProject()),
    vscode.commands.registerCommand('envFollow.useInterpreter', () => controller.useInterpreter().catch(error => controller.report(error))),
    vscode.commands.registerCommand('envFollow.runFile', () => controller.runCurrentFile().catch(error => controller.report(error))),
    vscode.commands.registerCommand('envFollow.selectGroups', () => controller.selectGroups().catch(error => controller.report(error))),
    vscode.commands.registerCommand('envFollow.importRequirements', () => controller.showPreview([], 'requirements').catch(error => controller.report(error))),
    vscode.commands.registerCommand('envFollow.repair', () => controller.showPreview([], 'repair').catch(error => controller.report(error))),
    vscode.commands.registerCommand('envFollow.showTree', (name?: string) => controller.inspectMaintenance('tree', typeof name === 'string' ? name : undefined).catch(error => controller.report(error))),
    vscode.commands.registerCommand('envFollow.checkHealth', () => controller.inspectMaintenance('health').catch(error => controller.report(error))),
    vscode.commands.registerCommand('envFollow.checkUpdates', () => controller.inspectMaintenance('updates').catch(error => controller.report(error))),
    vscode.commands.registerCommand('envFollow.upgradePackage', (name?: string) => controller.upgradePackage(typeof name === 'string' ? name : undefined).catch(error => controller.report(error)))
  );
  return { getState: () => controller.snapshot(), getMaintenance: () => controller.maintenanceSnapshot(), getPreview: () => controller.previewSnapshot(), refresh: () => controller.refresh() };
}
export function deactivate(): void {}
