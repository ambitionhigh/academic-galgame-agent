// 大模型客户端 —— 面向**任意 OpenAI 兼容接口**。
// 使用 POST {baseUrl}/chat/completions + Bearer 鉴权，因此不绑定任何一家供应商。
//
// 【为什么要「猜」服务商】
// Base URL 留空时如果静默回落到火山方舟，那么用 DeepSeek Key 的人会拿到一个
// 莫名其妙的 401（提示 "API key format is incorrect"），看起来就像「这软件只认火山引擎」。
// 所以现在的规则是：
//   · 填了 Base URL        → 就用它（最优先，永远是权威）
//   · 没填，但模型名能认出  → 自动补上对应服务商的地址（UI 上会标明「已自动识别」）
//   · 没填，也认不出来      → 明确报错，让人去填 Base URL，而不是偷偷发去火山方舟
//
// 【BYOK 自带密钥】凭证优先取「本次请求传入的 creds」，其次回落到服务端环境变量：
//   creds.llmApiKey / creds.llmModel / creds.llmBaseUrl
//   ← 环境变量 LLM_API_KEY / LLM_MODEL / LLM_BASE_URL
//   （为兼容早期版本，同时接受 creds.arkApiKey 与 ARK_* 环境变量作为别名）
// 公开部署时**不要**在服务端配置凭证，让每位访客用自己的 Key（服务端不存储任何凭证）。

/** 服务商预设（前端下拉框也从这个接口取，保证两版一致） */
export const PROVIDER_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', hint: '便宜好用，国内可直连' },
  { id: 'ark', name: '火山方舟（火山引擎）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '', modelHint: 'ep-xxxxxxxx（推理接入点 ID，不是模型名）', hint: '模型名要填你创建的推理接入点' },
  { id: 'moonshot', name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', hint: '' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', hint: '' },
  { id: 'dashscope', name: '阿里通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', hint: '' },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3', hint: '' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hint: '国内需自备网络环境' },
  { id: 'custom', name: '其它 / 自定义', baseUrl: '', model: '', hint: '任何 OpenAI 兼容地址都行，填到 /v1 这一层' },
]

const BY_ID = Object.fromEntries(PROVIDER_PRESETS.map((p) => [p.id, p]))

const MODEL_RULES = [
  ['ep-', 'ark'],
  ['deepseek', 'deepseek'],
  ['moonshot', 'moonshot'],
  ['kimi', 'moonshot'],
  ['glm', 'zhipu'],
  ['charglm', 'zhipu'],
  ['qwen', 'dashscope'],
  ['tongyi', 'dashscope'],
  ['gpt', 'openai'],
  ['chatgpt', 'openai'],
  ['o1', 'openai'],
  ['o3', 'openai'],
  ['o4', 'openai'],
]

export function presetBase(id) {
  return (BY_ID[id] && BY_ID[id].baseUrl) || ''
}

/** 从模型名猜服务商；猜不出来返回 '' */
export function inferProvider(model) {
  const m = String(model || '').trim().toLowerCase()
  if (!m) return ''
  if (m.includes('/')) return 'siliconflow'   // 形如 deepseek-ai/DeepSeek-V3 → 聚合平台
  for (const [prefix, id] of MODEL_RULES) if (m.startsWith(prefix)) return id
  return ''
}

/** 取第一个非空值（用于「新名字优先、旧名字兜底」） */
function pick(...values) {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim()
  return ''
}

/**
 * 解析生效的大模型配置。
 * baseUrlSource 有三种：client / server（明确填了）、inferred（按模型名识别）、missing（认不出）
 * @param {{llmApiKey?:string, llmModel?:string, llmBaseUrl?:string,
 *          arkApiKey?:string, arkModel?:string, arkBaseUrl?:string}} [creds] 本次请求携带的凭证
 */
export function llmSettings(creds = {}) {
  const apiKey = pick(creds.llmApiKey, creds.arkApiKey, process.env.LLM_API_KEY, process.env.ARK_API_KEY)
  const model = pick(creds.llmModel, creds.arkModel, process.env.LLM_MODEL, process.env.ARK_MODEL)

  const explicit = pick(creds.llmBaseUrl, creds.arkBaseUrl)
  const clientKey = pick(creds.llmApiKey, creds.arkApiKey)
  const serverBase = pick(process.env.LLM_BASE_URL, process.env.ARK_BASE_URL)
  let baseUrl, baseUrlSource, provider
  if (explicit) {
    // ① 用户自己填了地址 —— 永远最优先
    baseUrl = explicit.replace(/\/+$/, '')
    baseUrlSource = 'client'
    provider = ''
  } else if (clientKey) {
    // ② 用户自带 Key，但没填地址 —— 只能按模型名认。
    //    这里**绝不套用服务端预置地址**：那正是「用 DeepSeek Key 却被发去火山方舟」
    //    然后报 401 的根源。认不出来就老实报错，让人去填。
    provider = inferProvider(model)
    baseUrl = presetBase(provider)
    baseUrlSource = baseUrl ? 'inferred' : 'missing'
  } else if (serverBase) {
    // ③ 用服务端的 Key，那就用服务端的地址
    baseUrl = serverBase.replace(/\/+$/, '')
    baseUrlSource = 'server'
    provider = ''
  } else {
    provider = inferProvider(model)
    baseUrl = presetBase(provider)
    baseUrlSource = baseUrl ? 'inferred' : 'missing'
  }

  // 凭证来源，便于 UI 提示「你在用自己填的 Key」还是「服务端预置」
  const source = clientKey ? 'client'
    : (pick(process.env.LLM_API_KEY, process.env.ARK_API_KEY) ? 'server' : 'none')
  return { baseUrl, apiKey, model, source, baseUrlSource, provider }
}

/** 是否已配置大模型（未配置时上层进入 demo 模式） */
export function isLlmConfigured(creds) {
  const s = llmSettings(creds)
  return Boolean(s.apiKey && s.model)
}

/** 只返回不含密钥的可公开信息 */
export function describeLlm(creds) {
  const s = llmSettings(creds)
  const name = (BY_ID[s.provider] && BY_ID[s.provider].name) || ''
  return { configured: Boolean(s.apiKey && s.model), model: s.model || null,
           baseUrl: s.baseUrl || null, baseUrlSource: s.baseUrlSource,
           provider: s.provider, providerName: name, source: s.source }
}

/** 把原始英文报错翻成能照着做的话 */
function explainHttp(code, baseUrl, detail) {
  const where = `${baseUrl}/chat/completions`
  const raw = String(detail || '').trim()
  const short = raw.slice(0, 300)

  if (code === 401) {
    return '认证失败（HTTP 401）。两种可能：\n'
      + '  ① API Key 填错了或不完整；\n'
      + `  ② Key 是别家的，但 Base URL 指向了 ${baseUrl}。\n`
      + '请到「⚙ 设置」核对：先选对服务商（或手填 Base URL），再填 Key。\n'
      + `服务端原话：${short}`
  }
  if (code === 403) {
    return `被拒绝（HTTP 403）：Key 没有调用该模型的权限，或模型未开通。\n  当前地址：${where}\n服务端原话：${short}`
  }
  if (code === 404) {
    return `地址不存在（HTTP 404）：${where}\n`
      + 'Base URL 一般填到 /v1 这一层就够了，不要带 /chat/completions。\n'
      + '例如 DeepSeek 是 https://api.deepseek.com，OpenAI 是 https://api.openai.com/v1。\n'
      + `服务端原话：${short}`
  }
  if (code === 429) {
    return `请求太频繁或额度用尽（HTTP 429）。稍后再试，或检查账户余额。\n服务端原话：${short}`
  }
  if (code === 400) {
    return '服务端说请求有问题（HTTP 400）——最常见的原因是**模型名不对**。\n'
      + `  当前地址：${where}\n`
      + '  火山方舟要填推理接入点（ep-…），DeepSeek 是 deepseek-chat。\n'
      + `服务端原话：${short}`
  }
  if (code >= 500) return `服务端故障（HTTP ${code}），不是你的配置问题，稍后再试。${short}`
  return `大模型请求失败（HTTP ${code}，${where}）：${short}`
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
  if (!s.baseUrl) {
    throw new Error('不知道要把请求发去哪儿：Base URL 没填，而且从模型名「' + s.model + '」也认不出是哪家服务。\n'
      + '请打开「⚙ 设置」，在①里选一个服务商（会自动填好地址），或手动填 Base URL。')
  }

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
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`大模型请求超时（${(options.timeoutMs || 120000) / 1000}s）`)
    throw new Error(`连不上 ${s.baseUrl}（${(e && e.message) || e}）。\n检查：网络是否通、地址是否写对、有没有需要代理。`)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(explainHttp(res.status, s.baseUrl, text))
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
