// ima 知识库索引器：把库里的**书**下载下来、抽出正文、缓存在本地，然后真正在里面检索。
//
// 这是 python/agent/ima_index.py 的 JS 移植版。为什么必须这么做（实测结论，别推翻）：
//
//   1. `search_knowledge` **只匹配标题，不搜正文** —— `highlight_content` 恒为空。
//      查「睡眠」能命中《斯坦福高效睡眠法》（标题里有），但查「复利」「注意力」一律 0 条，
//      哪怕书里到处都是。
//   2. `get_media_info` 给的是**原始文件**的下载地址。你放的是 PDF/EPUB，
//      拿到手就是几十 MB 二进制；当文本读只会得到 `%PDF-1.6 %äüöß...`。
//   3. 接口有限流：请求一密就返回 `code=200001 请求频率超限`。
//      必须串行 + 退避重试 + 持久缓存，否则每次提问都在重新踩雷。
//   4. `media_type=99` 是**文件夹**，里面的文件要带 `folder_id` 递归进去列。
//
// 所以做法是：列出 → 下载 → 抽正文 → 落盘缓存 → 在本地做真正的全文检索。
// 第一次用某个知识库会慢（要下书），之后是秒回。

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractTextAsync } from './textract.js'

const IMA_HOST = 'ima.qq.com'
const IMA_BASE = '/openapi/wiki/v1'

export const MAX_SECTIONS = 4
export const MAX_CHARS_PER_SECTION = 1600
const MAX_DOC_TEXT_CHARS = 400000
const MAX_DOC_BYTES = 120 * 1024 * 1024
const MAX_CACHED_DOCS = 120
const LIST_TTL_SECONDS = 6 * 3600
export const DEFAULT_BUILD_BUDGET = Number(process.env.IMA_INDEX_BUDGET || 75)

// ima 的 MediaType：能不能抽出正文，看类型就能判断，**不用先下载**。
// 一个知识库里往往几百个文件，大半是图片和网页快照 —— 先下再判断会白等好几分钟。
const TEXT_MEDIA_TYPES = {
  1: 'PDF', 3: 'Word', 4: 'PPT', 5: 'Excel/CSV', 7: 'Markdown', 13: 'TXT', 14: 'Xmind', 21: 'EPUB',
}
const SKIP_MEDIA_TYPES = {
  9: '图片（没有文字层）',
  15: '录音（转文字请在 ima 里做）',
  16: '视频',
}
const WEB_MEDIA_TYPES = { 2: '网页', 6: '公众号文章', 11: 'ima 笔记', 12: 'AI 会话' }

export class ImaError extends Error {
  constructor(msg, code) { super(msg); this.name = 'ImaError'; this.code = code }
}

/* ══════════════════════════════════════════════════════════════════
   基础请求（带限流退避）
   ══════════════════════════════════════════════════════════════════ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function imaPost(path, body, apiKey, clientId, opts = {}) {
  const tries = opts.tries || 4
  const timeout = opts.timeout || 30000
  let last = null
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    let j
    try {
      const res = await fetch(`https://${IMA_HOST}${IMA_BASE}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'ima-openapi-clientid': clientId,
          'ima-openapi-apikey': apiKey,
        },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal,
      })
      j = await res.json()
    } catch (e) {
      clearTimeout(timer)
      last = new ImaError(`连不上 ima（${(e && e.message) || e}）`)
      await sleep(1500 * (i + 1))
      continue
    } finally {
      clearTimeout(timer)
    }

    const code = j.code
    if (code === 0 || code === undefined || j.retcode === 0) return j
    const msg = j.msg || j.errmsg || `code ${code}`
    last = new ImaError(msg, code)
    if (code === 200001 || String(msg).includes('频率') || String(msg).includes('超限')) {
      await sleep(2000 * (i + 1))          // 限流：明显退避
      continue
    }
    if (code === 110010 || code === 110021) { await sleep(2000 * (i + 1)); continue }
    break
  }
  throw last || new ImaError('ima 请求失败')
}

async function download(url, maxBytes = MAX_DOC_BYTES, timeout = 180000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'academic-galgame/1.0' }, signal: ctrl.signal })
    if (!res.ok) throw new ImaError(`HTTP ${res.status}`)
    const len = Number(res.headers.get('content-length') || 0)
    if (len && len > maxBytes) throw new ImaError(`文件 ${Math.floor(len / 1048576)} MB 超过上限，跳过`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) throw new ImaError(`文件超过 ${Math.floor(maxBytes / 1048576)} MB，跳过`)
    return buf
  } finally {
    clearTimeout(timer)
  }
}

/* ══════════════════════════════════════════════════════════════════
   缓存
   ══════════════════════════════════════════════════════════════════ */

const HERE = dirname(fileURLToPath(import.meta.url))

export function cacheRoot() {
  if (process.env.GALGAME_IMA_CACHE) return process.env.GALGAME_IMA_CACHE
  if (process.env.GALGAME_HOME) return join(process.env.GALGAME_HOME, 'ima-cache')
  // 默认放在项目根旁边（和 .env 同级），方便用户自己看和删
  return join(HERE, '..', '..', '.ima-cache')
}

const kbKey = (kbId) => createHash('sha1').update(kbId, 'utf8').digest('hex').slice(0, 16)
const metaPath = (kbId) => join(cacheRoot(), kbKey(kbId), 'meta.json')

export function loadMeta(kbId) {
  try {
    return JSON.parse(readFileSync(metaPath(kbId), 'utf8'))
  } catch {
    return { kb_id: kbId, fetched_at: 0, docs: [] }
  }
}

export function saveMeta(kbId, meta) {
  const p = metaPath(kbId)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(meta, null, 1), 'utf8')
  renameSync(tmp, p)
}

function docTextPath(kbId, mediaId) {
  const h = createHash('sha1').update(mediaId, 'utf8').digest('hex').slice(0, 20)
  return join(cacheRoot(), kbKey(kbId), h + '.txt')
}

function readDocText(doc) {
  if (!doc.file) return ''
  try { return readFileSync(doc.file, 'utf8') } catch { return '' }
}

/* ══════════════════════════════════════════════════════════════════
   枚举（含文件夹递归）
   ══════════════════════════════════════════════════════════════════ */

export async function listDocuments(kbId, apiKey, clientId, maxDocs = 300) {
  const out = []
  const seenFolders = new Set()

  async function walk(folderId, depth) {
    if (depth > 3 || out.length >= maxDocs) return
    if (folderId && seenFolders.has(folderId)) return
    if (folderId) seenFolders.add(folderId)
    let cursor = ''
    let guard = 0
    for (;;) {
      const body = { knowledge_base_id: kbId, cursor, limit: 50 }
      if (folderId) body.folder_id = folderId
      const j = await imaPost('/get_knowledge_list', body, apiKey, clientId)
      const data = j.data || {}
      const items = data.knowledge_list || data.list || []
      for (const it of items) {
        const mid = it.media_id || ''
        const isFolder = String(mid).startsWith('folder_') || it.media_type === 99 || !mid
        if (isFolder) {
          const fid = it.folder_id || mid
          if (fid) await walk(fid, depth + 1)
        } else {
          out.push({ media_id: mid, title: it.title || '(无标题)', media_type: it.media_type })
          if (out.length >= maxDocs) return
        }
      }
      cursor = data.next_cursor || ''
      if (!cursor || data.is_end) break
      if (++guard > 20) break
      await sleep(300)                    // 放慢，别把接口打限流
    }
  }

  await walk('', 0)
  return out
}

/* ══════════════════════════════════════════════════════════════════
   建索引
   ══════════════════════════════════════════════════════════════════ */

function titleTokens(s) {
  return new Set(String(s || '').toLowerCase().match(/[\u4e00-\u9fa5]{2,}|[a-z0-9]{2,}/g) || [])
}

// Node 是单线程的，但 async 会交错 —— 用一条串行链保证「同一时刻只有一次建索引」
let chain = Promise.resolve()
function serialize(fn) {
  const p = chain.then(fn, fn)
  chain = p.then(() => {}, () => {})
  return p
}

/**
 * 把知识库里还没索引的文档补上。有预算上限，剩下的下次继续（都缓存在本地，不会白干）。
 */
export function buildIndex(kbId, apiKey, clientId, opts = {}) {
  return serialize(() => buildIndexInner(kbId, apiKey, clientId, opts))
}

async function buildIndexInner(kbId, apiKey, clientId, opts) {
  const budget = opts.budgetSeconds === undefined ? DEFAULT_BUILD_BUDGET : opts.budgetSeconds
  const focus = opts.focus || ''
  const reset = Boolean(opts.reset)
  const forceRelists = Boolean(opts.forceRelists)
  const tEnd = Date.now() + Math.max(0, budget * 1000)

  const stats = { listed: 0, indexed: 0, skipped: 0, failed: 0, notes: [] }

  const meta = loadMeta(kbId)
  if (reset) {
    meta.fetched_at = 0
    for (const d of meta.docs || []) { delete d.status; delete d.note }
  }
  const stale = (Date.now() / 1000 - (meta.fetched_at || 0)) > LIST_TTL_SECONDS
  if (stale || forceRelists || !(meta.docs || []).length) {
    const docs = await listDocuments(kbId, apiKey, clientId)
    if (!docs.length && (meta.docs || []).length) {
      // 列失败就沿用旧的
    } else {
      meta.docs = docs
      meta.fetched_at = Date.now() / 1000
    }
    stats.listed = docs.length
  }
  const docs = meta.docs || []

  // 先索引「标题跟关注点沾边」的，再索引其余 —— 让人第一次提问就有收获
  const focusTokens = titleTokens(focus)
  let pending = docs.filter((d) => !['ok', 'unsupported', 'toobig'].includes(d.status))
  if (focusTokens.size) {
    pending = pending.slice().sort((a, b) =>
      intersect(b.title, focusTokens) - intersect(a.title, focusTokens))
  }

  // 先按类型把「注定读不了」的挑出来标记掉 —— 不下载、不浪费时间
  const todo = []
  for (const d of pending) {
    const mt = d.media_type
    if (SKIP_MEDIA_TYPES[mt]) {
      d.status = 'unsupported'; d.note = SKIP_MEDIA_TYPES[mt]; stats.skipped++
      continue
    }
    if (WEB_MEDIA_TYPES[mt]) {
      d.status = 'unsupported'
      d.note = `${WEB_MEDIA_TYPES[mt]}：正文要登录 ima 才看得到，抽不出来`
      stats.skipped++
      continue
    }
    todo.push(d)
  }
  // 未知类型排在能识别的类型后面（多半是些没用的快照）
  todo.sort((a, b) => (TEXT_MEDIA_TYPES[a.media_type] ? 0 : 1) - (TEXT_MEDIA_TYPES[b.media_type] ? 0 : 1))

  for (const doc of todo) {
    if (Date.now() > tEnd) break
    if (stats.indexed >= MAX_CACHED_DOCS) break

    let url = ''
    try {
      const m = await imaPost('/get_media_info', { media_id: doc.media_id }, apiKey, clientId)
      url = m.data && m.data.url_info && m.data.url_info.url
      if (!url) {
        doc.status = 'unsupported'; doc.note = m.msg || '拿不到下载地址'; stats.skipped++
        continue
      }
    } catch (e) {
      doc.status = 'unsupported'; doc.note = String(e.message || e); stats.skipped++
      continue
    }

    let raw
    try {
      raw = await download(url)
    } catch (e) {
      const msg = String(e.message || e)
      doc.status = msg.includes('超过') ? 'toobig' : 'failed'
      doc.note = msg
      stats.failed++
      continue
    }

    const r = await extractTextAsync(raw, doc.title || '')
    if (!r.text) {
      doc.status = 'unsupported'
      doc.note = r.note || '抽不到正文'
      stats.notes.push(`${doc.title || ''}：${doc.note}`)
      stats.skipped++
      continue
    }

    const text = r.text.slice(0, MAX_DOC_TEXT_CHARS)
    const path = docTextPath(kbId, doc.media_id)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text, 'utf8')
    Object.assign(doc, { status: 'ok', file: path, chars: text.length, kind: r.kind, note: '' })
    stats.indexed++
    await sleep(250)                     // 别把接口打限流
  }

  saveMeta(kbId, meta)
  stats.total_docs = docs.length
  stats.ready = docs.filter((d) => d.status === 'ok').length
  stats.pending = docs.filter((d) => !['ok', 'unsupported', 'toobig'].includes(d.status)).length
  return stats
}

function intersect(title, tokens) {
  const t = titleTokens(title)
  let n = 0
  for (const x of tokens) if (t.has(x)) n++
  return n
}

/* ══════════════════════════════════════════════════════════════════
   在索引里检索
   ══════════════════════════════════════════════════════════════════ */

// 这些字几乎每段都有，给它们打分等于给所有段落一起加分，反而淹没了真正的关键词
const STOP_CHARS = new Set('的了是在和有就不我你他她它这那也都与及而或但很太更最一二三四五六七八九十个上下来去说想会能要把被为对从到于以之其所'.split(''))
const STOP_BIGRAMS = new Set(['我们', '他们', '什么', '可以', '这个', '那个', '因为', '所以', '就是',
  '不是', '没有', '一个', '自己', '时候', '已经', '如果', '这些', '那些'])

/**
 * 从查询里提取真正有区分度的检索词。
 * 关键是**别让「的、是、在」这类字参与打分** —— 否则随便一段都能得高分，返回的就不相关了。
 */
export function queryTerms(text) {
  const s = String(text || '').toLowerCase()
  const strong = new Set(s.match(/[a-z0-9]{2,}/g) || [])
  const cjk = s.match(/[\u4e00-\u9fa5]/g) || []
  for (let i = 0; i + 1 < cjk.length; i++) {
    const bg = cjk[i] + cjk[i + 1]
    if (!STOP_BIGRAMS.has(bg)) strong.add(bg)
  }
  const weak = new Set(cjk.filter((c) => !STOP_CHARS.has(c)))
  return { strong, weak }
}

function splitChunks(text, size = 900, overlap = 150) {
  const t = text || ''
  if (t.length <= size) return t.trim() ? [t] : []
  const out = []
  const step = Math.max(1, size - overlap)
  for (let i = 0; i < t.length; i += step) {
    const chunk = t.slice(i, i + size)
    if (chunk.trim()) out.push(chunk)
    if (i + size >= t.length) break
  }
  return out
}

export function searchIndex(kbId, query, subject = '', limit = MAX_SECTIONS) {
  const meta = loadMeta(kbId)
  const docs = (meta.docs || []).filter((d) => d.status === 'ok')
  const { strong, weak } = queryTerms(`${query || ''} ${subject || ''}`)
  if (!docs.length || (!strong.size && !weak.size)) {
    return { ok: false, items: [], indexed: docs.length, total: (meta.docs || []).length }
  }

  const strongArr = [...strong]
  const weakArr = [...weak]
  const scored = []
  for (const doc of docs) {
    const text = readDocText(doc)
    if (!text) continue
    const title = doc.title || ''
    const t = queryTerms(title)
    let titleBonus = 0
    for (const x of strong) if (t.strong.has(x)) titleBonus += 60
    for (const x of weak) if (t.weak.has(x)) titleBonus += 8

    const chunks = splitChunks(text)
    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx]
      const hay = chunk.toLowerCase()
      const hitStrong = strongArr.filter((x) => hay.includes(x))
      if (!hitStrong.length && !weakArr.some((x) => hay.includes(x))) continue
      const hitWeak = weakArr.filter((x) => hay.includes(x))
      // 长词（双字/英文）权重远高于单字；单个单字命中基本没有区分度
      let score = 6 * hitStrong.length + 0.4 * hitWeak.length
      if (hitStrong.length >= 2) score += 4
      if (score <= 1.2) continue
      scored.push({ score: score + titleBonus, title, source: `ima·${title}`,
                    content: chunk.slice(0, MAX_CHARS_PER_SECTION),
                    matched: hitStrong.slice().sort().slice(0, 6) })
    }
  }
  scored.sort((a, b) => b.score - a.score)

  // 同一本书最多出一段，保证覆盖多本书
  const items = []
  const seen = new Set()
  for (const s of scored) {
    if (seen.has(s.title)) continue
    seen.add(s.title)
    items.push({ title: s.title, source: s.source, content: s.content, matched: s.matched })
    if (items.length >= limit) break
  }
  return { ok: items.length > 0, items, indexed: docs.length,
           total: (meta.docs || []).length, terms: strongArr.sort().slice(0, 8) }
}

/** 给 UI / 自检用：这个知识库索引到哪一步了。 */
export function indexStatus(kbId) {
  const meta = loadMeta(kbId)
  const docs = meta.docs || []
  const ok = docs.filter((d) => d.status === 'ok')
  const bad = docs.filter((d) => ['unsupported', 'toobig', 'failed'].includes(d.status))
  return {
    kb_id: kbId,
    listed: docs.length,
    ready: ok.length,
    unreadable: bad.length,
    chars: ok.reduce((n, d) => n + (d.chars || 0), 0),
    unreadable_detail: bad.slice(0, 10).map((d) => ({ title: d.title, why: d.note })),
    last_list: meta.fetched_at || 0,
    cache_dir: join(cacheRoot(), kbKey(kbId)),
  }
}
