// 火山引擎 · 火山方舟（Volcengine Ark）客户端
// 使用方舟的 OpenAI 兼容接口：POST {baseUrl}/chat/completions
// 只用全局 fetch，无第三方依赖。
//
// 【BYOK 自带密钥】凭证优先取「本次请求传入的 creds」，其次回落到服务端环境变量：
//   creds.arkApiKey / creds.arkModel / creds.arkBaseUrl
//   ← 环境变量 ARK_API_KEY / ARK_MODEL / ARK_BASE_URL
// 公开部署时**不要**在服务端配置凭证，让每位访客用自己的 Key（服务端不存储任何凭证）。

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

/**
 * 解析生效的方舟配置。
 * @param {{arkApiKey?:string, arkModel?:string, arkBaseUrl?:string}} [creds] 本次请求携带的凭证
 */
export function arkSettings(creds = {}) {
  return {
    baseUrl: (creds.arkBaseUrl || process.env.ARK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: creds.arkApiKey || process.env.ARK_API_KEY || '',
    model: creds.arkModel || process.env.ARK_MODEL || '',
    // 凭证来源，便于 UI 提示「你在用自己填的 Key」还是「服务端预置」
    source: creds.arkApiKey ? 'client' : (process.env.ARK_API_KEY ? 'server' : 'none'),
  }
}

/** 是否已配置方舟（未配置时上层进入 demo 模式） */
export function isArkConfigured(creds) {
  const s = arkSettings(creds)
  return Boolean(s.apiKey && s.model)
}

/** 只返回不含密钥的可公开信息 */
export function describeArk(creds) {
  const s = arkSettings(creds)
  return { configured: Boolean(s.apiKey && s.model), model: s.model || null, baseUrl: s.baseUrl, source: s.source }
}

/**
 * 调用方舟对话补全。
 * @param {Array<object>} messages OpenAI 格式消息数组
 * @param {{creds?:object, tools?:Array, toolChoice?:string, temperature?:number, timeoutMs?:number}} [options]
 * @returns {Promise<{content:string, toolCalls:Array, raw:object}>}
 */
export async function arkChat(messages, options = {}) {
  const s = arkSettings(options.creds || {})
  if (!s.apiKey || !s.model) throw new Error('ARK_NOT_CONFIGURED')

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
    throw new Error(`火山方舟请求失败（HTTP ${res.status}）：${text.slice(0, 500)}`)
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
