# -*- coding: utf-8 -*-
"""engine：纯游戏逻辑层（状态机 / 战斗 / 存档）。

本层不发网络请求，可脱离 agent、server 单独使用与测试。
"""

from .config import (SEED_SUBJECTS, ENEMY_DEFS, LORD_PASS, NEAR_DEATH,
                     PLAYER_MAX_HP, MASTERY_PER_LEVEL, STATE_FRAMES,
                     TIER_IMAGE, MOOD_TTL_MS, DERIVED_WEIGHTS, FAVOR_TIERS)
from .game import (clamp, is_num, now_ms, new_subject, create_state, migrate_state,
                   total_mastery, level_of, whale_tier, effective_mood,
                   current_image_key, demon_unlocked, derived_attributes,
                   log_note, set_mood, apply_teaching, add_subject,
                   remove_subject, status_view)
from .battle import (battle_view, check_unlock, start_battle, apply_battle,
                     settle_victory)
from .storage import Storage, MemoryStorage
from .session import GameSession

__all__ = [
    'SEED_SUBJECTS', 'ENEMY_DEFS', 'LORD_PASS', 'NEAR_DEATH', 'PLAYER_MAX_HP',
    'MASTERY_PER_LEVEL', 'STATE_FRAMES', 'TIER_IMAGE', 'MOOD_TTL_MS',
    'DERIVED_WEIGHTS', 'FAVOR_TIERS',
    'clamp', 'is_num', 'now_ms', 'new_subject', 'create_state', 'migrate_state',
    'total_mastery', 'level_of', 'whale_tier', 'effective_mood',
    'current_image_key', 'demon_unlocked', 'derived_attributes', 'log_note',
    'set_mood', 'apply_teaching', 'add_subject', 'remove_subject', 'status_view',
    'battle_view', 'check_unlock', 'start_battle', 'apply_battle', 'settle_victory',
    'Storage', 'MemoryStorage', 'GameSession',
]
