"""先在 Env Follow 中预览导入 requirements.txt，再运行此文件。"""
import sys
import requests

print("项目 Python:", sys.executable)
print("requests:", requests.__version__)
