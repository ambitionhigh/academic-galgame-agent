// 零依赖 HTTP 服务：伺服 UI 静态资源 + 提供 /api/* 接口。
// 启动：node src/server/server.js   （默认 http://localhost:8787）
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, resolve, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from './env.js'
import { GameSession } from '../engine/session.js'
import { GameMaster } from '../agent/gm.js'
import { isArkConfigured, arkSettings } from '../agent/ark.js'

loadEnv()

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url))
const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'

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

const session = new GameSession()
const gm = new GameMaster(session)

function sendJson(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
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
      return sendJson(res, 200, {
        ok: true,
        arkConfigured: isArkConfigured(),
        model: arkSettings().model || null,
        demo: !isArkConfigured(),
      })
    }
    if (pathname === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, gm.session.status())
    }
    if (pathname === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req)
      const result = await gm.say(body.message || '')
      return sendJson(res, 200, result)
    }
    if (pathname === '/api/reset' && req.method === 'POST') {
      gm.reset()
      return sendJson(res, 200, { ok: true, state: gm.session.status() })
    }

    // ── 静态 UI ──
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, pathname)

    res.writeHead(405); res.end('method not allowed')
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
  }
})

server.listen(PORT, HOST, () => {
  const mode = isArkConfigured() ? `火山方舟（模型：${arkSettings().model}）` : 'demo 模式（未配置 ARK_API_KEY / ARK_MODEL）'
  console.log(`\n  学术galgame Agent 已启动`)
  console.log(`  → http://${HOST}:${PORT}`)
  console.log(`  模型后端：${mode}\n`)
})

export { server }
