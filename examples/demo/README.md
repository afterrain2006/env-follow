# 演示项目

打开此文件夹并点击左侧 Env Follow 图标。`numpy` 和 `cv2` 应出现高置信度建议，`os`、`json`、`demo_app` 应被过滤。点击「添加全部」后确认安装。首次操作会创建 `pyproject.toml`、`.venv` 和 `uv.lock`。

删除 `import cv2` 后保存，应提示 opencv-python「可能未使用」，保留已安装的包。`src/demo_app` 是 src 布局本地模块示例；要实际运行 demo，请在终端设置 `PYTHONPATH=src`（PowerShell：`$env:PYTHONPATH='src'`），再运行 `uv run main.py`。
