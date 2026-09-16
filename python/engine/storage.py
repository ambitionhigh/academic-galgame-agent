# -*- coding: utf-8 -*-
"""存档读写。

- Storage       ：文件存档（默认 ./data/save.json，可用 GALGAME_SAVE 覆盖）
- MemoryStorage ：内存存档，每位访客一份，进程退出即消失
"""

import json
import os

from .game import create_state, migrate_state

DEFAULT_SAVE = os.path.join(os.getcwd(), 'data', 'save.json')


class Storage(object):
    def __init__(self, file=None):
        self.file = os.path.abspath(file or os.environ.get('GALGAME_SAVE') or DEFAULT_SAVE)

    def load(self):
        try:
            if not os.path.exists(self.file):
                return create_state()
            with open(self.file, 'r', encoding='utf-8') as fh:
                return migrate_state(json.load(fh))
        except Exception:
            return create_state()

    def save(self, state):
        """写存档；失败静默（不阻断游戏）。"""
        try:
            os.makedirs(os.path.dirname(self.file), exist_ok=True)
            with open(self.file, 'w', encoding='utf-8') as fh:
                json.dump(state, fh, ensure_ascii=False)
            return True
        except Exception:
            return False


class MemoryStorage(object):
    """内存存档：每位访客一份，进程退出即消失。

    公开部署（多人访问）时用它，避免所有人的进度互相覆盖；
    也是 BYOK 模式下的默认选择。
    """

    def __init__(self, initial=None):
        self.data = initial

    def load(self):
        if self.data:
            return migrate_state(json.loads(json.dumps(self.data)))
        return create_state()

    def save(self, state):
        try:
            self.data = json.loads(json.dumps(state))
            return True
        except Exception:
            return False
