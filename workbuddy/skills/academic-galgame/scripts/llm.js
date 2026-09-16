// LLM 接入（Node 侧，零依赖）
//
// WorkBuddy 版的两条路子，二选一：
//   A. 自备 API —— 任何 OpenAI 兼容接口（火山方舟 / DeepSeek / OpenAI …）
//   B. 用 WorkBuddy 自己的积分 —— 不填 key，鲸鱼娘的讲解由你（WorkBuddy Agent）自己写
//
// 本模块只管 A。B 不需要任何配置，是默认状态。
//
// 凭证只存本地，绝不进仓库：
//   ${GALGAME_HOME:-~/.workbuddy/academic-galgame}/credentials.json
//   环境变量优先：LLM_API_KEY / LLM_MODEL / LLM_BASE_URL
import { readCredsFile, saveCreds, mask, CRED_FILE } from './creds.js'

export const DEFAULT_BASE = 'https://ark.cn-beijing.volces.com/api/v3'
export const DEFAULT_MODEL = 'deepseek-v3-250324'

/** 服务商预设（与 Web 版同一份，避免「只认火山引擎」的误会） */
export const PROVIDER_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { id: 'ark', name: '火山方舟（火山引擎）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '', modelHint: 'ep-xxxxxxxx（推理接入点 ID）' },
  { id: 'moonshot', name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'dashscope', name: '阿里通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
]

const _BY_ID = Object.fromEntries(PROVIDER_PRESETS.map((p) => [p.id, p]))
const _MODEL_RULES = [
  ['ep-', 'ark'], ['deepseek', 'deepseek'], ['moonshot', 'moonshot'], ['kimi', 'moonshot'],
  ['glm', 'zhipu'], ['charglm', 'zhipu'], ['qwen', 'dashscope'], ['tongyi', 'dashscope'],
  ['gpt', 'openai'], ['chatgpt', 'openai'], ['o1', 'openai'], ['o3', 'openai'], ['o4', 'openai'],
]

/** 从模型名猜服务商；猜不出来返回 '' */
export function inferProvider(model) {
  const m = String(model || '').trim().toLowerCase()
  if (!m) return ''
  if (m.includes('/')) return 'siliconflow'
  for (const [prefix, id] of _MODEL_RULES) if (m.startsWith(prefix)) return id
  return ''
}

/* ══════════ 凭证 ══════════ */

/** 生效 LLM 配置：环境变量 > 本地文件。
 *
 *  地址的取法：填了就用手填的；没填就按模型名认服务商；
 *  都认不出来时 baseUrl 为空 —— 调用时会明确报错，而不是偷偷发去火山方舟。
 */
export function loadLlm() {
  const f = readCredsFile()
  const model = process.env.LLM_MODEL || f.llmModel || DEFAULT_MODEL
  const explicit = (process.env.LLM_BASE_URL || f.llmBaseUrl || '').trim()
  const provider = explicit ? '' : inferProvider(model)
  const baseUrl = (explicit || (_BY_ID[provider] && _BY_ID[provider].baseUrl) || '').replace(/\/+$/, '')
  return {
    llmApiKey: process.env.LLM_API_KEY || f.llmApiKey || '',
    llmModel: model,
    llmBaseUrl: baseUrl,
    provider,
    providerName: (_BY_ID[provider] && _BY_ID[provider].name) || '',
    baseUrlSource: explicit ? 'explicit' : (baseUrl ? 'inferred' : 'missing'),
  }
}

export function saveLlm(patch) {
  const next = {}
  if (patch.llmApiKey !== undefined) next.llmApiKey = String(patch.llmApiKey).trim()
  if (patch.llmModel !== undefined) next.llmModel = String(patch.llmModel).trim()
  if (patch.llmBaseUrl !== undefined) next.llmBaseUrl = String(patch.llmBaseUrl).trim().replace(/\/+$/, '')
  return saveCreds(next)
}

/** 自备 API 是否可用（只要 key + 模型名齐了就算「配了」；
 *  地址认不出来时会在真正调用时明确报错，而不是悄悄退回积分模式让人以为在用 Key） */
export function llmConfigured(cfg) {
  const c = cfg || loadLlm()
  return Boolean(c.llmApiKey && c.llmModel)
}

export function llmStatus() {
  const c = loadLlm()
  const configured = llmConfigured(c)
  return {
    ok: true,
    file: CRED_FILE,
    mode: configured ? 'own-api' : 'workbuddy-credits',
    modeLabel: configured ? '自备 API' : 'WorkBuddy 积分（由 Agent 自己讲解与判分）',
    configured,
    llmApiKey: mask(c.llmApiKey),
    llmModel: c.llmModel,
    llmBaseUrl: c.llmBaseUrl,
    // 地址是手填的还是按模型名认出来的 —— 让人一眼看懂请求会发去哪儿
    baseUrlSource: c.baseUrlSource,
    provider: c.provider,
    providerName: c.providerName,
    fromEnv: Boolean(process.env.LLM_API_KEY || process.env.LLM_BASE_URL || process.env.LLM_MODEL),
  }
}

/* ══════════ 调用 ══════════ */

const REQ_TIMEOUT = 90000

/** 把原始英文报错翻成能照着做的话 */
function explainHttp(code, baseUrl, detail) {
  const where = `${baseUrl}/chat/completions`
  const short = String(detail || '').trim().slice(0, 300)
  if (code === 401) {
    return '认证失败（HTTP 401）。两种可能：\n'
      + '  ① API Key 填错了或不完整；\n'
      + `  ② Key 是别家的，但请求发去了 ${baseUrl}。\n`
      + '用 llm status 看一眼「请求会发去哪儿」，必要时用 '
      + 'llm config --base-url <地址> 指定（DeepSeek 是 https://api.deepseek.com）。\n'
      + `服务端原话：${short}`
  }
  if (code === 403) return `被拒绝（HTTP 403）：Key 没有调用该模型的权限，或模型未开通。当前地址：${where}\n服务端原话：${short}`
  if (code === 404) {
    return `地址不存在（HTTP 404）：${where}\n`
      + 'Base URL 一般填到 /v1 这一层，不要带 /chat/completions。\n'
      + `服务端原话：${short}`
  }
  if (code === 429) return `请求太频繁或额度用尽（HTTP 429）。稍后再试。\n服务端原话：${short}`
  if (code === 400) return `服务端说请求有问题（HTTP 400）——最常见的是模型名不对。当前地址：${where}\n服务端原话：${short}`
  if (code >= 500) return `服务端故障（HTTP ${code}），不是配置问题，稍后再试。${short}`
  return `LLM 请求失败（HTTP ${code}，${where}）：${short}`
}

/**
 * OpenAI 兼容 chat completions。
 * 未配置自备 API 时抛出 needsWorkbuddy 错误，交由上层用 WorkBuddy 自身模型接管。
 */
export async function llmChat(messages, opts = {}) {
  const c = loadLlm()
  if (!llmConfigured(c)) {
    const e = new Error('未配置自备 LLM API —— 走 WorkBuddy 积分模式，由你（Agent）自己完成这一步')
    e.needsWorkbuddy = true
    throw e
  }
  if (!c.llmBaseUrl) {
    throw new Error('不知道要把请求发去哪儿：没填 Base URL，而且从模型名「' + c.llmModel
      + '」也认不出是哪家服务。\n用 llm config --base-url <地址> 指定（DeepSeek 是 https://api.deepseek.com），'
      + '或把模型名改成常见名字（deepseek-chat / glm-4-flash / qwen-plus …）。')
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || REQ_TIMEOUT)
  try {
    const res = await fetch(`${c.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${c.llmApiKey}`,
      },
      body: JSON.stringify({
        model: opts.model || c.llmModel,
        messages,
        temperature: opts.temperature === undefined ? 0.6 : opts.temperature,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      }),
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(explainHttp(res.status, c.llmBaseUrl, text))
    }
    let json
    try { json = JSON.parse(text) } catch { throw new Error(`LLM 返回非 JSON：${text.slice(0, 200)}`) }
    const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content
    if (!content) throw new Error(`LLM 返回里没有内容：${text.slice(0, 200)}`)
    return { ok: true, content: String(content).trim(), usage: json.usage || null, model: json.model || c.llmModel }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`LLM 请求超时（${(opts.timeoutMs || REQ_TIMEOUT) / 1000}s）`)
    // fetch 失败时真正的网络原因藏在 cause 里（DNS / TLS / 连接被重置…），补出来方便排查
    if (e && e.message === 'fetch failed' && e.cause) {
      const c = e.cause
      throw new Error(`连不上 LLM（${c.code || c.name || 'fetch failed'}${c.message && c.message !== e.message ? '：' + c.message : ''}）`
        + ` —— 检查网络/代理，或 --base-url 是否写对：${c.hostname || ''}`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 连通性自检 */
export async function testLlm() {
  const started = Date.now()
  try {
    const r = await llmChat([{ role: 'user', content: '只回复两个字：可用' }], { temperature: 0, maxTokens: 16 })
    return { ok: true, ms: Date.now() - started, model: r.model, reply: r.content.slice(0, 40) }
  } catch (e) {
    if (e && e.needsWorkbuddy) {
      return { ok: true, mode: 'workbuddy-credits', note: '未配置自备 API，将使用 WorkBuddy 积分模式（不消耗你自己的 key）' }
    }
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/* ══════════ 判分 ══════════ */

/**
 * 给玩家的作答判正确度 0-100，并挑出最该追问的盲点。
 * 未配置自备 API → 返回 needsAgentJudgement，请 WorkBuddy 自己判，然后调 apply。
 */
export async function judgeAnswer({ subject, question, answer, points, rubric }) {
  const sys = [
    '你是一位严格的学术判卷老师。玩家刚回答了一道苏格拉底式问题。',
    '只输出 JSON，不要任何多余文字，格式：',
    '{"correctness":0-100的数字,"verdict":"一句话总评","blindspots":["盲点1","盲点2"],"next_question":"最该追问的一句"}',
    '判分标准：只答对表面现象不给高分；能指出机制、条件、反例、边界才给高分。',
    '不要因为玩家表达口语化就扣分，只看知识是否真的到位。',
  ].join('\n')

  const knowledge = Array.isArray(points) && points.length
    ? points.map((p, i) => `${i + 1}. ${typeof p === 'string' ? p : (p.point || p.name || JSON.stringify(p))}`).join('\n')
    : '(未提供知识点清单)'

  const user = [
    `学科：${subject || '(未指定)'}`,
    `本轮要掌握的知识点：\n${knowledge}`,
    rubric ? `评分细则：${rubric}` : '',
    `老师的问题：${question || '(未记录)'}`,
    `玩家的回答：${answer || '(空)'}`,
  ].filter(Boolean).join('\n\n')

  try {
    const r = await llmChat(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      { temperature: 0.2, maxTokens: 600 },
    )
    const m = r.content.match(/\{[\s\S]*\}/)
    if (!m) return { ok: false, needsAgentJudgement: true, raw: r.content, hint: '模型没给 JSON，请你直接判断正确度' }
    const j = JSON.parse(m[0])
    const correctness = Math.max(0, Math.min(100, Math.round(Number(j.correctness) || 0)))
    return {
      ok: true,
      mode: 'own-api',
      correctness,
      verdict: String(j.verdict || ''),
      blindspots: Array.isArray(j.blindspots) ? j.blindspots.map(String).slice(0, 4) : [],
      nextQuestion: String(j.next_question || ''),
      usage: r.usage,
    }
  } catch (e) {
    if (e && e.needsWorkbuddy) {
      return {
        ok: false,
        needsAgentJudgement: true,
        mode: 'workbuddy-credits',
        hint: '未配置自备 API。请你自己按上面的知识点判断玩家回答的正确度（0-100），挑出盲点，然后调 apply 把分数写进游戏。',
      }
    }
    return { ok: false, needsAgentJudgement: true, error: String((e && e.message) || e) }
  }
}
