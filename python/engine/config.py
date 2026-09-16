# -*- coding: utf-8 -*-
"""游戏数值常量 —— 唯一真源之一。

（另一处是 .trae/rules/game-design.md，两处必须同步。）
本模块是纯数据：无副作用、无第三方依赖。
"""

# 初始学科（玩家可自行增删）
SEED_SUBJECTS = ['健康', '社会科学', '投资', '博弈论', '党性修养']

# 敌人定义。hp=None 表示无血条（领主求助）或无限血（魔神）
ENEMY_DEFS = {
    'lord': {
        'key': 'lord', 'name': '领主', 'title': '地区权威学者',
        'hp': None, 'unlock': 60, 'needPrev': None,
        'reward': {'mastery': 3, 'favor': 2},
    },
    'general': {
        'key': 'general', 'name': '魔将', 'title': '错误认知的化身',
        'hp': 15, 'unlock': 75, 'needPrev': 'lord',
        'reward': {'mastery': 5, 'favor': 4},
    },
    'king': {
        'key': 'king', 'name': '学科魔王', 'title': '无知的化身',
        'hp': 25, 'unlock': 90, 'needPrev': 'general',
        'reward': {'mastery': 8, 'favor': 6},
    },
    'demon': {
        'key': 'demon', 'name': '魔神', 'title': '全知化身',
        'hp': None, 'unlock': None, 'needPrev': None,
        'reward': {'mastery': 0, 'favor': 1},
    },
}

# 领主求助的通过阈值（正确度）
LORD_PASS = 0.6
# 濒死阈值（HP <= 30%）
NEAR_DEATH = 0.3
# 我方 HP 上限
PLAYER_MAX_HP = 100
# 等级换算：每 50 点总熟练度升 1 级
MASTERY_PER_LEVEL = 50

# 立绘状态帧数（与 web/assets/whale-girl/*.png 对应）
STATE_FRAMES = {
    'idle': 3, 'working': 3, 'celebrate': 3, 'error': 2, 'disappointed': 2,
    'joy': 2, 'eat': 3, 'play': 3, 'drag': 1, 'walk': 3, 'sleep': 2,
    'wake': 2, 'welcome': 2, 'think': 1, 'wait': 1,
}

# 好感度 5 档 -> 默认立绘
TIER_IMAGE = {0: 'idle', 1: 'welcome', 2: 'think', 3: 'joy', 4: 'celebrate'}

# 心情立绘的存活时间（毫秒），过后回落到好感档位表情
MOOD_TTL_MS = 8000

# 派生能力（装饰）权重：洞察 / 博学 / 坚韧
DERIVED_WEIGHTS = {
    '洞察': {'博弈论': 0.5, '社会科学': 0.3, '投资': 0.2},
    '博学': {'健康': 0.25, '社会科学': 0.25, '投资': 0.25, '党性修养': 0.25},
    '坚韧': {'健康': 0.5, '党性修养': 0.5},
}

# 好感度档位阈值
FAVOR_TIERS = [80, 60, 40, 20]
