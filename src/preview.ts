import { run } from './process';
import { Preview, PreviewItem, PythonInfo, ServiceOptions, EnvironmentInfo, PlanChange, Inspection } from './types';
import { normalize } from './resolver';

export function wheelScore(filename: string, python: PythonInfo): number {
  if (!filename.endsWith('.whl')) return -1;
  const parts = filename.slice(0, -4).split('-');
  if (parts.length < 5) return -1;
  const [py, abi, platform] = parts.slice(-3);
  const tags = py.split('.');
  const cp = `cp${python.major}${python.minor}`;
  const isUniversal = tags.includes('py3') && abi === 'none' && platform === 'any';
  if (isUniversal) return 1;
  // Conservative MVP: native-wheel estimates currently support Windows only.
  const architecture = python.machine.toLowerCase();
  const winTag = /arm|aarch/.test(architecture) ? 'win_arm64' : /64/.test(architecture) ? 'win_amd64' : 'win32';
  if (python.platform !== 'win32' || !platform.split('.').includes(winTag)) return -1;
  if (tags.includes(cp) && [cp, 'abi3', 'none'].includes(abi)) return 3;
  if (abi === 'abi3' && tags.some(tag => /^cp3\d+$/.test(tag) && Number(tag.slice(3)) <= python.minor)) return 2;
  if (tags.includes('py3') && abi === 'none') return 2;
  return -1;
}
export async function buildResolvedPreview(changes: PlanChange[], requested: string[], inspection: Inspection, options: ServiceOptions, environment: EnvironmentInfo): Promise<Preview> {
  const names = changes.filter(row => row.to).map(row => row.name);
  let cache: Record<string, { present: boolean; versions: string[] }> = {}, cacheSupported = false;
  if (environment.cacheDir) {
    try {
      const result = await run(environment.analysisPython.path, ['-I', '-S', '-X', 'utf8', options.helperPath], {
        input: JSON.stringify({ mode: 'cache', cacheDir: environment.cacheDir, names }), timeout: 20000
      });
      const value = JSON.parse(result.stdout);
      cache = value.packages || {}; cacheSupported = !!value.supported;
    } catch { /* unknown cache status is surfaced rather than guessed */ }
  }
  const direct = new Set(requested.map(value => normalize(value.match(/^[A-Za-z0-9._-]+/)?.[0] || value)));
  const items: PreviewItem[] = changes.filter(row => row.to).map(row => {
    const item: PreviewItem = { name: row.name, version: row.to, direct: direct.has(row.name), cached: cacheSupported ? cache[row.name] : undefined };
    const packages = (inspection.manifest.lockPackages || []).filter(pkg => normalize(pkg.name) === row.name && pkg.version === row.to);
    if (packages.length !== 1) { item.error = '锁文件有多个源或缺少包记录，体积未知'; return item; }
    const wheels = (packages[0].wheels || []).flatMap(wheel => {
      const filename = wheel.url?.split('/').pop()?.split('?')[0];
      return filename && wheel.size && environment.python && wheelScore(filename, environment.python) >= 0 ? [{ filename, size: wheel.size, score: wheelScore(filename, environment.python) }] : [];
    }).sort((a, b) => b.score - a.score);
    if (wheels.length) { item.filename = wheels[0].filename; item.directWheelBytes = wheels[0].size; }
    else item.error = '无法从锁文件识别此平台的兼容 wheel 大小';
    return item;
  });
  return { items, cacheDir: environment.cacheDir, cacheSupported,
    note: '版本及包变更由 uv 在隔离副本中解析，包含本次涉及的传递依赖。体积来自锁文件中匹配平台的 wheel；缓存命中与实际新增下载量仍不能保证。确认后使用本次解析的锁文件安装。' };
}
