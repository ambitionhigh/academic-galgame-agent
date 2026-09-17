// 检索适配器：为教学与出题提供**真实依据**。
//
// 依据来源按优先级：
//   ① 用户自己上传的教材（浏览器选文件 → 存本会话内存，不落盘）
//   ② 用户自己的 ima 知识库（凭证随请求传入）
//   ③ 项目内置 corpus/ 目录（开箱即用的示例教材）
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'

import * as imaIndex from './ima_index.js'

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

/** ① 用户上传的教材（本会话内存）
 *  按学科取用：「通用」（未指定学科）的教材对所有学科可用；
 *  指定了学科的教材**只**对该学科可用。若该学科下无任何可用教材，则如实返回空。 */
export function sessionCorpusRetrieve(query, subject, uploads = []) {
  const all = (uploads || []).filter((f) => f && typeof f.text === 'string' && f.text.trim())
  if (all.length === 0) {
    return { ok: false, source: 'upload', count: 0, items: [], error: '尚未上传教材' }
  }
  let pool = all
  if (subject) {
    pool = all.filter((f) => !f.subject || f.subject === subject)
    if (pool.length === 0) {
      return {
        ok: false, source: 'upload', count: 0, items: [],
        error: `该学科（${subject}）没有可用教材：你上传的文件都指定了别的学科，且没有「通用」教材`,
      }
    }
  }
  const docs = pool.map((f) => ({
    name: f.subject ? `${f.name}（${f.subject}）` : (f.name || '上传教材'),
    text: f.text,
  }))
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
export function imaCreds(creds = {}) {
  return {
    apiKey: creds.imaApiKey || process.env.IMA_API_KEY || '',
    clientId: creds.imaClientId || process.env.IMA_CLIENT_ID || '',
  }
}

/** 解析「学科 → 知识库ID」映射（字符串或对象都支持） */
export function parseKbMap(raw) {
  try { return typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}) } catch { return {} }
}

/** ima 开放接口 POST（走带限流退避的公共实现，避免一密就 200001） */
async function imaPost(path, body, creds = {}) {
  const { apiKey, clientId } = imaCreds(creds)
  return await imaIndex.imaPost(path, body, apiKey, clientId)
}

/**
 * 在 ima 知识库里检索**正文**。
 *
 * 做法：先用索引器把库里还没下载的书下下来、抽出正文存到本地，
 * 再在本地做真正的全文检索 —— 因为 ima 自己的 search_knowledge 只匹配标题，
 * 书里的内容它搜不到，而且它给的是 PDF/EPUB 原始文件，当文本读是乱码。
 *
 * 未配置 / 没绑定知识库时返回 null（交给上层回落到内置语料）。
 */
async function imaRetrieve(query, subject, creds = {}) {
  const { apiKey, clientId } = imaCreds(creds)
  const map = parseKbMap(creds.imaKbMap || process.env.IMA_KB_MAP || '')
  const kb = map[subject] || Object.values(map)[0] || creds.imaKb || process.env.IMA_KB || ''
  if (!apiKey || !clientId || !kb) return null

  const focus = `${query || ''} ${subject || ''}`
  let stats
  try {
    stats = await imaIndex.buildIndex(kb, apiKey, clientId, { focus })
  } catch (e) {
    return { ok: false, apiOk: false, source: 'ima', items: [],
             error: `ima 接口报错：${(e && e.message) || e}` }
  }

  const r = imaIndex.searchIndex(kb, query, subject)
  const base = { source: 'ima', indexed: r.indexed, total: r.total, kbId: kb, indexStats: stats }

  if (r.ok) {
    return { ...base, ok: true, apiOk: true, count: r.items.length, items: r.items,
             via: '本地全文检索（已下载并解析你的书）' }
  }

  // 没命中 —— 如实说明卡在哪一步，便于用户自己判断
  let why
  if (!r.indexed && !r.total) why = '这个知识库里没列出任何文件'
  else if (!r.indexed) {
    why = `知识库里有 ${r.total} 个文件，但一个都没能解析出正文`
      + `（${(stats.notes || []).join('；') || '见索引状态'}）`
  } else why = `已在 ${r.indexed} 本书里全文检索，没有和「${query || subject || ''}」相关的内容`

  return { ...base, ok: false, apiOk: true, count: 0, items: [], error: why,
           hint: `知识库状态：已解析 ${r.indexed} 本 / 共 ${r.total} 个文件` }
}

/**
 * 统一检索入口（按优先级回落）。
 *
 * ⚠️ 一个刻意的行为：**配了 ima 时，绝不静默换成项目内置的示例语料**。
 * 以前会默默回落，于是用户以为老师在讲自己的书，其实讲的是仓库里的两篇示例 ——
 * 这正是「抓不到我放在知识库里的书」这个感受的来源之一。
 * 现在回落时会带上 note 说明「这不是你的资料」，让模型如实告诉用户。
 *
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

  // ② ima 知识库（配了才走，且不再无声回落）
  if (imaEnabled(creds)) {
    let viaIma = null
    try {
      viaIma = await imaRetrieve(query, subject, creds)
    } catch (e) {
      viaIma = { ok: false, apiOk: false, source: 'ima', items: [], error: String((e && e.message) || e) }
    }
    if (viaIma) {
      if (viaIma.ok) return viaIma
      const local = localCorpusRetrieve(query, subject)
      if (local.ok) {
        local.fallbackFrom = 'ima'
        local.note = '⚠️ 以下内容**不是**你的资料，而是项目内置的示例语料。'
          + `你的 ima 知识库没给出结果，原因：${viaIma.error || '该知识库里没有匹配内容'}。`
          + '请如实告诉用户这一点，不要假装引用了他的书。'
        return local
      }
      viaIma.hint = `${viaIma.hint || ''}；内置示例语料里也没有相关内容`
      return viaIma
    }
  }

  // ③ 没配 ima：用内置语料
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

/**
 * 测一次 ima：列出知识库 + 真正开始建索引（给 UI 的「测试连接」用）。
 *
 * 判定标准：能列出知识库就算连通。如果绑了知识库，顺带报告「已解析几本 / 共几个文件」，
 * 以及哪些文件读不了、为什么 —— 这些信息对排查「抓不到我的书」最关键。
 */
export async function testIma(creds = {}) {
  if (!imaEnabled(creds)) {
    return { ok: false, error: '未填写 ima API Key 或 Client ID' }
  }
  const kbs = await listKnowledgeBases(creds)
  if (!kbs.ok) return { ok: false, error: kbs.error || '拉不到知识库列表' }

  const out = { ok: true, kbs: kbs.items.length, names: kbs.items.slice(0, 12).map((k) => k.name) }
  const { apiKey, clientId } = imaCreds(creds)
  const map = parseKbMap(creds.imaKbMap || process.env.IMA_KB_MAP || '')
  const kb = Object.values(map)[0] || ''
  if (!kb) {
    out.note = `连接正常，列出 ${kbs.items.length} 个知识库。还没给学科绑定知识库 —— 绑定后我才能读里面的书。`
    return out
  }
  try {
    await imaIndex.buildIndex(kb, apiKey, clientId, { budgetSeconds: 25 })
  } catch (e) {
    out.note = `连接正常，但建索引失败：${(e && e.message) || e}`
    return out
  }
  const st = imaIndex.indexStatus(kb)
  const pending = st.listed - st.ready - st.unreadable
  out.index = st
  out.note = `连接正常。知识库共 ${st.listed} 个文件，已解析 ${st.ready} 本（${(st.chars / 10000).toFixed(1)} 万字）`
    + (pending > 0 ? `，还有 ${pending} 个待解析（下次提问会继续）` : '')
    + (st.unreadable ? `；有 ${st.unreadable} 个读不了（多为扫描版/图片版/网页笔记），详见 index.unreadable_detail` : '')
  return out
}
