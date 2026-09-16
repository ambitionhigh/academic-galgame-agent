# -*- coding: utf-8 -*-
"""极简 .env 加载器（纯标准库）：让 Python 也能从 .env 读配置。

已存在的环境变量优先，不被覆盖（与 Node 版行为一致）。
"""

import os


def load_env(file=None):
    file = file or os.path.join(os.getcwd(), '.env')
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
