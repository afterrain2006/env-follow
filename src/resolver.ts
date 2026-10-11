import { Installed, ImportUsage, Resolution, Dependency, Inspection } from './types';
export const normalize = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');
export const isPackageName = (name: unknown): name is string => typeof name === 'string' && name.length <= 100 && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name);
export const KNOWN: Record<string, string> = {
  numpy: 'numpy', cv2: 'opencv-python', PIL: 'Pillow', sklearn: 'scikit-learn',
  requests: 'requests', pandas: 'pandas', torch: 'torch', torchvision: 'torchvision',
  scipy: 'scipy', matplotlib: 'matplotlib', seaborn: 'seaborn', flask: 'Flask',
  django: 'Django', fastapi: 'fastapi', pydantic: 'pydantic', httpx: 'httpx',
  aiohttp: 'aiohttp', uvicorn: 'uvicorn', bs4: 'beautifulsoup4', yaml: 'PyYAML',
  dotenv: 'python-dotenv', tqdm: 'tqdm', rich: 'rich', pytest: 'pytest',
  sqlalchemy: 'SQLAlchemy', lxml: 'lxml', openpyxl: 'openpyxl',
  dateutil: 'python-dateutil', psutil: 'psutil', sympy: 'sympy',
  selenium: 'selenium', playwright: 'playwright', jinja2: 'Jinja2',
  click: 'click', typer: 'typer', boto3: 'boto3', redis: 'redis',
  pymongo: 'pymongo', pymysql: 'PyMySQL', psycopg2: 'psycopg2-binary',
  flask_cors: 'Flask-Cors', xgboost: 'xgboost', lightgbm: 'lightgbm',
  transformers: 'transformers', datasets: 'datasets', sentence_transformers: 'sentence-transformers'
};
const AMBIGUOUS: Record<string, string[]> = {
  jwt: ['PyJWT', 'jwt'], fitz: ['PyMuPDF'], Crypto: ['pycryptodome'],
  google: ['google-auth', 'google-cloud-storage', 'protobuf'],
  multipart: ['python-multipart', 'multipart'], serial: ['pyserial', 'serial']
};
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + Number(a[i - 1] !== b[j - 1]));
    prev = next;
  }
  return prev[b.length];
}
export function resolveImports(imports: ImportUsage[], installed: Installed[], mappings: Record<string, string> = {}, ignored: string[] = []): Resolution[] {
  return imports.map(usage => {
    const module = usage.module;
    const row = { ...usage, ignored: ignored.includes(module) };
    if (Object.hasOwn(mappings, module) && isPackageName(mappings[module])) return { ...row, confidence: 'high', package: normalize(mappings[module]), candidates: [], reason: '用户确认的映射' };
    const owners = [...new Set(installed.filter(item => item.modules.includes(module)).map(item => normalize(item.name)))];
    if (owners.length === 1) return { ...row, confidence: 'high', package: owners[0], candidates: [], reason: '来自当前 .venv 的包元数据' };
    if (owners.length > 1) return { ...row, confidence: 'ambiguous', candidates: owners, reason: '多个已安装包提供此模块' };
    if (Object.hasOwn(KNOWN, module)) return { ...row, confidence: 'high', package: normalize(KNOWN[module]), candidates: [], reason: '内置白名单映射（仍需确认安装）' };
    if (Object.hasOwn(AMBIGUOUS, module)) return { ...row, confidence: 'ambiguous', candidates: AMBIGUOUS[module].map(normalize), reason: '模块可能由不同发行包提供，请核实' };
    const matches = Object.keys(KNOWN).map(key => ({ key, dist: distance(module.toLowerCase(), key.toLowerCase()) })).filter(item => item.dist <= (module.length > 7 ? 2 : 1) && item.dist < module.length / 2).sort((a, b) => a.dist - b.dist);
    return { ...row, confidence: 'unknown', candidates: [...new Set(matches.slice(0, 3).map(item => normalize(KNOWN[item.key])))], reason: matches.length ? '可能是拼写错误；候选仅供核对，不会安装' : '没有可靠映射；请确认发行包名后设置映射' };
  });
}
export function dependencyStates(inspection: Inspection, resolutions: Resolution[]): Dependency[] {
  const names = new Set([...inspection.manifest.declared.map(item => normalize(item.name)), ...inspection.installed.map(item => normalize(item.name)), ...resolutions.flatMap(item => item.package && !item.ignored ? [normalize(item.package)] : [])]);
  return [...names].map(name => {
    const usages = resolutions.filter(item => !item.ignored && item.package && normalize(item.package) === name);
    const declared = inspection.manifest.declared.find(item => normalize(item.name) === name);
    const installed = inspection.installed.find(item => normalize(item.name) === name);
    const lockedVersions = inspection.manifest.locked[name] || [];
    const used = usages.length > 0;
    let status: Dependency['status'];
    if (used && !declared && !installed) status = 'missing';
    else if (used && !declared) status = 'undeclared';
    else if (used && !installed) status = 'out-of-sync';
    else if (installed && declared && lockedVersions.length && !lockedVersions.includes(installed.version)) status = 'version-drift';
    else if (used) status = 'ready';
    else if (declared && (!declared.scopes.includes('runtime') || declared.conditional)) status = 'conditional';
    else if (declared) status = 'possibly-unused';
    else status = 'installed-only';
    return { name, used, declared: !!declared, installed: !!installed, version: installed?.version, lockedVersions, scopes: declared?.scopes || [], modules: usages.map(item => item.module), locations: usages.flatMap(item => item.locations), status };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
