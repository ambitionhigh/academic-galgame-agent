// 检索适配器：为教学与出题提供**真实依据**。
// 默认检索本地教材语料 corpus/；若配置了 ima 知识库凭证则优先使用 ima。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'

const CORPUS_DIR = resolve(process.env.GALGAME_CORPUS || join(process.cwd(), 'corpus'))
const MAX_SECTIONS = 3
const MAX_CHARS = 1200

/** 把文本切成检索用的 token（英文单词 + 中文单字与双字组合） */
function tokenize(text) {
  const s = String(text || '').toLowerCase()
  const tokens = new Set()
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) tokens.add(w)
  const cjk = s.match(/[\u4e00-\u9fa5]/g) || []
  for (const ch of cjk) tokens.add(ch)
  for (let i = 0; i + 1 < cjk.length; i++) tokens.add(cjk[i] + cjk[i + 1])
  return [...tokens]
}

/** 递归收集语料文件（限 3 层） */
function collectFiles(dir, depth = 0, out = []) {
  if (depth > 3 || !existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) collectFiles(full, depth + 1, out)
    else if (['.md', '.txt'].includes(extname(name).toLowerCase())) out.push(full)
  }
  return out
}

/** 按 Markdown 标题切成小节 */
function splitSections(text) {
  const lines = text.split(/\r?\n/)
  const sections = []
  let current = { title: '正文', body: [] }
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) {
      if (current.body.length) sections.push(current)
      current = { title: m[2].trim(), body: [] }
    } else {
      current.body.push(line)
    }
  }
  if (current.body.length) sections.push(current)
  return sections
}

/** 本地语料检索：按 token 命中数打分 */
export function localCorpusRetrieve(query, subject) {
  const files = collectFiles(CORPUS_DIR)
  if (files.length === 0) {
    return { ok: false, source: 'corpus', items: [], error: `语料目录为空：${CORPUS_DIR}（可放入 .md/.txt 教材文件）` }
  }
  const tokens = tokenize(`${query || ''} ${subject || ''}`)
  const scored = []
  for (const file of files) {
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    for (const sec of splitSections(text)) {
      const body = sec.body.join('\n').trim()
      if (!body) continue
      const hay = `${sec.title}\n${body}`.toLowerCase()
      let score = 0
      for (const t of tokens) if (hay.includes(t)) score += t.length >= 2 ? 2 : 1
      if (score > 0) scored.push({ score, title: sec.title, file, content: body.slice(0, MAX_CHARS) })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const items = scored.slice(0, MAX_SECTIONS).map(({ title, file, content }) => ({ title, source: file, content }))
  return { ok: items.length > 0, source: 'corpus', count: items.length, items }
}

/** 可选：ima 知识库检索（凭证优先取本次请求传入的 creds，其次环境变量） */
async function imaRetrieve(query, subject, creds = {}) {
  const apiKey = creds.imaApiKey || process.env.IMA_API_KEY || ''
  const clientId = creds.imaClientId || process.env.IMA_CLIENT_ID || ''
  const rawMap = creds.imaKbMap || process.env.IMA_KB_MAP || ''
  let map = {}
  try { map = typeof rawMap === 'string' ? JSON.parse(rawMap || '{}') : (rawMap || {}) } catch { map = {} }
  const kb = map[subject] || Object.values(map)[0] || creds.imaKb || process.env.IMA_KB || ''
  if (!apiKey || !clientId || !kb) return null

  const headers = { 'content-type': 'application/json', 'ima-openapi-clientid': clientId, 'ima-openapi-apikey': apiKey }
  const searchRes = await fetch('https://ima.qq.com/openapi/wiki/v1/search_knowledge', {
    method: 'POST',
    headers,
    body: JSON.stringify({ knowledge_base_id: kb, query: String(query || ''), limit: 6 }),
  })
  const sj = await searchRes.json()
  if (sj.code !== 0) return { ok: false, apiOk: false, source: 'ima', items: [], error: sj.msg }
  const hits = (sj.data && sj.data.info_list) || []
  const items = []
  for (const h of hits.slice(0, 2)) {
    const entry = { title: h.title, source: 'ima', content: '' }
    try {
      const mi = await fetch('https://ima.qq.com/openapi/wiki/v1/get_media_info', {
        method: 'POST',
        headers,
        body: JSON.stringify({ media_id: h.media_id }),
      })
      const mj = await mi.json()
      const url = mj && mj.data && mj.data.url_info && mj.data.url_info.url
      if (url) entry.content = (await (await fetch(url)).text()).slice(0, MAX_CHARS)
    } catch (e) {
      entry.error = String((e && e.message) || e)
    }
    items.push(entry)
  }
  return { ok: items.length > 0, apiOk: true, source: 'ima', count: hits.length, items }
}

/**
 * 统一检索入口：优先 ima（若本次请求带了凭证或服务端配了），否则本地语料。
 * @param {string} query 查询词
 * @param {string} [subject] 学科（用于选择知识库）
 * @param {{imaApiKey?:string, imaClientId?:string, imaKbMap?:string, imaKb?:string}} [creds] 本次请求携带的 ima 凭证
 */
export async function retrieve(query, subject, creds = {}) {
  try {
    const viaIma = await imaRetrieve(query, subject, creds)
    if (viaIma) return viaIma
  } catch (e) {
    // ima 失败则回落到本地语料
  }
  return localCorpusRetrieve(query, subject)
}

/** 该次请求是否会走 ima（供 UI 提示用） */
export function imaEnabled(creds = {}) {
  const apiKey = creds.imaApiKey || process.env.IMA_API_KEY || ''
  const clientId = creds.imaClientId || process.env.IMA_CLIENT_ID || ''
  return Boolean(apiKey && clientId)
}

/** 直接用给定凭证测一次 ima 检索（给 UI 的「测试连接」按钮用；不回落到本地语料）
 *  判定标准：接口能正常应答即算连通（命中 0 条只是该测试词没匹配到，不算失败）。 */
export async function testIma(creds = {}) {
  if (!imaEnabled(creds)) {
    return { ok: false, error: '未填写 ima API Key 或 Client ID' }
  }
  try {
    const r = await imaRetrieve('纳什均衡', undefined, creds)
    if (!r) return { ok: false, error: '未指定知识库：请填写「学科→知识库ID」映射（JSON）' }
    if (r.apiOk === false) return { ok: false, error: r.error || 'ima 接口返回错误' }
    return {
      ...r,
      ok: true,
      count: r.count || 0,
      note: (r.count || 0) > 0
        ? `连接正常，命中 ${r.count} 条`
        : '连接正常（该测试词暂无命中，可换关键词再试）',
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}
