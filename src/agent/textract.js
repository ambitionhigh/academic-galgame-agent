// 从 ima 知识库下载下来的**原始文件**里抽出正文（纯 Node 内置模块，零依赖）。
//
// 为什么需要这个：
//   ima 的 get_media_info 给的是「原始文件」的下载地址 —— 你往知识库里放的是
//   PDF / EPUB 书，拿到手就是几十 MB 的二进制。直接当文本读只会得到
//   `%PDF-1.6 %äüöß...` 这种乱码，等于让模型读天书。
//
// 这个文件是 python/agent/textract.py 的 JS 移植版，**行为逐条对齐**：
// 同一本书两边抽出的正文应当完全一致（仓库里有 scripts/check-textract.js 做校验）。
//
// 支持的格式：
//   · EPUB  —— zip + XHTML，稳
//   · PDF   —— 解析内容流 + ToUnicode CMap，支持中文字体（Type0/Identity-H）
//   · DOCX / HTML / 纯文本
//
// 抽不出来时返回空字符串，由上层如实告诉用户「这本书是扫描件，读不了」，
// 而不是把乱码喂给模型。

import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inflateSync, inflateRawSync } from 'node:zlib'

import { findObjects, dictOf, streamOf, matchAll } from './pdfbytes.js'

// 抽到的字少于这个数就当作「没抽到」：多半是扫描版/图片版/需要登录的网页笔记。
export const MIN_USEFUL_CHARS = 400

// 单次解析的输入上限
export const MAX_INPUT_BYTES = 150 * 1024 * 1024

/* ══════════════════════════════════════════════════════════════════
   MinerU（可选）：扫描版 / 复杂版面的救援路径
   ══════════════════════════════════════════════════════════════════

   MinerU（github.com/opendatalab/MinerU）带 OCR 与版面分析，能读内置解析器
   啃不动的扫描版 PDF、表格、公式。但它要装几 GB 的模型、跑得也慢，
   所以这里做成**可选**：

     · 没装 → 完全不参与，行为与以前一模一样（项目保持零依赖）
     · 装了 → auto 模式下只在「内置解析器读不出来」时才动用它当救援
              （普通文字版 PDF 走内置的，快得多）
              always 模式下优先用它（质量更好，但慢）

   绝不使用 --remote：那会把用户的资料上传到 MinerU 的服务器。
   隐私边界由使用者自己决定，我们不替他们决定。

   ⚠️ 这台机器上 Node 无法用管道捕获子进程输出（沙箱禁止命名管道），
   所以 stdout/stderr 都重定向到临时文件，而不是 spawnSync 的 encoding 模式。 */

export const MINERU_TIMEOUT = Number(process.env.GALGAME_MINERU_TIMEOUT || 600) * 1000

// 档位（MinerU 4 的四档）：flash / basic / standard / advanced。
// 不传档位不行 —— MinerU 默认是 **standard**，而 standard 要「小模型 + VLM」，
// VLM 才是那几个 GB 的大头。实测（ModelScope 的 MinerU-4_models_onnx）：
//   小模型包合计 818 MB = 公式识别 564 + 版面分析 204 + **OCR 仅 20** + 表格 22
//   而 VLM 是额外几个 GB。
// 我们的用途是「把扫描书读成文字喂给老师」，basic 就够且不需要 VLM，所以默认 basic。
export const MINERU_TIER = (process.env.GALGAME_MINERU_TIER || 'basic').trim().toLowerCase()
const MINERU_OFF = ['0', 'off', 'false', 'no', 'none']

/**
 * 读 MinerU 开关。**每次现读**，不要缓存成模块常量 ——
 * 缓存的话跑起来之后再设环境变量就不生效了（Python 侧踩过这个坑）。
 */
export function mineruMode() {
  return (process.env.GALGAME_MINERU || 'auto').trim().toLowerCase()
}

/**
 * 视觉读页的入口。实现全在 visionread.js，这里只做转发，
 * 免得调用方要同时 import 两个模块。
 */
import { visionAvailable, visionConfigured, visionMode, visionStatus, readPdf } from './visionread.js'
export { visionAvailable, visionConfigured, visionMode, visionStatus }

let _mineruCmd

/** 简易 which：不靠子进程（管道在受限环境里会被拒） */
function whichSync(cmd) {
  if (!cmd) return ''
  if (cmd.includes('/') || cmd.includes('\\')) return existsSync(cmd) ? cmd : ''
  const win = process.platform === 'win32'
  const exts = win ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  for (const dir of String(process.env.PATH || '').split(win ? ';' : ':')) {
    if (!dir) continue
    for (const ext of exts) {
      const p = join(dir, cmd + ext)
      try { if (statSync(p).isFile()) return p } catch { /* 继续找 */ }
    }
  }
  return ''
}

/** 探测可用的 MinerU CLI；没装返回 ''（结果缓存） */
export function mineruCommand() {
  if (_mineruCmd !== undefined) return _mineruCmd
  if (MINERU_OFF.includes(mineruMode())) { _mineruCmd = ''; return '' }
  const explicit = process.env.MINERU_CMD
  if (explicit) {
    const found = whichSync(explicit)
    if (found) { _mineruCmd = found; return found }
  }
  for (const name of ['mineru', 'mineru-kit']) {
    const found = whichSync(name)
    if (found) { _mineruCmd = found; return found }
  }
  _mineruCmd = ''
  return ''
}

export function mineruAvailable() {
  return Boolean(mineruCommand())
}

/** 跑子进程，stdout/stderr 各写一个文件（避开管道限制）。不抛异常。
 *
 *  ⚠️ Node 从 18.20 起不允许直接 spawn `.bat`/`.cmd`（会 EINVAL），
 *  而 uv / pip 装的 CLI 在 Windows 上可能是 `.cmd` 垫片，所以这里用
 *  `cmd /c` 包一层。Python 的 subprocess 没这个问题，所以两边要分开处理。 */
function runCapture(exe, args, outFile, errFile, timeoutMs) {
  let outFd, errFd
  try {
    outFd = openSync(outFile, 'w')
    errFd = openSync(errFile, 'w')
  } catch (e) {
    try { if (outFd !== undefined) closeSync(outFd) } catch { /* ignore */ }
    return { ok: false, err: String((e && e.message) || e) }
  }
  try {
    const isBatch = /\.(bat|cmd)$/i.test(exe)
    // ⚠️ 必须强制子进程用 UTF-8 输出。MinerU 是 Python 工具，在中文 Windows 上
    //    它的 stdout 默认跟随控制台代码页（GBK）—— 那样我们按 UTF-8 读回来就是乱码。
    //    （实测过：同一份 JSON，GBK 输出会让正文长度从 1451 变成 2175 的乱码。）
    const childEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    let r
    if (isBatch) {
      // 批处理必须走 shell。注意路径里的空格：得自己加引号，
      // 而且整条命令作为**一个字符串**交给 shell（shell 模式下 Node 不会再转义参数）。
      const q = (s) => '"' + String(s).replace(/"/g, '""') + '"'
      r = spawnSync([exe, ...args].map(q).join(' '), {
        shell: true,
        stdio: ['ignore', outFd, errFd],
        timeout: timeoutMs,
        windowsHide: true,
        env: childEnv,
      })
    } else {
      r = spawnSync(exe, args, {
        stdio: ['ignore', outFd, errFd],
        timeout: timeoutMs,
        windowsHide: true,
        env: childEnv,
      })
    }
    if (r.error) {
      const msg = String((r.error && r.error.message) || r.error)
      return { ok: false, err: /ETIMEDOUT|timed? ?out/i.test(msg) ? `超时（${timeoutMs / 1000}s）` : msg }
    }
    return { ok: r.status === 0, err: r.status === 0 ? '' : `退出码 ${r.status}` }
  } finally {
    try { closeSync(outFd) } catch { /* ignore */ }
    try { closeSync(errFd) } catch { /* ignore */ }
  }
}

function readIfExists(p) {
  try { return readFileSync(p, 'utf8') } catch { return '' }
}

/** 用 MinerU 抽正文。@returns {{text:string, note:string}} note 非空表示没成功 */
export function mineruText(data, filename = '', timeoutMs) {
  const exe = mineruCommand()
  if (!exe) return { text: '', note: 'MinerU 未安装' }
  const timeout = timeoutMs || MINERU_TIMEOUT
  const work = mkdtempSync(join(tmpdir(), 'galgame-mineru-'))
  try {
    const src = join(work, basename(filename) || 'document.pdf')
    writeFileSync(src, data)

    // ① 新版 CLI：mineru parse <file> --pages all --json
    const out1 = join(work, 'out1.json')
    const err1 = join(work, 'err1.txt')
    let r = runCapture(exe, ['parse', src, '--pages', 'all', '--json', '--tier', MINERU_TIER], out1, err1, timeout)
    if (r.ok) {
      const text = mineruExtractJson(readIfExists(out1))
      if (text.trim()) return { text, note: '' }
      r = { ok: false, err: readIfExists(err1).trim().slice(0, 200) || '返回里没有正文' }
    }

    // ② 兜底：无状态转换 mineru-kit parse <file> -o <out.md>
    const kit = process.env.MINERU_KIT_CMD || whichSync('mineru-kit')
    if (kit) {
      const outMd = join(work, 'out.md')
      const err2 = join(work, 'err2.txt')
      const r2 = runCapture(kit, ['parse', src, '-o', outMd], join(work, 'out2.txt'), err2, timeout)
      if (r2.ok) {
        const text = readIfExists(outMd)
        if (text.trim()) return { text, note: '' }
      }
      r = { ok: false, err: (r2.err || r.err || '').trim().slice(0, 200) }
    }
    return { text: '', note: `MinerU 没抽出正文（${(r.err || '未知原因').trim().slice(0, 200)}）` }
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/** 从 mineru 的 --json 输出里取正文（可能夹着日志行，逐行倒着试） */
export function mineruExtractJson(stdout) {
  const dig = (obj) => {
    if (!obj || typeof obj !== 'object') return ''
    const c = obj.content
    if (c && typeof c === 'object') {
      for (const k of ['content', 'markdown', 'text']) {
        if (typeof c[k] === 'string' && c[k].trim()) return c[k]
      }
    }
    if (typeof c === 'string' && c.trim()) return c
    for (const k of ['markdown', 'text', 'md']) {
      if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k]
    }
    return ''
  }
  try {
    const got = dig(JSON.parse(stdout))
    if (got) return got
  } catch { /* 落到逐行 */ }
  const lines = String(stdout || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      const got = dig(JSON.parse(line))
      if (got) return got
    } catch { /* 继续 */ }
  }
  return ''
}

/* ══════════════════════════════════════════════════════════════════
   对外入口
   ══════════════════════════════════════════════════════════════════ */

export function sniffKind(buf, filename = '') {
  const head = buf.subarray(0, 8).toString('latin1')
  if (head.startsWith('%PDF')) return 'pdf'
  if (head.startsWith('PK\x03\x04')) {
    const low = String(filename || '').toLowerCase()
    if (low.endsWith('.epub')) return 'epub'
    try {
      const names = zipEntryNames(buf)
      if (names.includes('META-INF/container.xml')) return 'epub'
      if (names.includes('word/document.xml')) return 'docx'
      return 'zip'
    } catch {
      return 'zip'
    }
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, 4096))
    return 'text'
  } catch {
    return 'binary'
  }
}

/**
 * 把原始文件抽成纯文本。
 * @returns {{text:string, kind:string, note:string}}
 */
export function extractText(buf, filename = '', opts = {}) {
  if (!buf || !buf.length) return { text: '', kind: 'empty', note: '文件是空的' }
  if (buf.length > MAX_INPUT_BYTES) {
    return { text: '', kind: 'toolarge', note: `文件超过 ${MAX_INPUT_BYTES / 1048576} MB，跳过解析` }
  }

  const kind0 = sniffKind(buf, filename)
  let kind = kind0
  let text = ''
  let note = ''

  if (kind0 === 'text') {
    const head = buf.subarray(0, 400).toString('utf8').trimStart().toLowerCase()
    const first4k = buf.subarray(0, 4000).toString('utf8').toLowerCase()
    if (head.startsWith('<!doctype html') || head.startsWith('<html') || first4k.includes('<body')) {
      kind = 'html'
      text = htmlToText(buf.toString('utf8'))
      note = '这是一个网页笔记，正文要登录才能看到，抽不到'
    } else {
      text = buf.toString('utf8')
    }
  } else if (kind0 === 'epub') {
    text = epubText(buf)
    if (text.trim().length < 20000) {
      const nb = imageBookNote(buf, '这本 EPUB')
      if (nb) { text = ''; note = nb }
    }
  } else if (kind0 === 'pdf') {
    // 两把可选的钥匙，都读不出来才轮到下一把：
    //   ① 视觉模型读页（配了就能用、零模型下载、快，可以走本地 Ollama）
    //   ② MinerU（全本地离线，但要装 800 MB 模型，慢）
    //     —— 顺序在 extractTextAsync 里编排；这里只认「always」这个用户明示。
    const useMineru = mineruAvailable() && !opts.skipMineru
    const forceMineru = useMineru && ['always', '1', 'on', 'true', 'yes'].includes(mineruMode())
    if (forceMineru) {
      const m = mineruText(buf, filename)
      if (m.text.trim()) return { text: m.text, kind: 'pdf+mineru', note: '' }
    }

    text = pdfText(buf)
    if (!text.trim() && useMineru) {
      const m = mineruText(buf, filename)
      if (m.text.trim()) return { text: m.text, kind: 'pdf+mineru', note: '' }
      return { text: '', kind: 'pdf-scanned',
               note: `这本 PDF 内置解析器读不出来（多半是扫描件），MinerU 也没成功：${m.note}` }
    }
    if (!text.trim()) {
      return { text: '', kind: 'pdf-scanned',
               note: '这本 PDF 抽不到文字，多半是**扫描件**（整页都是图片），不是文字版。\n'
                 + '两条路都能读它：\n'
                 + '· **让有眼睛的模型看页面**（推荐，配一下就行、不用下载模型）——'
                 + '设一个多模态模型的地址，或用本地 Ollama，见 README「扫描版 PDF」一节\n'
                 + '· **MinerU**（全本地离线，但要装约 800 MB 模型）——同一个章节有说明' }
    }
  } else if (kind0 === 'docx') {
    text = docxText(buf)
  } else {
    return { text: '', kind: kind0, note: `不认识的格式（${kind0}），没法抽正文` }
  }

  const stripped = text.trim()
  if (!stripped) return { text: '', kind, note: note || '没抽到文字' }
  if (stripped.length < MIN_USEFUL_CHARS) {
    return { text: '', kind: kind + '-tiny',
             note: note || `只抽到 ${stripped.length} 个字，基本是目录或图片版，读不了正文` }
  }
  return { text, kind, note: '' }
}

/**
 * 抽正文（**异步版**）—— 比 extractText 多一条「让有眼睛的模型看页面」的救援路。
 *
 * 为什么要有两个入口：视觉读页要走 HTTP，天生是异步的；而 extractText 是同步的，
 * 已经有一堆调用方（还有 Python 侧要跟它逐字节对齐）。所以同步版保持原样不动，
 * 需要读扫描件的地方用这个异步版。
 *
 * 救援顺序：内置解析器 → **视觉模型** → MinerU。
 * 为什么视觉排在 MinerU 前面：视觉配好就能用、一页一两秒、不用下 800 MB 模型；
 * MinerU 全本地离线但慢得多。两个都没配就如实告诉用户读不了。
 */
export async function extractTextAsync(buf, filename = '', onProgress) {
  const visionOn = visionAvailable()
  const forced = visionOn && ['always', '1', 'on', 'true', 'yes'].includes(visionMode())
  // 有视觉模型时先按住 MinerU：它慢得多，别让它抢在前面跑几分钟
  const r = extractText(buf, filename, { skipMineru: visionOn })

  const isPdf = String(r.kind).startsWith('pdf')
  if (r.text && !(forced && isPdf)) return r
  if (!visionOn) return r
  if (!forced && r.kind !== 'pdf-scanned') return r

  const v = await readPdf(buf, filename, onProgress)
  if (v.text.trim()) return { text: v.text, kind: 'pdf+vision', note: v.note || '' }
  if (r.text) return r                    // always 模式下视觉没成，原文还能用

  let note = joinNotes(r.note, `视觉模型也没读出来：${v.note || '（没内容）'}`)
  if (mineruAvailable()) {                       // 最后一根稻草
    const m = mineruText(buf, filename)
    if (m.text.trim()) return { text: m.text, kind: 'pdf+mineru', note: '' }
    note = joinNotes(note, `MinerU 也没成功：${m.note}`)
  }
  return { text: '', kind: 'pdf-scanned', note }
}

function joinNotes(a, b) {
  return [a, b].filter(Boolean).join('\n')
}

function imageBookNote(buf, what) {
  let nImg = 0
  try {
    for (const n of zipEntryNames(buf)) {
      if (/\.(jpe?g|png|gif|webp)$/i.test(n)) nImg++
    }
  } catch { nImg = 0 }
  if (nImg >= 10) return `${what} 是**图片版**（正文在 ${nImg} 张图片里，没有可抽取的文字）`
  return ''
}

/* ══════════════════════════════════════════════════════════════════
   极简 ZIP 读取（EPUB / DOCX 都是 zip）
   ══════════════════════════════════════════════════════════════════ */

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65536)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error('不是有效的 zip（找不到 EOCD）')
}

/** @returns {Array<{name:string, method:number, compSize:number, localOff:number}>} */
function zipEntries(buf) {
  const eocd = findEocd(buf)
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    out.push({ name, method, compSize, localOff })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

function zipEntryNames(buf) {
  return zipEntries(buf).map((e) => e.name)
}

function zipRead(buf, entry) {
  const p = entry.localOff
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`本地头损坏：${entry.name}`)
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const start = p + 30 + nameLen + extraLen
  const data = buf.subarray(start, start + entry.compSize)
  if (entry.method === 0) return Buffer.from(data)
  // ⚠️ zip 里存的是**裸 deflate**（raw），不是 zlib 包装；用 inflateSync 会报
  //    "incorrect header check"。PDF 的 FlateDecode 才是 zlib 包装 —— 两者别搞混。
  if (entry.method === 8) return inflateRawSync(data)
  throw new Error(`不支持的压缩方式 ${entry.method}：${entry.name}`)
}

function openZip(buf) {
  const entries = zipEntries(buf)
  const byName = new Map(entries.map((e) => [e.name, e]))
  return {
    names: entries.map((e) => e.name),
    has: (n) => byName.has(n),
    read: (n) => {
      const e = byName.get(n)
      if (!e) throw new Error('no entry ' + n)
      return zipRead(buf, e)
    },
  }
}

/* ══════════════════════════════════════════════════════════════════
   HTML → 文本
   ══════════════════════════════════════════════════════════════════ */

const TAG_RE = /<[^>]+>/g
const SCRIPT_RE = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi

export function htmlToText(html) {
  let s = String(html || '').replace(SCRIPT_RE, ' ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
  s = s.replace(TAG_RE, '')
  s = s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  s = s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  s = s.replace(/[ \t\u00a0]+/g, ' ')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/* ══════════════════════════════════════════════════════════════════
   EPUB
   ══════════════════════════════════════════════════════════════════ */

function epubText(buf) {
  let z
  try { z = openZip(buf) } catch { return '' }

  const order = []
  try {
    const container = z.read('META-INF/container.xml').toString('utf8')
    const m = container.match(/full-path="([^"]+)"/)
    if (m) {
      const opfPath = m[1]
      const opf = z.read(opfPath).toString('utf8')
      const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''
      const manifest = {}
      const re1 = /<item\b[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"/g
      let mm
      while ((mm = re1.exec(opf))) manifest[mm[1]] = mm[2]
      if (!Object.keys(manifest).length) {
        const re2 = /<item\b[^>]*\bhref="([^"]+)"[^>]*\bid="([^"]+)"/g
        while ((mm = re2.exec(opf))) manifest[mm[2]] = mm[1]
      }
      const re3 = /<itemref\b[^>]*\bidref="([^"]+)"/g
      while ((mm = re3.exec(opf))) {
        const href = manifest[mm[1]]
        if (href) order.push(base ? base + '/' + href : href)
      }
    }
  } catch { /* 退化成正序读所有 html */ }

  if (!order.length) {
    for (const n of z.names) if (/\.(xhtml|html|htm)$/i.test(n)) order.push(n)
  }

  const parts = []
  const used = new Set()
  for (const path of order) {
    if (!z.has(path)) continue
    used.add(path)
    parts.push(htmlToText(z.read(path).toString('utf8')))
  }
  let text = parts.filter(Boolean).join('\n\n')

  // 有些 EPUB 的 spine 只挂了封面和目录，正文在别的文件里。
  // 抽到的字太少时，把所有 xhtml/html 都补读一遍。
  if (text.length < 20000) {
    const extra = []
    for (const name of z.names) {
      if (used.has(name) || !/\.(xhtml|html|htm)$/i.test(name)) continue
      try { extra.push(htmlToText(z.read(name).toString('utf8'))) } catch { /* 跳过 */ }
    }
    const merged = text + '\n\n' + extra.filter(Boolean).join('\n\n')
    if (merged.length > text.length) text = merged
  }
  return text
}

/* ══════════════════════════════════════════════════════════════════
   DOCX
   ══════════════════════════════════════════════════════════════════ */

function docxText(buf) {
  try {
    const z = openZip(buf)
    let xml = z.read('word/document.xml').toString('utf8')
    xml = xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab[^>]*\/>/g, '\t')
    return htmlToText(xml)
  } catch { return '' }
}

/* ══════════════════════════════════════════════════════════════════
   PDF
   ══════════════════════════════════════════════════════════════════

   解析全程用 latin1 字符串表示字节（一个字符 = 一个字节），
   和 Python 版直接操作 bytes 的语义一致，两边结果才能逐字节对齐。 */

function decodeStream(dictBytes, raw) {  const filters = []
  const fm = dictBytes.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/g) || []
  for (const f of fm) {
    const names = f.match(/\/(\w+)/g) || []
    for (const n of names) filters.push(n.slice(1))
  }
  let data = Buffer.from(raw, 'latin1')
  for (const name of filters) {
    try {
      if (name === 'FlateDecode' || name === 'Fl') data = inflateSync(data)
      else if (name === 'ASCIIHexDecode' || name === 'AHx') {
        let hex = raw.split('>')[0].replace(/[^0-9A-Fa-f]/g, '')
        if (hex.length % 2) hex += '0'
        data = Buffer.from(hex, 'hex')
      } else if (name === 'ASCII85Decode' || name === 'A85') {
        data = a85(raw)
      }
    } catch {
      return Buffer.alloc(0)
    }
  }
  return data
}

/** ASCII85 解码（Buffer 没有内置，手写一个） */
function a85(raw) {
  let s = raw.trim()
  if (s.startsWith('<~')) s = s.slice(2)
  const end = s.indexOf('~>')
  if (end >= 0) s = s.slice(0, end)
  s = s.replace(/\s/g, '')
  const out = []
  let tuple = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === 'z' && tuple.length === 0) { out.push(0, 0, 0, 0); continue }
    const v = s.charCodeAt(i) - 33
    if (v < 0 || v > 84) continue
    tuple.push(v)
    if (tuple.length === 5) {
      let n = 0
      for (const t of tuple) n = (n * 85 + t) >>> 0
      out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
      tuple = []
    }
  }
  if (tuple.length) {
    const pad = 5 - tuple.length
    for (let i = 0; i < pad; i++) tuple.push(84)
    let n = 0
    for (const t of tuple) n = (n * 85 + t) >>> 0
    const bytes = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
    out.push(...bytes.slice(0, 4 - pad))
  }
  return Buffer.from(out)
}

function hexToStr(h) {
  if (h.length % 4 === 0) {
    try {
      const b = Buffer.from(h, 'hex')
      const swapped = Buffer.alloc(b.length)
      for (let i = 0; i + 1 < b.length; i += 2) { swapped[i] = b[i + 1]; swapped[i + 1] = b[i] }
      return swapped.toString('utf16le')
    } catch { /* 落到下面 */ }
  }
  try { return String.fromCodePoint(parseInt(h, 16)) } catch { return '' }
}

function codeToStr(code, hexlen) {
  if (code >= 0x110000) return ''
  try { return String.fromCodePoint(code) } catch { return '' }
}

/** 解析 ToUnicode CMap → {map: Map<number,string>, width: 1|2} */
function parseToUnicode(cmapBytes) {
  const table = new Map()
  let width = 1
  const text = cmapBytes.toString('latin1')

  for (const block of matchAll(text, /beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, src, dst] of matchAll(block, /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      if (src.length >= 4) width = 2
      table.set(parseInt(src, 16), hexToStr(dst))
    }
  }
  for (const block of matchAll(text, /beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, dst] of matchAll(block, /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      if (lo.length >= 4) width = 2
      const a = parseInt(lo, 16)
      const b = parseInt(hi, 16)
      const base = parseInt(dst, 16)
      if (b - a > 65535) continue
      for (let i = 0; i <= b - a; i++) table.set(a + i, codeToStr(base + i, dst.length))
    }
    for (const [, lo, hi, arr] of matchAll(block, /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      if (lo.length >= 4) width = 2
      const a = parseInt(lo, 16)
      let i = 0
      for (const [, d] of matchAll(arr, /<([0-9A-Fa-f]+)>/g)) table.set(a + i++, hexToStr(d))
    }
  }
  return { map: table, width }
}

/** PDF 字面量字符串里的转义还原成字节 */
function escapeString(raw) {
  const out = []
  let i = 0
  const SIMPLE = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 0x28, ')': 0x29, '\\': 0x5c }
  while (i < raw.length) {
    const c = raw[i]
    if (c === '\\' && i + 1 < raw.length) {
      const n = raw[i + 1]
      if (Object.prototype.hasOwnProperty.call(SIMPLE, n)) { out.push(SIMPLE[n]); i += 2; continue }
      if (n >= '0' && n <= '7') {
        let j = i + 1
        let oct = ''
        while (j < raw.length && oct.length < 3 && raw[j] >= '0' && raw[j] <= '7') { oct += raw[j]; j++ }
        out.push(parseInt(oct, 8) & 0xff)
        i = j
        continue
      }
      if (n === '\n' || n === '\r') { i += 2; continue }
      out.push(n.charCodeAt(0) & 0xff)
      i += 2
      continue
    }
    out.push(c.charCodeAt(0) & 0xff)
    i++
  }
  return Buffer.from(out)
}

function pdfText(buf) {
  const s = buf.toString('latin1')
  const objs = findObjects(s)
  if (!objs.size) return ''

  const fontCache = new Map()
  function fontFor(num) {
    if (fontCache.has(num)) return fontCache.get(num)
    const body = objs.get(num) || ''
    const d = dictOf(body)
    const info = { map: new Map(), width: 1 }
    const m = d.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/)
    if (m) {
      const tuBody = objs.get(parseInt(m[1], 10)) || ''
      const cmapRaw = decodeStream(dictOf(tuBody), streamOf(tuBody))
      if (cmapRaw.length) {
        const p = parseToUnicode(cmapRaw)
        info.map = p.map
        info.width = p.width
      }
    }
    if (!info.map.size && /\/Subtype\s*\/Type0/.test(d)) info.width = 2
    fontCache.set(num, info)
    return info
  }

  function pageFonts(resDict) {
    const out = new Map()
    let fontBlock = ''
    const fm = resDict.match(/\/Font\s*<<([\s\S]*?)>>/)
    if (fm) fontBlock = fm[1]
    else {
      const fr = resDict.match(/\/Font\s+(\d+)\s+\d+\s+R/)
      if (fr) fontBlock = dictOf(objs.get(parseInt(fr[1], 10)) || '')
    }
    for (const [, name, num] of matchAll(fontBlock, /\/([A-Za-z0-9#_.\-]+)\s+(\d+)\s+\d+\s+R/g)) {
      out.set(name, fontFor(parseInt(num, 10)))
    }
    return out
  }

  const pages = []
  for (const [num, body] of objs) {
    const d = dictOf(body)
    if (/\/Type\s*\/Page\b/.test(d) && !/\/Type\s*\/Pages\b/.test(d)) pages.push([num, d])
  }
  pages.sort((a, b) => a[0] - b[0])

  const chunks = []
  for (const [, d] of pages) {
    let res = ''
    const rm = d.match(/\/Resources\s*(\d+)\s+\d+\s+R/)
    if (rm) res = dictOf(objs.get(parseInt(rm[1], 10)) || '')
    else {
      const rm2 = d.match(/\/Resources\s*<</)
      if (rm2) res = dictOf(d.slice(rm2.index))
    }
    const fonts = pageFonts(res)
    const text = contentToText(pageContent(objs, d), fonts)
    if (text.trim()) chunks.push(text)
  }
  return chunks.join('\n\n')
}

function pageContent(objs, pageDict) {
  const parts = []
  const m = pageDict.match(/\/Contents\s*(\d+)\s+\d+\s+R/)
  if (m) parts.push(objs.get(parseInt(m[1], 10)) || '')
  else {
    const arr = pageDict.match(/\/Contents\s*\[([\s\S]*?)\]/)
    if (arr) {
      for (const [, num] of matchAll(arr[1], /(\d+)\s+\d+\s+R/g)) {
        parts.push(objs.get(parseInt(num, 10)) || '')
      }
    }
  }
  let data = ''
  for (const chunk of parts) data += decodeStream(dictOf(chunk), streamOf(chunk)).toString('latin1') + '\n'
  return data
}

// PDF 内容流 token：
//   str = 字面字符串 (...)   hex = 十六进制字符串 <...>   name = /Name
//   num = 数字              arr = 数组括号               op  = 操作符
const TOKEN_RE = new RegExp(
  '(?<str>\\((?:\\\\.|[^\\\\()])*\\))'
  + '|(?<hex><[0-9A-Fa-f\\s]*>)'
  + '|(?<name>/[^\\s/\\[\\]<>(){}]+)'
  + '|(?<num>[-+]?\\d*\\.?\\d+)'
  + '|(?<arr>[\\[\\]])'
  + "|(?<op>[A-Za-z'\"*][A-Za-z0-9'\"*]*)", 'gs')

function contentToText(content, fonts) {
  if (!content) return ''
  let cur = { map: new Map(), width: 1 }
  const out = []
  let pending = []
  const state = { y: null, leading: 0 }

  const decode = (bytes) => {
    const m = cur.map
    if (!m.size) {
      if (cur.width === 2) {
        try {
          const swapped = Buffer.alloc(bytes.length - (bytes.length % 2))
          for (let i = 0; i + 1 < bytes.length; i += 2) { swapped[i] = bytes[i + 1]; swapped[i + 1] = bytes[i] }
          return swapped.toString('utf16le')
        } catch { return '' }
      }
      return bytes.toString('latin1')
    }
    let s = ''
    if (cur.width === 2) {
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        s += m.get((bytes[i] << 8) | bytes[i + 1]) || ''
      }
    } else {
      for (const b of bytes) s += m.get(b) || ''
    }
    return s
  }

  const flush = (newline = false) => {
    const s = pending.join('')
    pending = []
    if (s) out.push(s)
    if (newline && out.length && !out[out.length - 1].endsWith('\n')) out.push('\n')
  }

  // Y 变了才断行（阈值 2.0）：很多 PDF 逐字定位，按 Td 断行会变成一个汉字一行
  const seeY = (y) => {
    if (state.y === null) state.y = y
    else if (Math.abs(y - state.y) > 2.0) { flush(true); state.y = y }
  }

  let nums = []
  TOKEN_RE.lastIndex = 0
  let m
  while ((m = TOKEN_RE.exec(content))) {
    const g = m.groups
    if (g.num !== undefined) {
      const v = parseFloat(g.num)
      nums.push(Number.isFinite(v) ? v : 0)
      if (nums.length > 8) nums = nums.slice(-8)
      continue
    }
    if (g.name !== undefined) {
      const name = g.name.slice(1)
      if (fonts.has(name)) cur = fonts.get(name)
      nums = []
      continue
    }
    if (g.str !== undefined) {
      pending.push(decode(escapeString(g.str.slice(1, -1))))
      nums = []
      continue
    }
    if (g.hex !== undefined) {
      let h = g.hex.slice(1, -1).replace(/\s/g, '')
      if (h.length % 2) h += '0'
      try { pending.push(decode(Buffer.from(h, 'hex'))) } catch { /* 忽略 */ }
      nums = []
      continue
    }
    if (g.op !== undefined) {
      const op = g.op
      if (op === 'Tj' || op === "'" || op === '"') {
        if (op === "'" || op === '"') flush(true)
        flush()
      } else if (op === 'TJ') {
        flush()
      } else if (op === 'Td' && nums.length >= 2) {
        state.y = (state.y || 0) + nums[nums.length - 1]
        seeY(state.y)
      } else if (op === 'TD' && nums.length >= 2) {
        state.leading = -nums[nums.length - 1]
        state.y = (state.y || 0) + nums[nums.length - 1]
        seeY(state.y)
      } else if (op === 'Tm' && nums.length >= 6) {
        state.y = nums[nums.length - 1]
        seeY(state.y)
      } else if (op === 'T*') {
        state.y = (state.y || 0) - state.leading
        seeY(state.y)
      } else if (op === 'ET') {
        flush(true)
      }
      nums = []
      continue
    }
  }
  flush()

  let text = out.join('').replace(/\x00/g, '')
  text = text.replace(/[ \t]{2,}/g, ' ')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}
