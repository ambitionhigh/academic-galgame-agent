#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""学术galgame Agent（Python · 纯标准库）—— 启动入口。

用法：
    python run.py            # 启动服务，默认 http://127.0.0.1:8787
    python -m unittest discover -s tests -v   # 跑离线自测

环境变量：PORT / HOST / LLM_API_KEY / LLM_MODEL / LLM_BASE_URL / GALGAME_SAVE / GALGAME_CORPUS
（LLM_* 为规范名；为兼容早期版本，ARK_* 仍作为别名生效）
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from server.server import main  # noqa: E402

if __name__ == '__main__':
    main()
