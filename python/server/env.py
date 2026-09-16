# -*- coding: utf-8 -*-
"""极简 .env 加载器（纯标准库）：让 Python 也能从 .env 读配置。

查找顺序（只认「本项目自己的 .env」，避免误读别的项目）：
  1. 环境变量 GALGAME_ENV 指定的路径（想显式指别处时用）
  2. 本文件所在项目的上一级：<项目根>/.env   ← 即 python/.env

**刻意不按「当前工作目录」找**：早期版本用 os.getcwd()，于是从别的目录启动时
会读到那个目录的 .env —— 例如在仓库根目录启动时，会悄悄套用 Node 版 .env 里的
真实凭证，使用者以为在 DEMO 模式、实际却在消耗额度。改成按项目位置查找后，
无论从哪个目录启动（PyCharm 的运行配置、双击 bat、任意终端），行为都一致。

已存在的环境变量优先，不被覆盖（与 Node 版行为一致）。
"""

import os

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_ENV = os.path.join(PROJECT_ROOT, '.env')


def env_path():
    """返回实际要加载的 .env 路径。"""
    return os.path.abspath(os.environ.get('GALGAME_ENV') or DEFAULT_ENV)


def load_env(file=None):
    file = file or env_path()
    if not os.path.exists(file):
        return False
    try:
        with open(file, 'r', encoding='utf-8') as fh:
            text = fh.read()
    except OSError:
        return False

    import re
    for raw_line in text.split('\n'):
        line = raw_line.strip()
        if not line or line.startswith('#'):
            continue
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$', line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if len(val) >= 2 and ((val[0] == '"' and val[-1] == '"')
                              or (val[0] == "'" and val[-1] == "'")):
            val = val[1:-1]
        if key not in os.environ:
            os.environ[key] = val
    return True
