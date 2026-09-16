// GM（游戏主持 / 老师）编排层。
// 负责：装配系统提示（人设 + 实时状态）→ 调大模型 → 执行工具调用 → 直到模型给出最终回复。
// 未配置模型时进入 demo 模式，保证 UI 与引擎依旧可玩。
import { readFileSync } from 'node:fs'
import { llmChat, isLlmConfigured } from './llm.js'
import { retrieve } from './retriever.js'

const PERSONA = readFileSync(new URL('./persona.md', import.meta.url), 'utf8')
const MAX_TOOL_ROUNDS = 6
const MAX_HISTORY = 24

/** 工具定义（OpenAI function-calling 格式） */
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'ag_status',
      description: '查看当前游戏状态：等级、HP、鲸鱼娘好感度、心情、各学科熟练度、任务链进度、进行中的战斗。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ag_retrieve',
      description: '从教材语料 / ima 知识库检索资料，作为教学与出题的**真实依据**。禁止凭记忆编造事实。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索查询，如「纳什均衡」' },
          subject: { type: 'string', description: '学科名（可选，用于选择知识库）' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ag_apply',
      description: '结算一次**非战斗**教学/答题：更新学科熟练度、好感度、HP，可设置心情。答对时 delta 为正。',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: '学科名' },
          masteryDelta: { type: 'number', description: '熟练度增减（-100~100）' },
          favorabilityDelta: { type: 'number', description: '好感度增减（-100~100）' },
          hpDelta: { type: 'number', description: 'HP 增减（正数回血）' },
          mood: { type: 'string', description: '心情：joy / disappointed / celebrate / think' },
          note: { type: 'string', description: '备注，写入日志' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ag_add_subject',
      description: '新增一个学科（加入后即可开展教学）。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '学科名，如「编程」' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ag_battle_start',
      description: '开始一场战斗/场景任务。enemy = lord(领主求助) / general(魔将) / king(学科魔王) / demon(魔神)。解锁链：60→75→90，且需前一环完成。',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: '学科名' },
          enemy: { type: 'string', description: 'lord / general / king / demon' },
        },
        required: ['subject', 'enemy'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ag_battle_apply',
      description: '结算一次战斗答题。概念题答对 damageEnemy=1/答错 damageSelf=10；开放题 damageEnemy=3×正确度、damageSelf=20×(1−正确度)；领主求助只传 correctness(≥0.6 通过)。胜负奖励由引擎自动发放。',
      parameters: {
        type: 'object',
        properties: {
          correctness: { type: 'number', description: '正确度 0~1' },
          damageEnemy: { type: 'number', description: '对敌伤害' },
          damageSelf: { type: 'number', description: '自伤' },
          note: { type: 'string', description: '战报备注' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ag_battle_retreat',
      description: '撤退，清除战斗态，无惩罚。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
]

/** 把实时状态渲染成简短的文本，供系统提示使用 */
function renderState(state) {
  const subs = Object.entries(state.subjects)
    .map(([k, v]) => {
      const q = v.quest || {}
      const chain = `领主${q.lord ? '✓' : '✗'} 魔将${q.general ? '✓' : '✗'} 魔王${v.conquered ? '✓' : '✗'}`
      return `- ${k}：熟练度 ${v.mastery}（${chain}）`
    })
    .join('\n')
  const battle = state.battle
    ? `进行中：${state.battle.subject} · ${state.battle.enemyName}（敌 HP ${state.battle.enemyHp}/${state.battle.enemyMaxHp}，难度 ${state.battle.difficulty}）`
    : '无'
  return [
    `【当前状态】等级 ${state.level}｜HP ${state.player.hp}/${state.player.maxHp}｜称号 ${state.player.title}`,
    `鲸鱼娘好感 ${state.whale.favorability}（档位 ${state.whale.whaleTier}）｜心情 ${state.mood || '平静'}`,
    `学科：\n${subs}`,
    `战斗：${battle}`,
    state.demonUnlocked ? '魔神已解锁（全科魔王通关，称号「研究生」）' : '魔神未解锁',
  ].join('\n')
}

/** demo 模式的示例提问（未配置方舟时使用，保证 UI 可玩） */
const DEMO_PROMPTS = [
  '先别急着要结论——你觉得「需求减少，价格必然下跌」这句话里，藏着一个什么前提假设？如果那个假设不成立，结论还站得住吗？',
  '你刚才用的是「相关」还是「因果」？举个反例试试：有没有两个变量一起变化、却没有因果关系的例子？',
  '换个视角看：如果是完全不同意你观点的人，他会从哪一步反驳你？你觉得他最可能攻击你论证的哪一环？',
  '我们推演一下后果：假如你的结论成立，三年后会出现什么？谁受益、谁受损？',
]

export class GameMaster {
  /** @param {import('../engine/session.js').GameSession} session */
  constructor(session) {
    this.session = session
    /** 对话历史（不含 system） */
    this.history = []
    this.demoIndex = 0
  }

  reset() {
    this.history = []
    this.session.reset()
  }

  buildSystemPrompt() {
    return `${PERSONA}

${renderState(this.session.status())}

# 每一轮回复都必须做到
1. 用苏格拉底式提问推进：先抛情境/追问，**不要直接给答案**；一次只推进一层。
2. **只要你对学徒的回答做出了判定（答对/提示后答对/答错），就必须立即调用「ag_apply」** 把熟练度、好感度、心情写进游戏。
   只在文字里说「答对了」「不错」**不算结算**，数值不会变化。调用完工具再输出你的回复文字。
3. 出题与讲解的依据必须来自「ag_retrieve」检索到的真实资料，禁止编造数据或文献。
4. 反馈保持简短：1~2 句肯定/复述 + 1~2 个追问，200~400 字内。

# 开场要求
先做简短问候，提醒今日该复习的知识点，再抛一个开放性问题开始教学。`
  }

  /**
   * 执行一次工具调用，返回可序列化结果。
   * @param {string} name 工具名
   * @param {object} args 工具参数
   * @param {object} [creds] 本次请求携带的凭证（BYOK）
   * @param {Array<{name:string,text:string}>} [uploads] 本会话上传的教材
   */
  async execTool(name, args = {}, creds = {}, uploads = []) {
    switch (name) {
      case 'ag_status':
        return this.session.status()
      case 'ag_retrieve':
        return await retrieve(args.query, args.subject, creds, uploads)
      case 'ag_apply':
        return this.session.teaching(args)
      case 'ag_add_subject':
        return this.session.addSubject(args.name)
      case 'ag_battle_start':
        return this.session.battleStart(args.subject, args.enemy)
      case 'ag_battle_apply':
        return this.session.battleApply(args)
      case 'ag_battle_retreat':
        return this.session.battleRetreat()
      default:
        return { ok: false, error: `未知工具：${name}` }
    }
  }

  /**
   * 处理一条玩家消息。
   * @param {string} message
   * @param {object} [creds] 本次请求携带的凭证（BYOK）：llmApiKey/llmModel/llmBaseUrl/imaApiKey/imaClientId/imaKbMap
   * @param {Array<{name:string,text:string}>} [uploads] 本会话上传的教材
   * @returns {Promise<{reply:string, events:Array, state:object, demo:boolean}>}
   */
  async say(message, creds = {}, uploads = []) {
    const text = String(message || '').trim()
    const events = []

    // ── demo 模式：既没有请求凭证、服务端也没配凭证时，用示例提问驱动界面 ──
    if (!isLlmConfigured(creds)) {
      const reply = DEMO_PROMPTS[this.demoIndex % DEMO_PROMPTS.length]
      this.demoIndex++
      // 轮换学科结算，让 UI 的熟练度条也能看到变化
      const names = Object.keys(this.session.state.subjects)
      const subject = names.length ? names[this.demoIndex % names.length] : undefined
      const args = { subject, masteryDelta: 4, favorabilityDelta: 2, mood: 'think', note: 'demo 模式：模拟一次苏格拉底追问' }
      events.push({ name: 'ag_apply', args })
      const state = this.session.teaching(args)
      return { reply, events, state, demo: true }
    }

    // ── 真实模式：大模型 + 工具调用循环 ──
    const messages = [{ role: 'system', content: this.buildSystemPrompt() }]
    for (const m of this.history) messages.push(m)
    if (text) messages.push({ role: 'user', content: text })

    let finalReply = ''
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // 最后一轮强制「只输出文字」，避免模型无限调工具、始终不给回复
      const isLastRound = round === MAX_TOOL_ROUNDS - 1
      const { content, toolCalls } = await llmChat(messages, {
        tools: TOOLS,
        toolChoice: isLastRound ? 'none' : 'auto',
        temperature: 0.8,
        creds,
      })

      if (!toolCalls || toolCalls.length === 0) {
        finalReply = content
        break
      }

      // 记录助手的工具调用意图
      messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls })

      for (const call of toolCalls) {
        const fn = call.function || {}
        let args = {}
        try { args = fn.arguments ? JSON.parse(fn.arguments) : {} } catch { args = {} }
        let result
        try {
          result = await this.execTool(fn.name, args, creds, uploads)
        } catch (e) {
          result = { ok: false, error: String((e && e.message) || e) }
        }
        events.push({ name: fn.name, args, result })
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 6000) })
      }
    }

    if (!finalReply) finalReply = '（鲸鱼娘眨了眨眼：这一轮问得有点深，我们换个角度再来一次？）'

    // 维护历史
    if (text) this.history.push({ role: 'user', content: text })
    this.history.push({ role: 'assistant', content: finalReply })
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY)

    return { reply: finalReply, events, state: this.session.status(), demo: false }
  }
}
