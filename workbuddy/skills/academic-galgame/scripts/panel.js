// 本地实时面板：把游戏状态渲染成有动画的网页
//
// 为什么需要它：WorkBuddy 是对话式 Agent，纯文本反馈撑不起 galgame 的手感。
// 这个面板跟 CLI 共用同一份存档 —— Agent 在对话里推进游戏，你在浏览器里看鲸鱼娘实时动。
//
// 用法：node panel.js [--port 8790] [--host 127.0.0.1]
// 零依赖：只用 node: 内置模块；立绘是技能包内置的 PNG 精灵图。
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createState, migrateState, statusView } from './engine/game.js'
import { battleView } from './engine/battle.js'
import { listMaterials } from './materials.js'
import { credsStatus } from './ima.js'
import { llmStatus } from './llm.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PANEL_DIR = join(HERE, '..', 'panel')
const ASSET_DIR = join(HERE, '..', 'assets', 'whale-girl')
const SAVE = process.env.GALGAME_SAVE || join(homedir(), '.workbuddy', 'academic-galgame', 'save.json')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

/** 读存档（与 CLI 共用同一份文件） */
function loadAll() {
  try {
    const j = JSON.parse(readFileSync(SAVE, 'utf8'))
    return { state: migrateState(j.state), battle: j.battle || null }
  } catch {
    return { state: createState(), battle: null }
  }
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function sendFile(res, file, fallbackType = 'application/octet-stream') {
  try {
    const buf = readFileSync(file)
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || fallbackType,
      'content-length': buf.length,
      'cache-control': 'no-cache',
    })
    res.end(buf)
  } catch {
    res.writeHead(404); res.end('not found')
  }
}

export function startPanel({ port = 8790, host = '127.0.0.1' } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const p = url.pathname

    if (p === '/api/state') {
      const { state, battle } = loadAll()
      const mats = listMaterials()
      const ima = credsStatus()
      const llm = llmStatus()
      return sendJson(res, 200, {
        ok: true,
        save: SAVE,
        game: statusView(state, battle),
        battle: battleView(battle),
        materials: { count: mats.count, totalChars: mats.totalChars },
        ima: { configured: ima.configured, boundSubjects: ima.boundSubjects },
        llm: { mode: llm.mode, configured: llm.configured, model: llm.llmModel },
        serverTime: Date.now(),
      })
    }
    if (p === '/api/health') return sendJson(res, 200, { ok: true, panel: 'academic-galgame' })

    // 立绘精灵图
    if (p.startsWith('/assets/whale-girl/')) {
      const name = p.slice('/assets/whale-girl/'.length).replace(/[^a-zA-Z0-9._-]/g, '')
      if (!name) { res.writeHead(404); return res.end('not found') }
      return sendFile(res, join(ASSET_DIR, name), 'image/png')
    }

    // 面板静态资源
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '')
    const target = resolve(PANEL_DIR, normalize(rel))
    if (!target.startsWith(resolve(PANEL_DIR))) { res.writeHead(403); return res.end('forbidden') }
    return sendFile(res, target)
  })

  server.listen(port, host, () => {
    console.log(`\n  学术galgame 实时面板已启动`)
    console.log(`  → http://${host}:${port}`)
    console.log(`  存档：${SAVE}`)
    console.log(`  （Agent 在对话里推进游戏，本页面会自动更新并播放动画）\n`)
  })
  return server
}

// 直接运行时启动
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2)
  const get = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d }
  startPanel({ port: Number(get('--port', process.env.GALGAME_PANEL_PORT || 8790)), host: get('--host', '127.0.0.1') })
}
