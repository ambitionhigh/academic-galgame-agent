# -*- coding: utf-8 -*-
"""会话层：持有「存档状态 + 当前战斗态」，把引擎能力暴露成一组方法。

agent 层只通过这里改动游戏，不直接碰 state / battle 内部结构。
"""

from .storage import Storage
from .game import (create_state, status_view, apply_teaching, add_subject,
                   remove_subject as drop_subject)
from .battle import start_battle, apply_battle, battle_view


class GameSession(object):
    def __init__(self, storage=None):
        self.storage = storage or Storage()
        self.state = self.storage.load()
        # 战斗态：仅内存，进程重启即清空（设计如此）
        self.battle = None

    def save(self):
        self.storage.save(self.state)

    def status(self):
        """完整状态视图（UI 与 LLM 共用）。"""
        return status_view(self.state, battle_view(self.battle))

    def teaching(self, args):
        """教学/答题结算（非战斗）。"""
        view = apply_teaching(self.state, args)
        self.save()
        return view

    def add_subject(self, name):
        r = add_subject(self.state, name)
        if r['ok']:
            self.save()
        out = dict(r)
        out['state'] = self.status()
        return out

    def remove_subject(self, name):
        """删除学科；若该学科正有进行中的战斗，一并清掉。"""
        r = drop_subject(self.state, name)
        if r['ok']:
            if self.battle and self.battle['subject'] == name:
                self.battle = None
            self.save()
        out = dict(r)
        out['state'] = self.status()
        return out

    def battle_start(self, subject, enemy):
        b = start_battle(self.state, subject, enemy)
        self.battle = b
        self.save()
        return {'ok': True, 'battle': battle_view(b)}

    def battle_apply(self, args):
        if not self.battle:
            raise ValueError('当前没有进行中的战斗（请先 ag_battle_start 开战）')
        result, battle = apply_battle(self.state, self.battle, args)
        self.battle = battle
        self.save()
        out = dict(result)
        out['battle'] = battle_view(battle)
        return out

    def battle_retreat(self):
        had = self.battle
        self.battle = None
        return {'ok': True, 'cleared': bool(had),
                'message': ('已撤退（%s）' % had['subject']) if had else '没有进行中的战斗'}

    def reset(self):
        self.state = create_state()
        self.battle = None
        self.save()
        return self.status()
