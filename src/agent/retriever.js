// 检索适配器：为教学与出题提供**真实依据**。
//
// 依据来源按优先级：
//   ① 用户自己上传的教材（浏览器选文件 → 存本会话内存，不落盘）
//   ② 用户自己的 ima 知识库（凭证随请求传入）
//   ③ 项目内置 corpus/ 目录（开箱即用的示例教材）
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'

const CORPUS_DIR = resolve(process.env.GALGAME_CORPUS || join(process.cwd(), 'corpus'))
const MAX_SECTIONS = 3
const MAX_CHARS = 1200
const IMA_HOST = 'ima.qq.com'
const IMA_BASE = '/openapi/wiki/v1'

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

/** 按 Markdown 标题切成小节 */
function splitSections(text) {
  const lines = String(text || '').split(/\r?\n/)
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

/**
 * 在给定文档集合里检索。
 * @param {Array<{name:string, text:string}>} docs 文档集合
 * @param {string} query 查询
 * @param {string} subject 学科（一并参与打分）
 * @param {string} source 来源标签，用于返回值和 UI 提示
 */
function searchDocs(docs, query, subject, source) {
  const tokens = tokenize(`${query || ''} ${subject || ''}`)
  if (tokens.length === 0) return { ok: false, source, count: 0, items: [], error: '查询为空' }
  const scored = []
  for (const doc of docs) {
    for (const sec of splitSections(doc.text)) {
      const body = sec.body.join('\n').trim()
      if (!body) continue
      const hay = `${sec.title}\n${body}`.toLowerCase()
      let score = 0
      for (const t of tokens) if (hay.includes(t)) score += t.length >= 2 ? 2 : 1
      if (score > 0) scored.push({ score, title: sec.title, source: doc.name, content: body.slice(0, MAX_CHARS) })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const items = scored.slice(0, MAX_SECTIONS).map(({ title, source: src, content }) => ({ title, source: src, content }))
  return { ok: items.length > 0, source, count: items.length, items }
}

/** ① 用户上传的教材（本会话内存） */
export function sessionCorpusRetrieve(query, subject, uploads = []) {
  const docs = (uploads || [])
    .filter((f) => f && typeof f.text === 'string' && f.text.trim())
    .map((f) => ({ name: f.name || '上传教材', text: f.text }))
  if (docs.length === 0) return { ok: false, source: 'upload', count: 0, items: [], error: '尚未上传教材' }
  return searchDocs(docs, query, subject, 'upload')
}

/** ③ 项目内置 corpus/ 目录 */
export function localCorpusRetrieve(query, subject) {
  const files = collectFiles(CORPUS_DIR)
  if (files.length === 0) {
    return { ok: false, source: 'corpus', count: 0, items: [], error: `语料目录为空：${CORPUS_DIR}（可放入 .md/.txt 教材文件）` }
  }
  const docs = []
  for (const file of files) {
    try { docs.push({ name: file, text: readFileSync(file, 'utf8') }) } catch { /* 跳过读不了的文件 */ }
  }
  return searchDocs(docs, query, subject, 'corpus')
}

/* ══════════ ima 知识库 ══════════ */

/** 解析 ima 凭证（请求优先，环境变量兜底） */
function imaCreds(creds = {}) {
  return {
    apiKey: creds.imaApiKey || process.env.IMA_API_KEY || '',
    clientId: creds.imaClientId || process.env.IMA_CLIENT_ID || '',
  }
}

/** 解析「学科 → 知识库ID」映射（字符串或对象都支持） */
export function parseKbMap(raw) {
  try { return typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}) } catch { return {} }
}

/** ima 开放接口 POST */
async function imaPost(path, body, creds = {}) {
  const { apiKey, clientId } = imaCreds(creds)
  const res = await fetch(`https://${IMA_HOST}${IMA_BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'ima-openapi-clientid': clientId,
      'ima-openapi-apikey': apiKey,
    },
    body: JSON.stringify(body || {}),
  })
  return await res.json()
}

/** ② ima 知识库内检索；未配置或没有可用知识库时返回 null */
async function imaRetrieve(query, subject, creds = {}) {
  const { apiKey, clientId } = imaCreds(creds)
  const map = parseKbMap(creds.imaKbMap || process.env.IMA_KB_MAP || '')
  const kb = map[subject] || Object.values(map)[0] || creds.imaKb || process.env.IMA_KB || ''
  if (!apiKey || !clientId || !kb) return null

  const sj = await imaPost('/search_knowledge', { knowledge_base_id: kb, query: String(query || ''), limit: 6 }, creds)
  if (sj.code !== 0) return { ok: false, apiOk: false, source: 'ima', items: [], error: sj.msg }
  const hits = (sj.data && sj.data.info_list) || []
  const items = []
  for (const h of hits.slice(0, 2)) {
    const entry = { title: h.title, source: 'ima', content: '' }
    try {
      const mj = await imaPost('/get_media_info', { media_id: h.media_id }, creds)
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
 * 统一检索入口（按优先级回落）。
 * @param {string} query 查询词
 * @param {string} [subject] 学科
 * @param {object} [creds] 本次请求携带的凭证
 * @param {Array<{name:string,text:string}>} [uploads] 本会话上传的教材
 */
export async function retrieve(query, subject, creds = {}, uploads = []) {
  // ① 用户上传的教材优先
  if (uploads && uploads.length > 0) {
    const r = sessionCorpusRetrieve(query, subject, uploads)
    if (r.ok) return r
  }
  // ② ima 知识库
  try {
    const viaIma = await imaRetrieve(query, subject, creds)
    if (viaIma && viaIma.ok !== false) return viaIma
    if (viaIma && viaIma.ok === false && viaIma.apiOk === false) return viaIma // 接口报错，如实返回
  } catch { /* 回落 */ }
  // ③ 内置语料
  return localCorpusRetrieve(query, subject)
}

/** 该次请求是否会走 ima（供 UI 提示用） */
export function imaEnabled(creds = {}) {
  const { apiKey, clientId } = imaCreds(creds)
  return Boolean(apiKey && clientId)
}

/** 列出该凭证可用的 ima 知识库（名称 → ID），供设置面板「按名称选择」 */
export async function listKnowledgeBases(creds = {}) {
  const { apiKey, clientId } = imaCreds(creds)
  if (!apiKey || !clientId) return { ok: false, error: '未填写 ima API Key 或 Client ID' }
  try {
    // 主接口：我可添加的知识库列表（limit ≤ 50）
    // 兜底：知识库搜索（注意 limit 必须在 (0,20]，否则返回 code 51）
    let j = await imaPost('/get_addable_knowledge_base_list', { limit: 50 }, creds)
    if (j.code !== 0) j = await imaPost('/search_knowledge_base', { limit: 20 }, creds)
    if (j.code !== 0) return { ok: false, error: j.msg || `ima 返回 code ${j.code}` }

    const d = j.data || {}
    const raw = d.addable_knowledge_base_list || d.info_list || d.list ||
      d.knowledge_base_list || d.items || (Array.isArray(d) ? d : [])
    const items = []
    for (const it of raw) {
      const id = it.knowledge_base_id || it.kb_id || it.id || it.base_id || ''
      const name = it.name || it.title || it.knowledge_base_name || '(未命名)'
      if (id) items.push({ id, name })
    }
    return { ok: items.length > 0, items, raw: items.length ? undefined : JSON.stringify(j).slice(0, 500) }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 直接用给定凭证测一次 ima 检索（给 UI 的「测试连接」按钮用；不回落到本地语料）
 *  判定标准：接口能正常应答即算连通（命中 0 条只是该测试词没匹配到，不算失败）。 */
export async function testIma(creds = {}) {
  if (!imaEnabled(creds)) {
    return { ok: false, error: '未填写 ima API Key 或 Client ID' }
  }
  try {
    const r = await imaRetrieve('纳什均衡', undefined, creds)
    if (!r) return { ok: false, error: '未指定知识库：请先「拉取知识库列表」并给学科选择知识库' }
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
