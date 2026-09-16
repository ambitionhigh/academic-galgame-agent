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

# ── 控制台兼容兜底 ────────────────────────────────────────────────
# 中文 Windows 控制台默认代码页 936（GBK）。若某个字符 GBK 表示不了
# （例如 U+2713 / U+2717 / U+26A0 这几个常用符号），print 会直接抛
# UnicodeEncodeError 让程序崩掉。这里把输出流设成「遇到编码不了的字符就替换」，
# 保证任何环境下都不会因此崩溃。（本项目源码已做过全量 GBK 安全性扫描。）
for _stream in ('stdout', 'stderr'):
    try:
        getattr(sys, _stream).reconfigure(errors='replace')
    except Exception:
        pass

from server.server import main  # noqa: E402

if __name__ == '__main__':
    sys.exit(main())
