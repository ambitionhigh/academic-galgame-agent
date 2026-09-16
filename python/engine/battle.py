# -*- coding: utf-8 -*-
"""战斗（场景任务）状态机。

战斗态只存在内存，不写存档；永久进度写在存档里。
"""

from .config import ENEMY_DEFS, LORD_PASS, NEAR_DEATH
from .game import clamp, log_note, set_mood, demon_unlocked, new_subject, now_ms


def battle_view(battle):
    """战斗的可读视图（给 UI 与 LLM）。"""
    if not battle:
        return None
    definition = ENEMY_DEFS[battle['enemy']]
    return {
        'subject': battle['subject'],
        'enemy': battle['enemy'],
        'enemyName': definition['name'],
        'enemyTitle': definition['title'],
        'enemyInfinite': battle['enemy'] == 'demon',
        'enemyHp': battle['enemyHp'],
        'enemyMaxHp': battle['enemyMaxHp'],
        'difficulty': battle['difficulty'],
        'questionCount': battle['questionCount'],
        'correctStreak': battle['correctStreak'],
    }


def check_unlock(state, subject, enemy):
    """开战前的解锁校验。返回 None 表示可开战，否则返回错误文案。"""
    sub = state['subjects'].get(subject)
    definition = ENEMY_DEFS.get(enemy)
    if not sub:
        return '未知学科：%s（可用 ag_add_subject 添加）' % subject
    if not definition:
        return '未知敌人：%s（可选 lord / general / king / demon）' % enemy
    m = sub.get('mastery') or 0
    if enemy == 'lord':
        if m < 60:
            return '领主求助需「%s」熟练度 ≥ 60（当前 %s）' % (subject, m)
        if sub['quest']['lord']:
            return '领主求助已完成，可挑战魔将（熟练度 ≥ 75）'
    if enemy == 'general':
        if not sub['quest']['lord']:
            return '需先完成领主求助'
        if m < 75:
            return '魔将需「%s」熟练度 ≥ 75（当前 %s）' % (subject, m)
        if sub['quest']['general']:
            return '魔将已讨伐，可挑战学科魔王（熟练度 ≥ 90）'
    if enemy == 'king':
        if not sub['quest']['general']:
            return '需先讨伐魔将'
        if m < 90:
            return '学科魔王需「%s」熟练度 ≥ 90（当前 %s）' % (subject, m)
        if sub['conquered']:
            return '该学科魔王已讨伐（★）'
    if enemy == 'demon' and not demon_unlocked(state):
        return '魔神尚未现身：需全部学科魔王通关（研究生）'
    return None


def start_battle(state, subject, enemy):
    """开战：成功返回 battle 对象，失败抛 ValueError。"""
    if subject not in state['subjects']:
        state['subjects'][subject] = new_subject()
    err = check_unlock(state, subject, enemy)
    if err:
        raise ValueError(err)
    definition = ENEMY_DEFS[enemy]
    return {
        'subject': subject,
        'enemy': enemy,
        'enemyHp': 0 if definition['hp'] is None else definition['hp'],
        'enemyMaxHp': 0 if definition['hp'] is None else definition['hp'],
        'difficulty': 1 + (state['defeats'].get('%s:%s' % (subject, enemy)) or 0),
        'questionCount': 0,
        'correctStreak': 0,
        'startedAt': now_ms(),
        'difficultyBumped': False,
    }


def settle_victory(state, battle):
    """胜利结算：写永久进度 + 自动发奖励。"""
    definition = ENEMY_DEFS[battle['enemy']]
    sub = state['subjects'][battle['subject']]
    sub['quest'][definition['key']] = True
    if definition['key'] == 'king':
        sub['conquered'] = True
    if definition['key'] != 'demon':
        sub['mastery'] = clamp(sub['mastery'] + definition['reward']['mastery'], 0, 100)
        state['whale']['favorability'] = clamp(
            state['whale']['favorability'] + definition['reward']['favor'], 0, 100)
        state['defeats']['%s:%s' % (battle['subject'], definition['key'])] = 0
    if demon_unlocked(state):
        state['player']['title'] = '研究生'
    set_mood(state, 'celebrate')
    log_note(state, '讨伐成功：%s·%s（难度 %s）' % (
        battle['subject'], definition['name'], battle['difficulty']), battle['subject'])
    return {'mastery': definition['reward']['mastery'],
            'favor': definition['reward']['favor']}


def apply_battle(state, battle, args=None):
    """结算一次攻击/答题。

    返回 (result, battle)：battle 为 None 表示战斗已结束。
    """
    args = args or {}
    definition = ENEMY_DEFS[battle['enemy']]
    correctness = args.get('correctness')
    correct = clamp(correctness, 0, 1) if isinstance(correctness, (int, float)) \
        and not isinstance(correctness, bool) else None
    battle['questionCount'] += 1
    if correct is not None and correct >= LORD_PASS:
        battle['correctStreak'] += 1
    elif correct is not None:
        battle['correctStreak'] = 0

    damage_self = max(0, _as_number(args.get('damageSelf')))
    result = {'ok': True, 'note': args.get('note') or None, 'hp': state['player']['hp']}

    # 领主求助：无血条，按正确度判定
    if battle['enemy'] == 'lord':
        if correct is None:
            raise ValueError('领主求助需传入 correctness（0~1）')
        if correct >= LORD_PASS:
            reward = settle_victory(state, battle)
            result.update({'victory': True, 'reward': reward})
            return result, None
        state['player']['hp'] = clamp(
            state['player']['hp'] - round(state['player']['maxHp'] * 0.1),
            0, state['player']['maxHp'])
        set_mood(state, 'disappointed')
        result.update({
            'failed': True,
            'reason': '领主求助未达标（正确度 %s < %s），扣 10%% HP' % (correct, LORD_PASS),
        })
        return result, battle

    # 魔神：无限血，一次对峙后收束（暗线推进）
    if battle['enemy'] == 'demon':
        state['player']['hp'] = clamp(
            state['player']['hp'] - damage_self, 0, state['player']['maxHp'])
        state['demonTries'] = (state.get('demonTries') or 0) + 1
        state['whale']['favorability'] = clamp(
            state['whale']['favorability'] + definition['reward']['favor'], 0, 100)
        set_mood(state, 'think' if (correct is not None and correct >= LORD_PASS)
                 else 'disappointed')
        log_note(state, '魔神对峙：%s（第 %s 次），暗线推进' % (
            battle['subject'], state['demonTries']), battle['subject'])
        result.update({
            'demonResolved': True,
            'demonTries': state['demonTries'],
            'message': '魔神的力量深不见底……本次对峙结束，暗线浮现。',
        })
        return result, None

    # 常规战斗
    damage_enemy = max(0, _as_number(args.get('damageEnemy')))
    battle['enemyHp'] = max(0, battle['enemyHp'] - damage_enemy)
    state['player']['hp'] = clamp(
        state['player']['hp'] - damage_self, 0, state['player']['maxHp'])

    if battle['enemyHp'] <= 0:
        reward = settle_victory(state, battle)
        result.update({'victory': True, 'reward': reward,
                       'message': '%s被打败了！' % definition['title']})
        return result, None

    if state['player']['hp'] <= 0:
        state['player']['hp'] = clamp(
            round(state['player']['maxHp'] * NEAR_DEATH), 1, state['player']['maxHp'])
        key = '%s:%s' % (battle['subject'], battle['enemy'])
        state['defeats'][key] = (state['defeats'].get(key) or 0) + 1
        set_mood(state, 'disappointed')
        log_note(state, '败北：%s·%s（重试难度 +1）' % (
            battle['subject'], definition['name']), battle['subject'])
        result.update({'defeat': True, 'rescued': True,
                       'message': '鲸鱼娘把你救回来了（HP → 30），特训后重试。'})
        return result, None

    if (not battle['difficultyBumped']
            and state['player']['hp'] <= state['player']['maxHp'] * NEAR_DEATH):
        battle['difficultyBumped'] = True
        key = '%s:%s' % (battle['subject'], battle['enemy'])
        state['defeats'][key] = (state['defeats'].get(key) or 0) + 1
        set_mood(state, 'error')
        log_note(state, '濒死营救：%s·%s（特训，重试难度 +1）' % (
            battle['subject'], definition['name']), battle['subject'])
        result.update({'nearDeath': True, 'rescued': True,
                       'message': '鲸鱼娘营救：濒死！特训后重试难度 +1。'})
        return result, battle

    return result, battle


def _as_number(v):
    """对应 JS 的 Number(v) || 0：非数值一律当 0。"""
    if isinstance(v, bool) or v is None:
        return 0
    if isinstance(v, (int, float)):
        return v
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0
