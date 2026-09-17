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

import { inflateSync, inflateRawSync } from 'node:zlib'

// 抽到的字少于这个数就当作「没抽到」：多半是扫描版/图片版/需要登录的网页笔记。
export const MIN_USEFUL_CHARS = 400

// 单次解析的输入上限
export const MAX_INPUT_BYTES = 150 * 1024 * 1024

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
export function extractText(buf, filename = '') {
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
    text = pdfText(buf)
    if (!text.trim()) {
      return { text: '', kind: 'pdf-scanned',
               note: '这本 PDF 抽不到文字，多半是**扫描件**（整页都是图片），'
                 + '不是文字版。需要在 ima 里用 OCR，或换文字版' }
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

const OBJ_RE = /(\d+)\s+(\d+)\s+obj\b/g

function findObjects(s) {
  const objs = new Map()
  let m
  OBJ_RE.lastIndex = 0
  while ((m = OBJ_RE.exec(s))) {
    const num = parseInt(m[1], 10)
    let end = s.indexOf('endobj', m.index + m[0].length)
    if (end < 0) end = s.length
    objs.set(num, s.slice(m.index + m[0].length, end))   // 后出现的覆盖前面的，与 Python 一致
  }
  return objs
}

function dictOf(body) {
  const start = body.indexOf('<<')
  if (start < 0) return ''
  let depth = 0
  let i = start
  while (i < body.length - 1) {
    if (body[i] === '<' && body[i + 1] === '<') { depth++; i += 2; continue }
    if (body[i] === '>' && body[i + 1] === '>') {
      depth--
      i += 2
      if (depth === 0) return body.slice(start, i)
      continue
    }
    i++
  }
  return body.slice(start)
}

function streamOf(body) {
  const i = body.indexOf('stream')
  if (i < 0) return ''
  let j = i + 6
  if (body.slice(j, j + 2) === '\r\n') j += 2
  else if (body[j] === '\n' || body[j] === '\r') j += 1
  const k = body.lastIndexOf('endstream')
  return k > j ? body.slice(j, k) : ''
}

function decodeStream(dictBytes, raw) {
  const filters = []
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

/** 带捕获组的全局匹配 → 返回每次匹配的完整数组 */
function* matchAll(s, re) {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let m
  while ((m = r.exec(s))) {
    yield m
    if (m.index === r.lastIndex) r.lastIndex++
  }
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
