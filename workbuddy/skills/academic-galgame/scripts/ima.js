// ima 知识库接入（Node 侧，零依赖）
//
// 凭证只存本地，绝不进仓库：
//   ${GALGAME_HOME:-~/.workbuddy/academic-galgame}/credentials.json
//   环境变量优先：IMA_API_KEY / IMA_CLIENT_ID / IMA_KB_MAP
//
// 【为什么检索要绕这么一圈】
// ima 自己的 search_knowledge **只匹配标题、不搜正文**（highlight_content 恒为空），
// 而 get_media_info 给的是 PDF/EPUB **原始文件**（当文本读是乱码）。
// 所以真正的做法是：列文件 → 下载 → 抽正文 → 存本机 → 本地全文检索
// —— 这就是同目录下 ima_index.js + textract.js 干的事。
//
// 接口（实测）：POST https://ima.qq.com/openapi/wiki/v1/...
//   get_addable_knowledge_base_list { limit }              → data.addable_knowledge_base_list[{ id, name }]
//   get_knowledge_list { knowledge_base_id, cursor, limit }→ data.knowledge_list[]（media_type=99 是文件夹）
//   get_media_info { media_id }                            → data.url_info.url（原始文件下载地址）
//   search_knowledge { knowledge_base_id, query, cursor }  → data.info_list[]（只匹配标题）
import { join } from 'node:path'
import { readCredsFile, saveCreds, mask, HOME, CRED_FILE } from './creds.js'
import * as imaIndex from './ima_index.js'

// 索引缓存放到技能自己的数据目录（下载的书 + 抽出的正文），别留在 skills/ 里
if (!process.env.GALGAME_IMA_CACHE) {
  process.env.GALGAME_IMA_CACHE = join(HOME, 'ima-cache')
}

const HOST = 'ima.qq.com'
const BASE = '/openapi/wiki/v1'
const MAX_CHARS = 1200
const MAX_SECTIONS = 3

export { HOME, CRED_FILE, saveCreds }

/* ══════════ 凭证 ══════════ */

/** 生效凭证：环境变量 > 本地文件 */
export function loadCreds() {
  const f = readCredsFile()
  let kbMap = f.kbMap || {}
  if (process.env.IMA_KB_MAP) {
    try { kbMap = JSON.parse(process.env.IMA_KB_MAP) } catch { /* 用文件里的 */ }
  }
  return {
    imaApiKey: process.env.IMA_API_KEY || f.imaApiKey || '',
    imaClientId: process.env.IMA_CLIENT_ID || f.imaClientId || '',
    kbMap,
  }
}

export function credsStatus() {
  const c = loadCreds()
  return {
    ok: true,
    file: CRED_FILE,
    configured: Boolean(c.imaApiKey && c.imaClientId),
    imaApiKey: mask(c.imaApiKey),
    imaClientId: mask(c.imaClientId),
    fromEnv: Boolean(process.env.IMA_API_KEY || process.env.IMA_CLIENT_ID),
    kbMap: c.kbMap,
    boundSubjects: Object.keys(c.kbMap),
  }
}

/* ══════════ 接口调用 ══════════ */

async function imaPost(path, body, creds) {
  const res = await fetch(`https://${HOST}${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'ima-openapi-clientid': creds.imaClientId,
      'ima-openapi-apikey': creds.imaApiKey,
    },
    body: JSON.stringify(body || {}),
  })
  return await res.json()
}

function requireCreds(creds) {
  if (!creds.imaApiKey || !creds.imaClientId) {
    throw new Error(`ima 未配置：先运行 ima config --key <API Key> --client-id <Client ID>（或设置环境变量 IMA_API_KEY / IMA_CLIENT_ID）`)
  }
}

/** 列出可用的知识库（名称 → ID） */
export async function listKbs() {
  const creds = loadCreds()
  requireCreds(creds)
  // 主接口可传 limit ≤ 50；兜底接口 limit 必须 ≤ 20
  let j = await imaPost('/get_addable_knowledge_base_list', { limit: 50 }, creds)
  if (j.code !== 0) j = await imaPost('/search_knowledge_base', { limit: 20 }, creds)
  if (j.code !== 0) throw new Error(`ima 返回 code ${j.code}：${j.msg || ''}`)

  const d = j.data || {}
  const raw = d.addable_knowledge_base_list || d.info_list || d.list || d.knowledge_base_items || d.items || (Array.isArray(d) ? d : [])
  const items = []
  for (const it of raw) {
    const id = it.knowledge_base_id || it.kb_id || it.id || it.base_id || ''
    const name = it.name || it.title || it.knowledge_base_name || '(未命名)'
    if (id) items.push({ id, name })
  }
  return { ok: items.length > 0, count: items.length, items }
}

/** 按名称或 ID 找知识库 */
export async function resolveKb(nameOrId) {
  const { items } = await listKbs()
  const hit = items.find((x) => x.id === nameOrId || x.name === nameOrId)
  if (!hit) {
    throw new Error(`没找到知识库「${nameOrId}」。可用：${items.map((x) => x.name).join(' / ') || '(空)'}`)
  }
  return hit
}

/* ══════════ 检索 ══════════ */

/**
 * 在该学科绑定的 ima 知识库里检索真实片段。
 *
 * 做法：先把库里的书下载下来、抽出正文存到本地（索引），再在本地做全文检索 ——
 * 因为 ima 自己的 search_knowledge 只匹配书名、拿不到书里的内容，
 * 而 get_media_info 给的是 PDF/EPUB 原始文件，当文本读是乱码。
 *
 * 未配置 / 未绑定 → 返回 null（交给上层回落到本地教材库）
 */
export async function retrieveIma(query, subject) {
  const creds = loadCreds()
  if (!creds.imaApiKey || !creds.imaClientId) return null

  const kbId = creds.kbMap[subject] || Object.values(creds.kbMap)[0] || ''
  if (!kbId) return null

  const focus = `${query || ''} ${subject || ''}`
  let stats
  try {
    stats = await imaIndex.buildIndex(kbId, creds.imaApiKey, creds.imaClientId, { focus })
  } catch (e) {
    return { ok: false, source: 'ima', items: [], error: `ima 接口报错：${(e && e.message) || e}` }
  }

  const r = imaIndex.searchIndex(kbId, query, subject)
  const base = { source: 'ima', subject: subject || '', indexed: r.indexed, total: r.total, kbId }
  if (r.ok) {
    return { ...base, ok: true, count: r.items.length, items: r.items,
             via: '本地全文检索（已下载并解析你的书）' }
  }

  let why
  if (!r.indexed && !r.total) why = '这个知识库里没列出任何文件'
  else if (!r.indexed) {
    why = `知识库里有 ${r.total} 个文件，但一个都没能解析出正文`
      + `（${(stats.notes || []).join('；') || '见索引状态'}）`
  } else why = `已在 ${r.indexed} 本书里全文检索，没有和「${query || subject || ''}」相关的内容`
  return { ...base, ok: false, count: 0, items: [], error: why,
           hint: `知识库状态：已解析 ${r.indexed} 本 / 共 ${r.total} 个文件` }
}

/** 建/补索引（给 `ima index` 命令用）。第一次慢，之后走缓存。 */
export async function indexKnowledgeBase(opts = {}) {
  const creds = loadCreds()
  if (!creds.imaApiKey || !creds.imaClientId) {
    return { ok: false, error: '未配置 ima 凭证：先运行 ima config --key <API Key> --client-id <Client ID>' }
  }
  const kbId = (opts.subject && creds.kbMap[opts.subject]) || Object.values(creds.kbMap)[0] || ''
  if (!kbId) return { ok: false, error: '还没有绑定知识库：先 ima add-subject --kb "<知识库名>"' }

  const stats = await imaIndex.buildIndex(kbId, creds.imaApiKey, creds.imaClientId, {
    budgetSeconds: opts.budget || 300,
    focus: opts.focus || '',
    reset: Boolean(opts.reset),
    forceRelists: Boolean(opts.reset),
  })
  const st = imaIndex.indexStatus(kbId)
  const pending = Math.max(0, st.listed - st.ready - st.unreadable)
  return {
    ok: true, stats, index: st,
    note: `共 ${st.listed} 个文件，已解析 ${st.ready} 本（${(st.chars / 10000).toFixed(1)} 万字）`
      + (pending > 0 ? `，还有 ${pending} 个待解析（再跑一次继续）` : '')
      + (st.unreadable ? `；${st.unreadable} 个读不了（扫描版/图片版/网页笔记）` : ''),
  }
}
