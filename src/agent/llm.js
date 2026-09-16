// 大模型客户端 —— 面向**任意 OpenAI 兼容接口**。
// 使用 POST {baseUrl}/chat/completions + Bearer 鉴权，因此不绑定任何一家供应商。
//
// 已实测可用的例子：
//   · 火山引擎 · 火山方舟（默认）：https://ark.cn-beijing.volces.com/api/v3 ，模型形如 ep-xxxxxxxx
//   · DeepSeek：https://api.deepseek.com ，模型 deepseek-chat
//   · 其它任何 OpenAI 兼容服务：填它的 Base URL 与模型名即可
//
// 【BYOK 自带密钥】凭证优先取「本次请求传入的 creds」，其次回落到服务端环境变量：
//   creds.llmApiKey / creds.llmModel / creds.llmBaseUrl
//   ← 环境变量 LLM_API_KEY / LLM_MODEL / LLM_BASE_URL
//   （为兼容早期版本，同时接受 creds.arkApiKey 与 ARK_* 环境变量作为别名）
// 公开部署时**不要**在服务端配置凭证，让每位访客用自己的 Key（服务端不存储任何凭证）。

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

/** 取第一个非空值（用于「新名字优先、旧名字兜底」） */
function pick(...values) {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim()
  return ''
}

/**
 * 解析生效的大模型配置。
 * @param {{llmApiKey?:string, llmModel?:string, llmBaseUrl?:string,
 *          arkApiKey?:string, arkModel?:string, arkBaseUrl?:string}} [creds] 本次请求携带的凭证
 */
export function llmSettings(creds = {}) {
  const apiKey = pick(creds.llmApiKey, creds.arkApiKey, process.env.LLM_API_KEY, process.env.ARK_API_KEY)
  const model = pick(creds.llmModel, creds.arkModel, process.env.LLM_MODEL, process.env.ARK_MODEL)
  const baseUrl = pick(creds.llmBaseUrl, creds.arkBaseUrl,
    process.env.LLM_BASE_URL, process.env.ARK_BASE_URL, DEFAULT_BASE_URL).replace(/\/+$/, '')
  // 凭证来源，便于 UI 提示「你在用自己填的 Key」还是「服务端预置」
  const source = pick(creds.llmApiKey, creds.arkApiKey) ? 'client'
    : (pick(process.env.LLM_API_KEY, process.env.ARK_API_KEY) ? 'server' : 'none')
  return { baseUrl, apiKey, model, source }
}

/** 是否已配置大模型（未配置时上层进入 demo 模式） */
export function isLlmConfigured(creds) {
  const s = llmSettings(creds)
  return Boolean(s.apiKey && s.model)
}

/** 只返回不含密钥的可公开信息 */
export function describeLlm(creds) {
  const s = llmSettings(creds)
  return { configured: Boolean(s.apiKey && s.model), model: s.model || null,
           baseUrl: s.baseUrl, source: s.source }
}

/**
 * 调用大模型对话补全。
 * @param {Array<object>} messages OpenAI 格式消息数组
 * @param {{creds?:object, tools?:Array, toolChoice?:string, temperature?:number, timeoutMs?:number}} [options]
 * @returns {Promise<{content:string, toolCalls:Array, raw:object}>}
 */
export async function llmChat(messages, options = {}) {
  const s = llmSettings(options.creds || {})
  if (!s.apiKey || !s.model) throw new Error('LLM_NOT_CONFIGURED')

  const body = { model: s.model, messages }
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools
    body.tool_choice = options.toolChoice || 'auto'
  }
  if (typeof options.temperature === 'number') body.temperature = options.temperature

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 120000)

  let res
  try {
    res = await fetch(`${s.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${s.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`大模型请求失败（HTTP ${res.status}，${s.baseUrl}）：${text.slice(0, 500)}`)
  }

  const json = await res.json()
  const choice = (json.choices && json.choices[0]) || {}
  const message = choice.message || {}
  return {
    content: message.content || '',
    toolCalls: message.tool_calls || [],
    raw: json,
  }
}
