// 零依赖 HTTP 服务：伺服 UI 静态资源 + 提供 /api/* 接口。
//
// 【BYOK 自带密钥 + 多用户隔离】
//  · 每位访客一个会话（cookie `gal_sid`）→ 游戏进度互不干扰，服务端不落盘
//  · 模型/知识库凭证由**浏览器**保存（localStorage），每次请求通过 HTTP 头带上：
//      x-ark-key / x-ark-model / x-ark-base
//      x-ima-key / x-ima-client-id / x-ima-kb-map
//    → 服务端**不存储任何用户凭证**，公开部署时可完全不配 Key
//  · 若服务端自己配了 ARK_*/IMA_* 环境变量，则作为缺省值兜底（适合自托管给自己用）
//
// 启动：node src/server/server.js   （默认 http://127.0.0.1:8787）
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { extname, resolve, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from './env.js'
import { GameSession } from '../engine/session.js'
import { MemoryStorage } from '../engine/storage.js'
import { GameMaster } from '../agent/gm.js'
import { describeArk, arkChat } from '../agent/ark.js'
import { retrieve, testIma, imaEnabled, listKnowledgeBases } from '../agent/retriever.js'

loadEnv()

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url))
const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 500)
const SESSION_TTL_MS = 6 * 60 * 60 * 1000 // 6 小时未活动即回收
const MAX_FILE_CHARS = 400_000             // 单个教材文件上限（字符）
const MAX_CORPUS_CHARS = 2_000_000         // 每位访客上传教材总量上限（字符）

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

/**
 * 每位访客的游戏会话（内存）。
 * Map<sid, { session: GameSession, gm: GameMaster, last: number }>
 */
const sessions = new Map()

function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function evictSessions() {
  const now = Date.now()
  for (const [sid, entry] of sessions) {
    if (now - entry.last > SESSION_TTL_MS) sessions.delete(sid)
  }
  // 超出上限时按最久未活动淘汰
  while (sessions.size > MAX_SESSIONS) {
    let oldestSid = null
    let oldest = Infinity
    for (const [sid, entry] of sessions) {
      if (entry.last < oldest) { oldest = entry.last; oldestSid = sid }
    }
    if (oldestSid === null) break
    sessions.delete(oldestSid)
  }
}

/** 取出（或新建）该访客的会话，必要时下发 cookie */
function sessionFor(req, res) {
  const sid = parseCookies(req.headers.cookie).gal_sid
  let entry = sid ? sessions.get(sid) : undefined
  if (!entry) {
    const session = new GameSession(new MemoryStorage())
    entry = { session, gm: new GameMaster(session), corpus: [], last: Date.now() }
    const id = randomUUID()
    sessions.set(id, entry)
    res.setHeader('set-cookie', `gal_sid=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`)
    evictSessions()
  }
  entry.last = Date.now()
  return entry
}

/** 从请求头提取用户自带凭证（BYOK）。服务端不持久化这些值。 */
function credsFrom(req) {
  const h = req.headers
  const out = {}
  const pick = (header, field) => {
    const v = h[header]
    if (typeof v === 'string' && v.trim()) out[field] = v.trim()
  }
  // 含非 ASCII（中文键）的头需要先 percent-decode，否则 HTTP 头无法承载
  const pickEncoded = (header, field) => {
    const v = h[header]
    if (typeof v !== 'string' || !v.trim()) return
    try { out[field] = decodeURIComponent(v.trim()) } catch { out[field] = v.trim() }
  }
  pick('x-ark-key', 'arkApiKey')
  pick('x-ark-model', 'arkModel')
  pick('x-ark-base', 'arkBaseUrl')
  pick('x-ima-key', 'imaApiKey')
  pick('x-ima-client-id', 'imaClientId')
  pickEncoded('x-ima-kb-map', 'imaKbMap')
  return out
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** 教材列表视图（不含正文，避免响应过大） */
function corpusView(entry) {
  return {
    ok: true,
    files: entry.corpus.map((f) => ({ id: f.id, name: f.name, subject: f.subject || '', chars: f.text.length })),
    totalChars: entry.corpus.reduce((n, f) => n + f.text.length, 0),
  }
}

async function readBody(req, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try { return JSON.parse(text) } catch { throw new Error('请求体不是合法 JSON') }
}

/** 静态文件：仅允许 WEB_ROOT 之内的路径 */
async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  const target = resolve(WEB_ROOT, normalize(rel))
  if (!target.startsWith(resolve(WEB_ROOT))) {
    res.writeHead(403); res.end('forbidden'); return
  }
  try {
    const data = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('404 not found')
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const { pathname } = url

  try {
    // ── API ──
    if (pathname === '/api/health') {
      const serverArk = describeArk({})      // 只反映服务端预置（BYOK 时为空）
      const creds = credsFrom(req)
      return sendJson(res, 200, {
        ok: true,
        byok: true,                                   // 本服务支持自带密钥
        arkConfigured: Boolean(creds.arkApiKey ? creds.arkModel : serverArk.configured),
        model: creds.arkModel || serverArk.model || null,
        imaConfigured: imaEnabled(creds),
        serverPreset: { ark: serverArk.configured, ima: imaEnabled({}) },
        demo: !(creds.arkApiKey && creds.arkModel) && !serverArk.configured,
        sessions: sessions.size,
      })
    }

    if (pathname === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, sessionFor(req, res).session.status())
    }

    if (pathname === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req)
      const entry = sessionFor(req, res)
      const result = await entry.gm.say(body.message || '', credsFrom(req), entry.corpus)
      return sendJson(res, 200, result)
    }

    // ── 用户自带教材（只放本会话内存，不落盘）──
    if (pathname === '/api/corpus' && req.method === 'GET') {
      return sendJson(res, 200, corpusView(sessionFor(req, res)))
    }

    if (pathname === '/api/corpus' && req.method === 'POST') {
      const body = await readBody(req, 8_000_000)
      const entry = sessionFor(req, res)
      const incoming = Array.isArray(body.files) ? body.files : []
      if (body.replace === true) entry.corpus = []

      for (const f of incoming.slice(0, 30)) {
        const name = String(f.name || '未命名').slice(0, 160)
        let text = String(f.text || '')
        if (!text.trim()) continue
        if (text.length > MAX_FILE_CHARS) text = text.slice(0, MAX_FILE_CHARS)
        const subject = f.subject ? String(f.subject).slice(0, 40) : ''

        // 同名文件视为更新，避免重复上传堆积
        const existing = entry.corpus.findIndex((x) => x.name === name)
        const item = { id: randomUUID(), name, subject, text }
        if (existing >= 0) { item.id = entry.corpus[existing].id; entry.corpus[existing] = item }
        else entry.corpus.push(item)
      }

      // 总量封顶
      let total = 0
      const kept = []
      for (const f of entry.corpus) {
        if (total >= MAX_CORPUS_CHARS) break
        kept.push(f)
        total += f.text.length
      }
      entry.corpus = kept

      const view = corpusView(entry)
      return sendJson(res, 200, { ...view, truncated: total >= MAX_CORPUS_CHARS })
    }

    // 给单个文件打「学科」标签（空字符串 = 通用教材）
    if (pathname === '/api/corpus' && req.method === 'PATCH') {
      const body = await readBody(req)
      const entry = sessionFor(req, res)
      const item = entry.corpus.find((f) => f.id === body.id)
      if (!item) return sendJson(res, 404, { ok: false, error: '未找到该教材文件' })
      item.subject = body.subject ? String(body.subject).slice(0, 40) : ''
      return sendJson(res, 200, corpusView(entry))
    }

    // 删除单个（带 ?id=）或全部
    if (pathname === '/api/corpus' && req.method === 'DELETE') {
      const entry = sessionFor(req, res)
      const id = url.searchParams.get('id')
      if (id) entry.corpus = entry.corpus.filter((f) => f.id !== id)
      else entry.corpus = []
      return sendJson(res, 200, corpusView(entry))
    }

    // ── ima：列出可用知识库（把「名称」解析成「ID」）──
    if (pathname === '/api/ima/kbs' && req.method === 'POST') {
      const r = await listKnowledgeBases(credsFrom(req))
      return sendJson(res, 200, r)
    }

    if (pathname === '/api/reset' && req.method === 'POST') {
      const entry = sessionFor(req, res)
      entry.gm.reset()
      return sendJson(res, 200, { ok: true, state: entry.session.status() })
    }

    // ── 学科管理：用户可以自主增删（通常按自己的 ima 知识库来建）──
    if (pathname === '/api/subjects' && req.method === 'POST') {
      const body = await readBody(req)
      const entry = sessionFor(req, res)
      const r = entry.session.addSubject(body.name)
      return sendJson(res, r.ok ? 200 : 400, { ...r, subjects: Object.keys(entry.session.state.subjects) })
    }

    if (pathname === '/api/subjects' && req.method === 'DELETE') {
      const entry = sessionFor(req, res)
      const r = entry.session.removeSubject(url.searchParams.get('name') || '')
      return sendJson(res, r.ok ? 200 : 400, { ...r, subjects: Object.keys(entry.session.state.subjects) })
    }

    // 连通性测试：用请求头里的凭证真调一次，判断填得对不对
    if (pathname === '/api/test' && req.method === 'POST') {
      const body = await readBody(req)
      const creds = credsFrom(req)
      const kind = body.kind || 'ark'
      if (kind === 'ima') {
        const r = await testIma(creds)
        return sendJson(res, 200, { ok: r.ok === true, kind: 'ima', detail: r })
      }
      if (!(creds.arkApiKey && creds.arkModel)) {
        return sendJson(res, 200, { ok: false, kind: 'ark', error: '请先填写方舟 API Key 与接入点 ID' })
      }
      try {
        const r = await arkChat([{ role: 'user', content: '只回复两个字：收到' }], { creds, temperature: 0, timeoutMs: 30000 })
        return sendJson(res, 200, { ok: true, kind: 'ark', reply: r.content })
      } catch (err) {
        return sendJson(res, 200, { ok: false, kind: 'ark', error: String((err && err.message) || err) })
      }
    }

    // ── 静态 UI ──
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, pathname)

    res.writeHead(405); res.end('method not allowed')
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
  }
})

server.listen(PORT, HOST, () => {
  const serverArk = describeArk({})
  const mode = serverArk.configured
    ? `服务端预置方舟（模型：${serverArk.model}）—— 也可由访客自带 Key 覆盖`
    : 'BYOK 模式（服务端未放任何 Key，由每位访客自带凭证）'
  console.log(`\n  学术galgame Agent 已启动`)
  console.log(`  → http://${HOST}:${PORT}`)
  console.log(`  模型来源：${mode}\n`)
})

export { server }
