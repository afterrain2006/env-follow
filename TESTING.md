# Env Follow v0.3 验证记录

日期：2026-10-11（Asia/Shanghai）。Windows、Node.js 22.23.1、分析 Python 3.13.14、项目 Python 3.12.13、uv 0.11.32、VS Code 1.139.1。使用已有本机 Python，未下载 Python。

## 验证结果

- TypeScript 类型检查和 esbuild 构建通过。
- `npm test`：25 项 Node + 11 项 Python，共 36 项核心测试通过。
- 真实 uv 验收共 5 项通过：v0.1 安装/恢复 1 项、v0.2 requirements/分组 2 项、v0.3 维护/升级 2 项。
- 真实 VS Code 检查共 10 项通过：v0.3 新功能 6 项、解释器切换与运行回归 4 项。
- 浏览器检查通过：实际环境依赖树、真实升级计划、真实缺失传递依赖错误；按钮消息、依赖搜索、360px/240px 窄侧栏、无前端异常。
- VSIX 打包通过，在独立 VS Code 配置安装/升级成功，扩展版本 `env-follow-local.env-follow@0.3.0`。包内验证扩展入口、前端资源及 Python 分析器，排除开发依赖和测试环境。

## v0.3 真实 uv 场景

在独立临时项目声明 `requests>=2.32,<3`，锁定并安装 requests 2.32.3：

1. 完整树含 requests 及传递依赖；聚焦 urllib3 的反向树含 requests。
2. 健康检查返回兼容，更新查询含 requests 的已安装和可用版本。上述操作未改 pyproject、uv.lock、pyvenv.cfg。
3. 升级计划把 requests 从 2.32.3 解析到包源允许的新版本。预览时原环境不变，pyproject 内容及约束保留；不相关的固定 colorama 版本不变。
4. 预览后追加项目注释，旧计划被拒绝；重新生成计划后安装结果逐项匹配预览版本，保留注释。
5. 删除 idna，检查识别缺失传递依赖；预览按锁修复后恢复兼容。
6. 独立安装 idna 2.0，检查识别与 requests 约束不兼容；按锁修复后恢复兼容。

另一个独立项目固定 `requests==2.32.3`：升级计划保持 2.32.3，锁版本及环境动作均无变化。无 `.venv` 项目调用树/健康/更新时明确拒绝，不回退到系统环境检查，也不创建环境。

## 核心检查重点

新测试覆盖 uv 更新 JSON 格式和重复条目校验；uv pip check 的真实不兼容与命令错误区分；HTML 转义；传递包没有直接升级入口。保留原有 import 映射、状态比较、Unicode 路径、进程参数、解析计划、依赖组、版本估算、失败恢复及并发修改保护测试。

## 真实 VS Code

v0.3：命令返回真实健康结果；显示正向/反向树；更新查询显示版本；固定版本升级预览保留约束且不安装；面板打开；分组配置改变后清除报告与计划。检查前后声明/锁文件保持不变。

回归：通过真实 Microsoft Python 扩展 API 改选其他解释器，检测不一致，再一键切换项目解释器；打开面板；ProcessExecution 实际运行含中文与 `&` 的文件名，使用项目 Python 并成功导入 src 模块，不改声明和锁文件。

测试使用独立用户配置和扩展目录。保存 v0.3 与回归结果分别为 `.test-work/host-v03-result.json`、`.test-work/host-v03-regression-result.json`。

## 界面验证

`scripts/preview-v03-ui.cjs` 创建真实旧版 requests 环境，读取实际关系和健康结果，生成真实升级计划；移除 idna 后捕获实际 uv 健康错误，随后按锁修复。

检查健康/完整树/搜索包/更新/升级/确认按钮消息，以及依赖搜索。正常和错误页面在 360px/240px 无横向溢出，浏览器无前端异常。截图由生产 renderer 生成，不是设计稿。

## 复验

```powershell
npm ci
npm run check
npm test
npm run test:integration
npm run test:integration:v02
npm run test:integration:v03
npm run package
```

真实 VS Code v0.3：先运行 v0.3 integration，使用其输出的 `v03-pinned-*` 项目。host 脚本异步启动隐藏测试窗口，查看 `.test-work/host-result.json`；同一 profile 不要并行运行两个 host。

```powershell
powershell -NoProfile -File scripts/test-host.ps1 -TestSuite v03-extension-host.cjs -FixturePath 'D:\projects\env-follow\.test-work\v03-pinned-替换为测试输出'
```

解释器与运行回归需要在隔离目录安装 Microsoft Python 扩展，以及 v0.2 integration 输出的 src 示例项目：

```powershell
code --install-extension ms-python.python --extensions-dir .test-work/vscode-extensions --user-data-dir .test-work/vscode-profile
powershell -NoProfile -File scripts/test-host.ps1 -TestSuite v02-extension-host.cjs -FixturePath 'D:\projects\env-follow\.test-work\v02-import-替换为测试输出'
```

界面检查需要 Playwright 与 Edge；若模块不在本项目，用 `ENV_FOLLOW_PLAYWRIGHT_MODULE` 指定目录：

```powershell
node scripts/preview-v03-ui.cjs
```

## 实际边界

只在 Windows 实机验证；其他平台需要后续验收。依赖树是已安装包的元数据关系，健康检查是依赖兼容性检查，不验证运行时导入、动态库或业务行为。更新列表不是项目约束下的最终升级版本；升级预览才使用项目锁解析。

未提供完整环境原子回滚；修复保留额外包，未穷举安装器所有失败点。依赖树最多 8 层和单方向 40,000 字符，超限提示；uv 输出结构变化会失败并报告。workspace、复杂源、动态声明等写入限制保留，详细范围见 README。
