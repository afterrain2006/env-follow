import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { content, PanelModel } from './render';
export { content, escapeHtml, PanelModel } from './render';

export class EnvironmentPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private model: PanelModel = { projectNames: [], ignored: [] };
  constructor(private readonly extensionUri: vscode.Uri, private readonly onAction: (message: unknown) => void) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    const nonce = randomBytes(20).toString('hex');
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css'));
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'));
    view.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${view.webview.cspSource};"><link rel="stylesheet" href="${css}"><title>Env Follow</title></head><body><main id="content">${content(this.model)}</main><script nonce="${nonce}" src="${script}"></script></body></html>`;
    view.webview.onDidReceiveMessage(this.onAction);
    view.onDidChangeVisibility(() => { if (view.visible) this.update(this.model); });
  }
  update(model: PanelModel): void {
    this.model = model;
    void this.view?.webview.postMessage({ type: 'render', html: content(model), busy: !!model.busy });
  }
}
