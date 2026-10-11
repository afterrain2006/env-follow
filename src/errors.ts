import { RecoveryInfo } from './types';
export function classifyError(error: unknown): RecoveryInfo {
  const text = error instanceof Error ? error.message : String(error);
  if (/预览已过期|计划已过期/.test(text)) return { category: 'stale', title: '项目发生了变化', advice: '请重新生成预览，再确认安装。当前项目未应用旧计划。', canRepair: false };
  if (/no wheels|no compatible wheel|source distribution|Building.*disabled|building.*not supported|doesn't have.*wheel|does not have.*wheel/i.test(text)) return { category: 'wheel', title: '没有可用的预编译包', advice: '此版本只安装 wheel。检查包对当前 Python 和平台的支持，必要时调整 Python 或包版本。', canRepair: true };
  if (/No interpreter|No Python|Python.*not found|requires Python|requires-python|Python.*版本|Python 3\.11|解释器|No solution.*python/i.test(text)) return { category: 'python', title: 'Python 环境不符合要求', advice: '检查项目 requires-python，安装或选择匹配的本机 Python。不会自动下载 Python。', canRepair: false };
  if (/No solution found|unsatisfiable|conflicting|version conflict|依赖冲突/i.test(text)) return { category: 'conflict', title: '依赖约束无法同时满足', advice: '查看日志中的冲突包和版本范围，调整项目声明后重新预览。', canRepair: true };
  if (/timed? ?out|超时|Failed to fetch|Failed to download|failed to connect|connection|certificate|DNS|network|ENOTFOUND|ECONN|TLS|SSL|offline/i.test(text)) return { category: 'network', title: '网络或包源连接失败', advice: '检查网络、证书和项目包源设置，再重新预览或重试。', canRepair: true };
  if (/TOML|pyproject|workspace|requirements|配置|源码|本地源|包名格式|ENOENT|找不到.*uv/i.test(text)) return { category: 'config', title: '项目配置需要检查', advice: '查看具体错误并修复配置，再重新扫描。复杂本地源和 uv workspace 仍需使用 uv 管理。', canRepair: false };
  return { category: 'unknown', title: '操作未完成', advice: '查看完整日志，重新扫描以确认实际状态；已有锁文件时可预览按锁文件修复。', canRepair: true };
}
