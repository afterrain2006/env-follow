"""用这个项目体验 Env Follow；添加依赖前不需要运行这段代码。"""
import os
import json
import numpy as np
import cv2
from demo_app import greeting

print(greeting())
print(np.__version__, cv2.__version__)
print(json.dumps({"directory": os.getcwd()}))

# 试试添加 import reqeusts：只会显示未知 import，不会建议安装同名包。
# 删除 import cv2 并保存：opencv-python 会被标为可能未使用，不会删除。
