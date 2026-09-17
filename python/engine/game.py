# -*- coding: utf-8 -*-
"""游戏核心状态机（纯逻辑：不依赖 agent / server，不发网络请求）。"""

import time

from .config import (
    SEED_SUBJECTS, PLAYER_MAX_HP, MASTERY_PER_LEVEL, STATE_FRAMES,
    TIER_IMAGE, MOOD_TTL_MS, FAVOR_TIERS, DERIVED_WEIGHTS,
)


def now_ms():
    """当前时间戳（毫秒），对应 JS 的 Date.now()。"""
    return int(time.time() * 1000)


def is_num(v):
    """对应 JS 的 typeof v === 'number'（bool 不算）。"""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def new_subject():
    """新建一个学科档案。"""
    return {'mastery': 0, 'conquered': False,
            'quest': {'lord': False, 'general': False, 'king': False}}


def create_state():
    """全新存档。"""
    state = {
        'player': {'hp': PLAYER_MAX_HP, 'maxHp': PLAYER_MAX_HP, 'title': '学徒'},
        'whale': {'favorability': 0},
        'subjects': {},
        'mood': None,
        'log': [],
        'demonTries': 0,
        'defeats': {},
    }
    for name in SEED_SUBJECTS:
        state['subjects'][name] = new_subject()
    return state


def migrate_state(state):
    """读取旧存档时的向后兼容补全（缺失字段补默认值）。"""
    if not state or not state.get('player') or not state.get('subjects'):
        return create_state()
    if not state.get('mood'):
        state['mood'] = None
    if not is_num(state.get('demonTries')):
        state['demonTries'] = 0
    if not state.get('defeats'):
        state['defeats'] = {}
    if not isinstance(state.get('log'), list):
        state['log'] = []
    for key in list(state['subjects'].keys()):
        sub = state['subjects'][key]
        if not sub.get('quest'):
            sub['quest'] = {'lord': False, 'general': False, 'king': False}
        if not is_num(sub.get('mastery')):
            sub['mastery'] = 0
        if sub.get('conquered') is None:
            sub['conquered'] = False
    return state


def total_mastery(state):
    return sum((state['subjects'][k].get('mastery') or 0) for k in state['subjects'])


def level_of(state):
    return 1 + total_mastery(state) // MASTERY_PER_LEVEL


def whale_tier(state):
    """好感度档位 0~4。"""
    f = state['whale'].get('favorability') or 0
    for i, threshold in enumerate(FAVOR_TIERS):
        if f >= threshold:
            return 4 - i
    return 0


def effective_mood(state):
    """生效中的心情：超过存活时间的视为已回落（返回 None）。"""
    mood = state.get('mood')
    if (mood and mood.get('name') and mood['name'] in STATE_FRAMES
            and now_ms() - mood.get('at', 0) < MOOD_TTL_MS):
        return mood['name']
    return None


def current_image_key(state):
    """当前该显示哪张立绘（心情优先，过期回落到好感档位）。"""
    return effective_mood(state) or TIER_IMAGE.get(whale_tier(state)) or 'idle'


def demon_unlocked(state):
    """是否已解锁魔神（全部学科魔王通关 = 研究生）。"""
    keys = list(state['subjects'].keys())
    return bool(keys) and all(state['subjects'][k].get('conquered') for k in keys)


def derived_attributes(state):
    """派生能力（装饰性数值，0~100）。"""
    out = {}
    for name, weights in DERIVED_WEIGHTS.items():
        total = 0.0
        for subject, w in weights.items():
            sub = state['subjects'].get(subject) or {}
            total += (sub.get('mastery') or 0) * w
        out[name] = int(round(clamp(total, 0, 100)))
    return out


def log_note(state, note, subject=None, extra=None):
    """写一条日志（保留最近 50 条）。

    extra 用来记录「这一轮到底改了什么数值」—— 面板的回合回放要靠它才能
    逐步重现熟练度/好感的变化，否则只有一句文字说明，回放不出来。
    """
    entry = {'at': now_ms(), 'note': note, 'subject': subject}
    if extra:
        for k, v in extra.items():
            if v is not None:
                entry[k] = v
    state['log'].insert(0, entry)
    if len(state['log']) > 50:
        state['log'].pop()


def set_mood(state, name):
    """设置鲸鱼娘心情（8 秒后自动回落）。"""
    if name and name in STATE_FRAMES:
        state['mood'] = {'name': name, 'at': now_ms()}


def apply_teaching(state, args=None):
    """教学/答题结算（非战斗）。原地修改 state，返回结算后的可读摘要。"""
    args = args or {}
    subject = args.get('subject')
    applied = {}                      # 实际生效的增量（会被 clamp 影响）

    if subject:
        if subject not in state['subjects']:
            state['subjects'][subject] = new_subject()
        if is_num(args.get('masteryDelta')):
            sub = state['subjects'][subject]
            before = sub['mastery']
            sub['mastery'] = clamp(sub['mastery'] + args['masteryDelta'], 0, 100)
            applied['mastery'] = sub['mastery'] - before
    if is_num(args.get('favorabilityDelta')):
        before = state['whale']['favorability']
        state['whale']['favorability'] = clamp(
            state['whale']['favorability'] + args['favorabilityDelta'], 0, 100)
        applied['favor'] = state['whale']['favorability'] - before
    if is_num(args.get('hpDelta')):
        before = state['player']['hp']
        state['player']['hp'] = clamp(
            state['player']['hp'] + args['hpDelta'], 0, state['player']['maxHp'])
        applied['hp'] = state['player']['hp'] - before
    set_mood(state, args.get('mood'))
    if args.get('mood'):
        applied['mood'] = args['mood']
    log_note(state, args.get('note') or '教学结算', subject or None, applied)
    return status_view(state)


def add_subject(state, name):
    """新增学科。"""
    n = str(name or '').strip()
    if not n:
        return {'ok': False, 'error': '学科名不能为空'}
    if len(n) > 40:
        return {'ok': False, 'error': '学科名过长（≤40 字）'}
    if n in state['subjects']:
        return {'ok': False, 'error': '学科「%s」已存在' % n}
    state['subjects'][n] = new_subject()
    log_note(state, '新增学科：%s' % n, n)
    return {'ok': True, 'subjects': state['subjects']}


def remove_subject(state, name):
    """删除学科（连带其熟练度与任务链）；至少保留一个。"""
    n = str(name or '').strip()
    if not n:
        return {'ok': False, 'error': '学科名不能为空'}
    if n not in state['subjects']:
        return {'ok': False, 'error': '没有这个学科：%s' % n}
    if len(state['subjects']) <= 1:
        return {'ok': False, 'error': '至少要保留一个学科'}
    del state['subjects'][n]
    log_note(state, '移除学科：%s' % n, None)
    return {'ok': True, 'subjects': state['subjects']}


def status_view(state, battle=None):
    """汇总给 UI / LLM 的状态视图。"""
    img_key = current_image_key(state)
    return {
        'player': state['player'],
        'whale': state['whale'],
        'whaleTier': whale_tier(state),
        'mood': effective_mood(state),
        'level': level_of(state),
        'totalMastery': total_mastery(state),
        'derived': derived_attributes(state),
        'subjects': state['subjects'],
        # log 保持 8 条（界面上「近期记录」用的），history 给回放/学习报告用更多
        'log': state['log'][:8],
        'history': state['log'][:40],
        'demonUnlocked': demon_unlocked(state),
        'demonTries': state.get('demonTries') or 0,
        'imageKey': img_key,
        'imageFrames': STATE_FRAMES.get(img_key) or 1,
        'battle': battle,
    }
