# Env Follow v0.3

**You write code. Your environment follows.**

[GitHub 仓库](https://github.com/afterrain2006/env-follow) · [v0.3.0 安装包](https://github.com/afterrain2006/env-follow/releases/tag/v0.3.0) · [自动创建环境的下一版方案](docs/auto-environment.md)

Python + VS Code + uv 的可视化依赖环境管理器。保存代码后比较代码使用、项目声明和 `.venv` 实际安装的依赖；先看 uv 解析出的安装计划，确认后应用。

## 安装和体验

需要 VS Code 1.96+、uv，以及本机可用的 Python。AST/TOML 分析需要 Python 3.11+；项目可以使用 uv 选择的其他 Python 版本。v0.3 在 Windows、uv 0.11.32 上验收。

1. VS Code 扩展页 `…` →「从 VSIX 安装」，选择 `env-follow-0.3.0.vsix`。已装旧版本时安装新包即可升级。
2. 打开本地 Python 项目，点击活动栏的 Env Follow 六边形图标。
3. 保存 `import numpy`、`import cv2` 等代码后，点击「预览并添加全部」。
4. 查看新增、替换、移除的包及实际解析版本，点击「确认应用计划」，确认弹窗。
5. 安装完成后点击「切换到项目 Python」，再点「运行当前文件」或编辑器右上角 Env Follow 运行按钮。

开发体验：用 VS Code 打开本扩展源码，执行 `npm ci` 后按 F5，开发窗口自动打开 `examples/demo`。已安装开发依赖时可以直接 F5。

已有 requirements 项目：单独打开 `examples/existing-project`，面板会显示「接入已有项目」。点击「预览导入 requirements.txt」，确认计划后安装，再打开 `main.py` 并运行。示例最初不含 `.venv`、声明或锁文件。

## v0.3：理解和维护环境

**环境依赖树。** 点击「查看完整树」读取当前 `.venv` 的安装关系；点击包旁「依赖关系」或「搜索包关系」，查看它依赖哪些包、哪些包依赖它。结果由 `uv pip tree` 提供，离线读取，不执行项目代码。显示最多 8 层，每个方向最多 40,000 字符，超出会提示截断；`(*)` 是 uv 对重复分支的省略。关系来自包元数据，不能证明代码实际调用。

**环境健康检查。** 「检查环境」调用项目解释器对应的 `uv pip check`，检查已安装包的依赖缺失及版本不兼容。面板显示中文状态、完整 uv 结果和按锁文件预览修复入口。命令失败和不支持的输出格式不会被当作健康。这个检查不包含运行时导入、系统动态库或业务测试。

**更新检查和指定包升级。** 「检查更新」按需联网查询 `uv pip list --outdated --format json`，展示已安装和包源可用版本；不会在保存时自动联网。包源的新版本不一定满足项目约束。项目已声明且已安装的依赖可「预览升级」，使用隔离副本执行 `uv lock --upgrade-package 包名`，保留 pyproject 原有约束。固定版本不会被自动放宽；条件约束由 uv 处理。

升级计划分别展示锁文件版本变化和当前环境实际安装变化，包含受到影响的传递依赖。锁文件可能包含其他 Python/平台及未启用组，不能把所有锁变化都算作本机下载。确认后应用此次锁文件，核对安装版本；期间修改声明、锁文件、依赖组或环境会拒绝过期计划。额外包/传递依赖没有直接升级入口，可先反查引入它的项目依赖。

报告包含检查时间，刷新发现声明、环境或依赖组变化时清除旧报告；外部直接修改环境后可手动刷新或重新检查。健康检查、依赖树和更新查询不会修改项目声明、锁文件或 `.venv`，联网查询可能更新 uv 全局缓存。

新增命令：`Env Follow: 查看环境依赖树`、`检查环境健康`、`检查依赖更新`、`预览升级项目依赖`。

维护演示：独立打开 `examples/maintenance`，先「预览同步」并确认。示例锁文件保留 requests 2.32.3，声明允许 `>=2.32,<3`；之后可以查看树、检查健康和预览约束内升级。此版本只增加这三项维护功能，未加入操作历史、Notebook 或空间清理。

参考：[uv 环境检查](https://docs.astral.sh/uv/pip/inspection/)、[锁文件版本升级](https://docs.astral.sh/uv/concepts/projects/sync/#upgrading-locked-package-versions)、[uv 命令参考](https://docs.astral.sh/uv/reference/cli/)。

## v0.2 的四项改进

**解释器对齐与运行。** 同时展示项目 Python 和 Microsoft Python 扩展当前选择的版本、路径，监听解释器切换，提示不一致。通过 Python 扩展公开 API 一键切换。未安装 Python 扩展时，可以保存默认路径并复制路径，但不会声称活动解释器已经切换。运行按钮明确调用项目 `.venv` 的 Python，支持项目根目录和 `src` 布局；不自动安装、同步或下载 Python。

**真实安装计划。** 在系统临时目录复制项目声明和锁文件，用 uv 解析，再对实际项目环境执行只读 JSON dry run。展示新增、版本替换、移除和传递依赖，wheel 体积来自本次解析生成的锁文件。预览不会写入原项目的 pyproject、锁文件或 `.venv`，但可能联网并更新 uv 全局缓存。确认前核对项目文件、环境元数据、Python 和分组选择；发生变化时拒绝过期计划。应用保存的声明与锁文件，使用 `uv sync --locked` 安装并核对结果。

**可以继续处理的错误。** 面板区分网络、版本冲突、Python 不匹配、没有可用 wheel、配置和过期计划，显示处理建议、失败阶段和完整日志。安装失败时尝试恢复本次拥有的声明及锁文件，重扫实际环境变化；有可用锁文件时可「预览按锁文件修复」。不覆盖操作期间检测到的外部修改。

**已有项目与分组。** 导入根目录 `requirements.txt` 的普通包名、extras、版本约束及环境标记，保留原 requirements 文件。支持选择已有可选 extra、开发 group，以及是否排除 dev；选择本身不安装，下一次预览和应用采用相同设置。添加已识别依赖时可选运行依赖、dev 或已有 extra。

## 保留的基础功能

- 中文侧边栏、状态栏、保存后防抖扫描、外部文件变更刷新，多根工作区可选项目。
- AST 识别 import/from/别名/多行语句，不执行项目模块；过滤目标 Python 标准库、相对 import、本地模块、常见环境和构建目录。
- 常见映射：`cv2 → opencv-python`、`PIL → Pillow`、`sklearn → scikit-learn` 等；优先采用已安装包的 import 元数据。
- 高置信度、歧义、未知三档，未知名称可忽略或保存经核实的包名映射。拼写错误 `reqeusts` 不会自动变成 requests 安装。
- USED / DECLARED / INSTALLED 比较：缺失、未声明、未同步、版本漂移、可能未使用、分组/条件依赖。删除 import 后保留安装的包。
- 只读 CLI、源码、演示项目、测试和 VSIX 打包配置。

## 下载和缓存信息的含义

wheel 大小对应本次计划的**实际版本**，包含传递依赖；Windows 常见 CPython 标签及通用 wheel 做保守匹配。无法确认兼容 wheel、大小或来源时显示未知，不选用 PyPI 最新版代替。其他平台的原生 wheel 大小可能未知。

uv 缓存目录结构并非稳定 API；「发现相关包文件」不保证平台、索引、版本及文件完整性均满足复用。已知 wheel 大小合计也不等于新增网络下载量，未计算未经核实的缓存抵扣。网络超时、缓存不完整及包源返回内容都可能让实际下载量不同。

## 支持范围和边界

- 面向可信的本地独立 Python 项目、标准 `.venv` 和 PEP 621 声明。uv workspace 根项目/成员只读；不自动迁移 Poetry、Conda、自定义 venv、动态依赖或复杂 Git/本地路径/URL 源。注册表索引配置会复制到隔离预览，父目录的隐式配置不会复制，建议把所需 uv 配置写在项目内。
- requirements 必须是 UTF-8（可带 BOM）。`-r`、`-c`、索引选项、哈希、URL、路径等暂不支持；发现任一不支持行会拒绝整个导入，避免漏装。uv 负责最终验证版本表达式和标记。
- 只安装预编译 wheel，不执行第三方源码构建，不安装项目自身 build backend。uv 禁止自动下载 Python。没有匹配的本机 Python 或 wheel 时显示真实错误。
- 所有创建/安装/同步/修复均需明确操作和确认。`--inexact` 保留环境额外包；修复把锁定依赖恢复到选定组的版本，不清空环境。
- 进程使用可执行文件和参数数组，不经过 shell。分析使用 `-I -S -X utf8`，读取 AST/TOML/METADATA/RECORD；只有点击运行按钮才执行项目代码。
- 元数据恢复**不是 `.venv` 的完整原子回滚**。失败时环境可能部分更新，需要重扫及修复。无法恢复的文件及并发修改会报告出来。
- 静态分析不能覆盖动态导入、入口点及插件。「可能未使用」只供核对，不自动删除。语法错误和扫描截断明确提示。
- JSON dry run 使用 uv 当前的 preview 输出结构，已验证 uv 0.11.32；旧版不支持该选项或未来结构变化时会报错，不会推测安装计划。
- 暂无 C/C++、Node、Rust、CUDA、Docker、AI 诊断、远程协作和云同步。

## 开发和验证

```powershell
cd D:\projects\env-follow
npm ci
npm run check
npm test
npm run test:integration
npm run test:integration:v02
npm run test:integration:v03
npm run package
```

integration 测试会在 `.test-work` 的独立临时项目中联网解析并实际安装依赖，保留验收目录供检查。详细验证记录及真实 VS Code 测试方法见 `TESTING.md`。

只读扫描：

```powershell
node dist/cli.js examples/demo
node dist/cli.js D:\path\to\python-project --json
```

`ENV_FOLLOW_PYTHON`、`ENV_FOLLOW_UV` 可指定 CLI 的可执行文件路径。

## 设置

| 设置 | 默认值 | 用途 |
|---|---|---|
| `envFollow.pythonPath` | 自动检测 | Python 3.11+ 分析解释器 |
| `envFollow.uvPath` | `uv` | uv 文件名或绝对路径 |
| `envFollow.scanDelay` | 700 ms | 保存后扫描间隔 |
| `envFollow.maxFiles` | 4000 | 项目扫描上限 |
| `envFollow.excludeDirectories` | `[]` | 额外排除目录名 |
| `envFollow.importMappings` | `{}` | 已核实的 import → 包名映射 |
| `envFollow.activeExtras` | `[]` | 启用的 optional-dependencies |
| `envFollow.activeGroups` | `[]` | 在 uv 默认组之外额外启用的组 |
| `envFollow.excludeDev` | `false` | 排除默认 dev 组 |

## 代码结构

```text
src/extension.ts    VS Code 生命周期、解释器 API、运行任务、用户确认
src/panel.ts        webview 消息桥
src/render.ts       可独立测试的面板 HTML 渲染
src/planning.ts     隔离解析、完整计划、过期检测、依赖组
src/preview.ts      解析版本对应的 wheel / 缓存信息
src/service.ts      扫描、计划应用、元数据恢复
src/maintenance.ts  只读依赖树、健康检查与更新查询
src/interpreter.ts  解释器比较、运行参数及路径校验
src/errors.ts       错误分类和恢复建议
src/resolver.ts     包名映射、置信度、状态比较
src/environment.ts Python / uv / .venv 发现
src/process.ts     参数数组执行进程
python/inspect_project.py AST / TOML / requirements / 包元数据 / 缓存
media/             中文侧边栏样式和前端消息
examples/          新项目及 requirements 项目
tests/             核心、恢复、真实 uv、真实 VS Code 验证
```

实现参考：[VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)、[VS Code Task API](https://code.visualstudio.com/api/references/vscode-api#ProcessExecution)、[uv 命令文档](https://docs.astral.sh/uv/reference/cli/)、[uv 依赖组](https://docs.astral.sh/uv/concepts/projects/dependencies/)、[uv 缓存](https://docs.astral.sh/uv/concepts/cache/)、[Python 扩展公开 API](https://github.com/microsoft/vscode-python/blob/main/pythonExtensionApi/src/main.ts)。
