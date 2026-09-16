# -*- coding: utf-8 -*-
"""离线自测：不联网、不调用模型，验证引擎 / 检索 / 会话是否正常。

对应 Node 版 `scripts/smoke.js` 的 12 项检查，逐条对齐。
运行：python -m unittest discover -s tests -v
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.storage import Storage                      # noqa: E402
from engine.session import GameSession                 # noqa: E402
from engine.game import demon_unlocked                 # noqa: E402
from agent.retriever import local_corpus_retrieve       # noqa: E402


class TestSmoke(unittest.TestCase):
    """12 项自测。用例按序号执行，共享同一个会话（与原版脚本的累积语义一致）。"""

    @classmethod
    def setUpClass(cls):
        fd, cls.save_file = tempfile.mkstemp(prefix='acgal-smoke-', suffix='.json')
        os.close(fd)
        os.remove(cls.save_file)  # 从「无存档」开始，与 Node 版一致
        cls.session = GameSession(Storage(cls.save_file))

    @classmethod
    def tearDownClass(cls):
        try:
            os.remove(cls.save_file)
        except OSError:
            pass

    # ── 引擎：初始状态 ──
    def test_01_初始状态(self):
        s = self.session.status()
        self.assertEqual(s['level'], 1)
        self.assertEqual(s['player']['hp'], 100)
        self.assertEqual(len(s['subjects']), 5)
        self.assertIsNone(s['battle'])

    # ── 引擎：教学结算与升级 ──
    def test_02_教学结算与升级(self):
        self.session.teaching({'subject': '博弈论', 'masteryDelta': 60,
                               'favorabilityDelta': 10, 'note': '自测：教学结算'})
        s = self.session.status()
        self.assertEqual(s['subjects']['博弈论']['mastery'], 60)
        self.assertEqual(s['whale']['favorability'], 10)
        self.assertEqual(s['level'], 2, '总熟练度 60 应为 2 级，实际 %s' % s['level'])

    # ── 引擎：解锁链校验 ──
    def test_03_领主未完成不能挑战魔将(self):
        with self.assertRaisesRegex(ValueError, '领主'):
            self.session.battle_start('博弈论', 'general')

    def test_04_熟练度不足不能挑战领主(self):
        with self.assertRaisesRegex(ValueError, '熟练度'):
            self.session.battle_start('投资', 'lord')

    # ── 引擎：领主求助（无血条，按正确度判定）──
    def test_05_领主求助通关并发奖(self):
        self.session.battle_start('博弈论', 'lord')
        out = self.session.battle_apply({'correctness': 0.8, 'note': '自测：领主求助'})
        self.assertTrue(out['victory'])
        self.assertIsNone(out['battle'])
        s = self.session.status()
        self.assertTrue(s['subjects']['博弈论']['quest']['lord'])
        self.assertEqual(s['subjects']['博弈论']['mastery'], 63,
                         '应 60+3=63，实际 %s' % s['subjects']['博弈论']['mastery'])

    # ── 引擎：魔将战斗（有血条，伤害累积）──
    def test_06_魔将战斗击破并写入任务链(self):
        self.session.teaching({'subject': '博弈论', 'masteryDelta': 12})  # 75，满足魔将条件
        self.session.battle_start('博弈论', 'general')
        out = None
        for _ in range(15):
            out = self.session.battle_apply({'correctness': 1, 'damageEnemy': 3,
                                             'damageSelf': 0})
            if out.get('victory'):
                break
        self.assertTrue(out and out.get('victory'),
                        '应在 15 次内击破魔将（HP 15 / 每次 3 伤）')
        self.assertTrue(self.session.status()['subjects']['博弈论']['quest']['general'])

    def test_07_战斗态在结束后清空(self):
        self.assertIsNone(self.session.status()['battle'])

    # ── 引擎：撤退 ──
    def test_08_撤退清除战斗态且无惩罚(self):
        self.session.teaching({'subject': '投资', 'masteryDelta': 60})
        self.session.battle_start('投资', 'lord')
        self.assertIsNotNone(self.session.status()['battle'])
        r = self.session.battle_retreat()
        self.assertTrue(r['cleared'])
        self.assertIsNone(self.session.status()['battle'])

    # ── 引擎：存档持久化 ──
    def test_09_存档写入后可被新会话读回(self):
        reloaded = GameSession(Storage(self.save_file))
        s = reloaded.status()
        # 60（教学）+3（领主）+12（教学）=75，魔将胜利 +5 -> 80
        self.assertEqual(s['subjects']['博弈论']['mastery'], 80)
        self.assertTrue(s['subjects']['博弈论']['quest']['lord'])
        self.assertTrue(s['subjects']['博弈论']['quest']['general'])

    # ── 引擎：魔神解锁判定 ──
    def test_10_魔神解锁需全科魔王通关(self):
        self.assertFalse(demon_unlocked(self.session.state))

    # ── 检索：本地语料 ──
    def test_11_检索命中纳什均衡(self):
        r = local_corpus_retrieve('纳什均衡', '博弈论')
        self.assertTrue(r['ok'], '检索失败：%s' % (r.get('error') or '无命中'))
        self.assertGreater(len(r['items']), 0)
        self.assertGreater(len(r['items'][0]['content']), 0)

    # ── 会话：重置 ──
    def test_12_重置回到初始状态(self):
        self.session.reset()
        s = self.session.status()
        self.assertEqual(s['level'], 1)
        self.assertEqual(s['subjects']['博弈论']['mastery'], 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
