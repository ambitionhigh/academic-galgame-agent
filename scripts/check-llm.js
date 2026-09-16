// 大模型体检脚本：不启动 Web 服务，直接验证「Key + 模型 ID + Base URL」能否调通。
// 运行：npm run check:llm   （旧脚本名 check:ark 仍可用）
import { loadEnv } from '../src/server/env.js'
import { llmSettings, isLlmConfigured, llmChat } from '../src/agent/llm.js'

loadEnv()

const s = llmSettings()
const mask = (v) => (v ? `${v.slice(0, 6)}…${v.slice(-4)}（长度 ${v.length}）` : '(空)')

console.log('\n大模型配置体检\n')
console.log('  LLM_BASE_URL :', s.baseUrl)
console.log('  LLM_MODEL    :', s.model || '(空)')
console.log('  LLM_API_KEY  :', mask(s.apiKey))
console.log('')

if (!isLlmConfigured()) {
  console.error('✗ 未配置完整：需要在项目根目录的 .env 里同时填好 LLM_API_KEY 和 LLM_MODEL。')
  console.error('  提示：先 `Copy-Item .env.example .env`，再编辑 .env。\n')
  process.exit(1)
}

console.log(`  正在调用 ${s.baseUrl}（约 5~30 秒）…\n`)

try {
  const r = await llmChat(
    [{ role: 'user', content: '只回复两个字：收到' }],
    { temperature: 0, timeoutMs: 30000 },
  )
  console.log('✓ 调用成功！模型返回：', JSON.stringify(r.content))
  console.log('  说明 Key、模型 ID、Base URL、网络都正常——重启 Web 服务即可切换到真模型。\n')
} catch (err) {
  const msg = String((err && err.message) || err)
  console.error('✗ 调用失败：', msg, '\n')
  console.error('  常见原因对照：')
  console.error('   · 401 / AuthenticationError / invalid api key  → API Key 错、没复制全，或 .env 没生效')
  console.error('   · 404 / model not found / InvalidEndpoint     → LLM_MODEL 写错，或该模型未开通')
  console.error('   · 403 / AccessDenied / 未实名                 → 账号未实名认证，或未开通该模型/服务')
  console.error('   · 429 / RateLimit / quota                     → 触发限流或额度用尽，稍后重试或充值')
  console.error('   · ECONNRESET / timeout / fetch failed         → 网络或代理问题，检查能否访问该 Base URL')
  console.error('   · LLM_NOT_CONFIGURED                          → .env 没被读到（确认文件在项目根目录、名为 .env）')
  console.error('')
  console.error('  提示：Base URL 填错是最常见的原因之一。')
  console.error('   · 火山方舟：https://ark.cn-beijing.volces.com/api/v3 ，模型形如 ep-xxxx')
  console.error('   · DeepSeek：https://api.deepseek.com ，模型 deepseek-chat\n')
  process.exit(1)
}
