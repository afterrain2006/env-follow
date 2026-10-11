import { spawn } from 'node:child_process';
export class CommandError extends Error {
  constructor(public executable: string, public args: string[], public stdout: string, public stderr: string, public exitCode: number | null, message?: string) {
    super(message || `${executable} ${args.join(' ')}\n${stderr || stdout || `退出代码 ${exitCode}`}`);
    this.name = 'CommandError';
  }
}
export interface RunOptions { cwd?: string; input?: string; timeout?: number; log?: (text: string) => void; env?: NodeJS.ProcessEnv }
export function run(executable: string, args: string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // No shell. A package name or workspace path can never become shell code.
    const child = spawn(executable, args, { cwd: options.cwd, windowsHide: true, shell: false, env: { ...process.env, ...options.env, PYTHONIOENCODING: 'utf-8' }, stdio: 'pipe' });
    let stdout = '', stderr = '', settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => { child.kill(); finish(new CommandError(executable, args, stdout, stderr, null, '操作超时；请检查网络、Python 和 uv。\n' + stderr)); }, options.timeout || 30000);
    child.on('error', error => finish(new CommandError(executable, args, stdout, stderr, null, `${executable}: ${error.message}`)));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 16 * 1024 * 1024) { child.kill(); finish(new Error('命令输出超过 16 MB，已停止。')); } });
    child.stderr.on('data', chunk => { const value = String(chunk); stderr = (stderr + value).slice(-2 * 1024 * 1024); options.log?.(value); });
    child.on('close', code => finish(code === 0 ? undefined : new CommandError(executable, args, stdout, stderr, code)));
    child.stdin.on('error', () => { /* early process exit is reported by close */ });
    child.stdin.end(options.input || '');
  });
}
