// 火山引擎 · 火山方舟（Volcengine Ark）客户端
// 使用方舟的 OpenAI 兼容接口：POST {baseUrl}/chat/completions
// 只用全局 fetch，无第三方依赖。
//
// 需要的环境变量：
//   ARK_API_KEY  方舟 API Key（必需）
//   ARK_MODEL    推理接入点 ID 或模型名（必需），如 ep-xxxxxxxx 或 doubao-xxx
//   ARK_BASE_URL 可选，默认 https://ark.cn-beijing.volces.com/api/v3

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

export function arkSettings() {
  return {
    baseUrl: (process.env.ARK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: process.env.ARK_API_KEY || '',
    model: process.env.ARK_MODEL || '',
  }
}

/** 是否已配置方舟（未配置时上层进入 demo 模式） */
export function isArkConfigured() {
  const s = arkSettings()
  return Boolean(s.apiKey && s.model)
}

/**
 * 调用方舟对话补全。
 * @param {Array<object>} messages OpenAI 格式消息数组
 * @param {{tools?:Array, toolChoice?:string, temperature?:number, timeoutMs?:number}} [options]
 * @returns {Promise<{content:string, toolCalls:Array, raw:object}>}
 */
export async function arkChat(messages, options = {}) {
  const s = arkSettings()
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
