# -*- coding: utf-8 -*-
"""GM（游戏主持 / 老师）编排层。

负责：装配系统提示（人设 + 实时状态）-> 调大模型 -> 执行工具调用 -> 直到模型给出最终回复。
未配置模型时进入 demo 模式，保证 UI 与引擎依旧可玩。
"""

import json
import os

from .llm import llm_chat, is_llm_configured
from .retriever import retrieve

PERSONA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'persona.md')
with open(PERSONA_PATH, 'r', encoding='utf-8') as _fh:
    PERSONA = _fh.read()

MAX_TOOL_ROUNDS = 6
MAX_HISTORY = 24

# 工具定义（OpenAI function-calling 格式）
TOOLS = [
    {
        'type': 'function',
        'function': {
            'name': 'ag_status',
            'description': '查看当前游戏状态：等级、HP、鲸鱼娘好感度、心情、各学科熟练度、任务链进度、进行中的战斗。',
            'parameters': {'type': 'object', 'properties': {}, 'required': []},
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'ag_retrieve',
            'description': '从教材语料 / ima 知识库检索资料，作为教学与出题的**真实依据**。禁止凭记忆编造事实。',
            'parameters': {
                'type': 'object',
                'properties': {
                    'query': {'type': 'string', 'description': '检索查询，如「纳什均衡」'},
                    'subject': {'type': 'string', 'description': '学科名（可选，用于选择知识库）'},
                },
                'required': ['query'],
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'ag_apply',
            'description': '结算一次**非战斗**教学/答题：更新学科熟练度、好感度、HP，可设置心情。答对时 delta 为正。',
            'parameters': {
                'type': 'object',
                'properties': {
                    'subject': {'type': 'string', 'description': '学科名'},
                    'masteryDelta': {'type': 'number', 'description': '熟练度增减（-100~100）'},
                    'favorabilityDelta': {'type': 'number', 'description': '好感度增减（-100~100）'},
                    'hpDelta': {'type': 'number', 'description': 'HP 增减（正数回血）'},
                    'mood': {'type': 'string', 'description': '心情：joy / disappointed / celebrate / think'},
                    'note': {'type': 'string', 'description': '备注，写入日志'},
                },
                'required': [],
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'ag_add_subject',
            'description': '新增一个学科（加入后即可开展教学）。',
            'parameters': {
                'type': 'object',
                'properties': {'name': {'type': 'string', 'description': '学科名，如「编程」'}},
                'required': ['name'],
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'ag_battle_start',
            'description': '开始一场战斗/场景任务。enemy = lord(领主求助) / general(魔将) / king(学科魔王) / demon(魔神)。解锁链：60→75→90，且需前一环完成。',
            'parameters': {
                'type': 'object',
                'properties': {
                    'subject': {'type': 'string', 'description': '学科名'},
                    'enemy': {'type': 'string', 'description': 'lord / general / king / demon'},
                },
                'required': ['subject', 'enemy'],
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'ag_battle_apply',
            'description': '结算一次战斗答题。概念题答对 damageEnemy=1/答错 damageSelf=10；开放题 damageEnemy=3×正确度、damageSelf=20×(1-正确度)；领主求助只传 correctness(≥0.6 通过)。胜负奖励由引擎自动发放。',
            'parameters': {
                'type': 'object',
                'properties': {
                    'correctness': {'type': 'number', 'description': '正确度 0~1'},
                    'damageEnemy': {'type': 'number', 'description': '对敌伤害'},
                    'damageSelf': {'type': 'number', 'description': '自伤'},
                    'note': {'type': 'string', 'description': '战报备注'},
                },
                'required': [],
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'ag_battle_retreat',
            'description': '撤退，清除战斗态，无惩罚。',
            'parameters': {'type': 'object', 'properties': {}, 'required': []},
        },
    },
]


def render_state(state):
    """把实时状态渲染成简短的文本，供系统提示使用。"""
    lines = []
    for name, v in state['subjects'].items():
        q = v.get('quest') or {}
        chain = '领主%s 魔将%s 魔王%s' % (
            '[OK]' if q.get('lord') else '[X]',
            '[OK]' if q.get('general') else '[X]',
            '[OK]' if v.get('conquered') else '[X]')
        lines.append('- %s：熟练度 %s（%s）' % (name, v.get('mastery'), chain))
    subs = '\n'.join(lines)
    b = state.get('battle')
    battle = ('进行中：%s · %s（敌 HP %s/%s，难度 %s）' % (
        b['subject'], b['enemyName'], b['enemyHp'], b['enemyMaxHp'], b['difficulty'])
        if b else '无')
    return '\n'.join([
        '【当前状态】等级 %s｜HP %s/%s｜称号 %s' % (
            state['level'], state['player']['hp'],
            state['player']['maxHp'], state['player']['title']),
        '鲸鱼娘好感 %s（档位 %s）｜心情 %s' % (
            state['whale']['favorability'], state['whaleTier'], state.get('mood') or '平静'),
        '学科：\n%s' % subs,
        '战斗：%s' % battle,
        '魔神已解锁（全科魔王通关，称号「研究生」）' if state.get('demonUnlocked') else '魔神未解锁',
    ])


# demo 模式的示例提问（未配置大模型时使用，保证 UI 可玩）
DEMO_PROMPTS = [
    '先别急着要结论——你觉得「需求减少，价格必然下跌」这句话里，藏着一个什么前提假设？如果那个假设不成立，结论还站得住吗？',
    '你刚才用的是「相关」还是「因果」？举个反例试试：有没有两个变量一起变化、却没有因果关系的例子？',
    '换个视角看：如果是完全不同意你观点的人，他会从哪一步反驳你？你觉得他最可能攻击你论证的哪一环？',
    '我们推演一下后果：假如你的结论成立，三年后会出现什么？谁受益、谁受损？',
]


class GameMaster(object):
    def __init__(self, session):
        self.session = session
        self.history = []  # 对话历史（不含 system）
        self.demo_index = 0

    def reset(self):
        self.history = []
        self.session.reset()

    def build_system_prompt(self):
        return '%s\n\n%s\n\n# 每一轮回复都必须做到\n%s' % (PERSONA, render_state(self.session.status()), (
            '1. 用苏格拉底式提问推进：先抛情境/追问，**不要直接给答案**；一次只推进一层。\n'
            '2. **只要你对学徒的回答做出了判定（答对/提示后答对/答错），就必须立即调用「ag_apply」** '
            '把熟练度、好感度、心情写进游戏。\n'
            '   只在文字里说「答对了」「不错」**不算结算**，数值不会变化。调用完工具再输出你的回复文字。\n'
            '3. 出题与讲解的依据必须来自「ag_retrieve」检索到的真实资料，禁止编造数据或文献。\n'
            '4. 反馈保持简短：1~2 句肯定/复述 + 1~2 个追问，200~400 字内。\n\n'
            '# 开场要求\n先做简短问候，提醒今日该复习的知识点，再抛一个开放性问题开始教学。'))

    def exec_tool(self, name, args=None, creds=None, uploads=None):
        """执行一次工具调用，返回可序列化结果。"""
        args = args or {}
        if name == 'ag_status':
            return self.session.status()
        if name == 'ag_retrieve':
            return retrieve(args.get('query'), args.get('subject'), creds, uploads)
        if name == 'ag_apply':
            return self.session.teaching(args)
        if name == 'ag_add_subject':
            return self.session.add_subject(args.get('name'))
        if name == 'ag_battle_start':
            return self.session.battle_start(args.get('subject'), args.get('enemy'))
        if name == 'ag_battle_apply':
            return self.session.battle_apply(args)
        if name == 'ag_battle_retreat':
            return self.session.battle_retreat()
        return {'ok': False, 'error': '未知工具：%s' % name}

    def say(self, message, creds=None, uploads=None):
        """处理一条玩家消息。

        返回 {'reply', 'events', 'state', 'demo'}
        """
        creds = creds or {}
        uploads = uploads or []
        text = str(message or '').strip()
        events = []

        # ── demo 模式：既没有请求凭证、服务端也没配凭证时，用示例提问驱动界面 ──
        if not is_llm_configured(creds):
            reply = DEMO_PROMPTS[self.demo_index % len(DEMO_PROMPTS)]
            self.demo_index += 1
            # 轮换学科结算，让 UI 的熟练度条也能看到变化
            names = list(self.session.state['subjects'].keys())
            subject = names[self.demo_index % len(names)] if names else None
            args = {'subject': subject, 'masteryDelta': 4, 'favorabilityDelta': 2,
                    'mood': 'think', 'note': 'demo 模式：模拟一次苏格拉底追问'}
            events.append({'name': 'ag_apply', 'args': args})
            state = self.session.teaching(args)
            return {'reply': reply, 'events': events, 'state': state, 'demo': True}

        # ── 真实模式：大模型 + 工具调用循环 ──
        messages = [{'role': 'system', 'content': self.build_system_prompt()}]
        messages.extend(self.history)
        if text:
            messages.append({'role': 'user', 'content': text})

        final_reply = ''
        for round_index in range(MAX_TOOL_ROUNDS):
            # 最后一轮强制「只输出文字」，避免模型无限调工具、始终不给回复
            is_last_round = (round_index == MAX_TOOL_ROUNDS - 1)
            out = llm_chat(messages, {
                'tools': TOOLS,
                'toolChoice': 'none' if is_last_round else 'auto',
                'temperature': 0.8,
                'creds': creds,
            })
            content, tool_calls = out['content'], out['toolCalls']

            if not tool_calls:
                final_reply = content
                break

            # 记录助手的工具调用意图
            messages.append({'role': 'assistant', 'content': content or None,
                             'tool_calls': tool_calls})

            for call in tool_calls:
                fn = call.get('function') or {}
                try:
                    args = json.loads(fn['arguments']) if fn.get('arguments') else {}
                except Exception:
                    args = {}
                try:
                    result = self.exec_tool(fn.get('name'), args, creds, uploads)
                except Exception as e:
                    result = {'ok': False, 'error': str(e)}
                events.append({'name': fn.get('name'), 'args': args, 'result': result})
                messages.append({'role': 'tool', 'tool_call_id': call.get('id'),
                                 'content': json.dumps(result, ensure_ascii=False)[:6000]})

        if not final_reply:
            final_reply = '（鲸鱼娘眨了眨眼：这一轮问得有点深，我们换个角度再来一次？）'

        # 维护历史
        if text:
            self.history.append({'role': 'user', 'content': text})
        self.history.append({'role': 'assistant', 'content': final_reply})
        if len(self.history) > MAX_HISTORY:
            del self.history[:len(self.history) - MAX_HISTORY]

        return {'reply': final_reply, 'events': events,
                'state': self.session.status(), 'demo': False}
