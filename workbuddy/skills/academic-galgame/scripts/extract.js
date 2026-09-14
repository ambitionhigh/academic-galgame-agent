// 教材文本提取（Node 侧，零依赖）
//   .md / .txt / .markdown  → 直读
//   .docx                   → 解 ZIP 取 word/document.xml 再剥标签（用 zlib.inflateRawSync）
//   .pdf                    → 尽力而为：按 /Length 定位流 + zlib 解压 + 抽取 BT…ET 文本操作符
//
// 与 Web 版 src/web/extract.js 逻辑一致，只是把浏览器的 DecompressionStream 换成 Node 的 zlib。
import { readFileSync } from 'node:fs'
import { inflateRawSync, inflateSync } from 'node:zlib'

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'", '&#39;': "'" }
const unescapeXml = (s) => s.replace(/&(lt|gt|amp|quot|apos|#39);/g, (m) => ENTITIES[m] || m)

/* ══════════ .docx ══════════ */

function docxXmlToText(xml) {
  return unescapeXml(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]*>/g, ''),
  ).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function unzipEntry(buf, wantName) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = -1
  const floor = Math.max(0, buf.length - 66000)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 .docx（找不到 ZIP 中央目录）')

  const count = dv.getUint16(eocd + 10, true)
  let off = dv.getUint32(eocd + 16, true)
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || dv.getUint32(off, true) !== 0x02014b50) break
    const method = dv.getUint16(off + 10, true)
    const compSize = dv.getUint32(off + 20, true)
    const nameLen = dv.getUint16(off + 28, true)
    const extraLen = dv.getUint16(off + 30, true)
    const commentLen = dv.getUint16(off + 32, true)
    const localOff = dv.getUint32(off + 42, true)
    // 兼容某些工具把条目名写成反斜杠
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8').replace(/\\/g, '/')

    if (name === wantName) {
      const lNameLen = dv.getUint16(localOff + 26, true)
      const lExtraLen = dv.getUint16(localOff + 28, true)
      const dataStart = localOff + 30 + lNameLen + lExtraLen
      const raw = buf.subarray(dataStart, dataStart + compSize)
      if (method === 8) return inflateRawSync(raw)
      if (method === 0) return raw
      throw new Error(`.docx 使用了不支持的压缩方式（method ${method}）`)
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`.docx 里没有找到 ${wantName}`)
}

function extractDocx(buf) {
  const xml = unzipEntry(buf, 'word/document.xml').toString('utf8')
  const text = docxXmlToText(xml)
  if (!text) throw new Error('.docx 里没有提取到文字（可能是纯图片文档）')
  return text
}

/* ══════════ .pdf（尽力而为） ══════════ */

function decodePdfLiteral(s) {
  return s
    .replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c] || c))
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\\r?\n/g, '')
}

function decodePdfHex(hex) {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '')
  let out = ''
  if (clean.length % 4 === 0) {
    for (let i = 0; i < clean.length; i += 4) out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16))
  } else {
    for (let i = 0; i + 1 < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16))
  }
  return out
}

function extractPdfTextOps(content) {
  const out = []
  const blockRe = /BT([\s\S]*?)ET/g
  let block
  let matched = false
  while ((block = blockRe.exec(content))) {
    matched = true
    const body = block[1]
    const tokRe = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|T\*|Td|TD|Tj|TJ|'/g
    let tok
    let line = ''
    while ((tok = tokRe.exec(body))) {
      const t = tok[0]
      if (t === 'Td' || t === 'TD' || t === 'T*' || t === "'") {
        if (line.trim()) out.push(line.trim())
        line = ''
      } else if (t.startsWith('(')) line += decodePdfLiteral(t.slice(1, -1))
      else if (t.startsWith('<')) line += decodePdfHex(t.slice(1, -1))
    }
    if (line.trim()) out.push(line.trim())
  }
  if (!matched) {
    const re = /\((?:\\.|[^\\()])*\)/g
    let m
    while ((m = re.exec(content))) out.push(decodePdfLiteral(m[0].slice(1, -1)))
  }
  return out.join('\n')
}

function looksLikeText(s) {
  if (!s || s.length < 20) return false
  const good = (s.match(/[\u4e00-\u9fa5A-Za-z0-9，。、；：！？（）《》""''.,;:!?()\-—\s]/g) || []).length
  return good / s.length > 0.75
}

function extractPdf(buf) {
  const latin = buf.toString('latin1')
  const chunks = []
  const re = /stream\r?\n/g
  let m
  while ((m = re.exec(latin))) {
    const start = m.index + m[0].length
    const dictStart = latin.lastIndexOf('obj', m.index)
    const dict = latin.slice(dictStart > 0 ? dictStart : 0, m.index)
    const lm = /\/Length\s+(\d+)/.exec(dict)
    const end = lm ? start + parseInt(lm[1], 10) : latin.indexOf('endstream', start)
    if (!(end > start) || end > buf.length) continue

    const raw = buf.subarray(start, end)
    let content = null
    for (const fn of [inflateSync, inflateRawSync]) {
      try { content = fn(raw).toString('latin1'); break } catch { /* 换下一种 */ }
    }
    if (content && content.includes('BT')) chunks.push(extractPdfTextOps(content))
    re.lastIndex = end
  }

  const text = chunks.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!looksLikeText(text)) {
    throw new Error(
      '未能从 PDF 提取到可靠文本（可能是扫描件、字体子集需要 ToUnicode 映射、或内容流在对象流里）。'
      + '建议改用 .md / .txt / .docx，或把 PDF 文字复制出来另存为 .md。',
    )
  }
  return text
}

/* ══════════ 统一入口 ══════════ */

/** 支持的文件后缀 */
export const SUPPORTED = ['.md', '.markdown', '.txt', '.docx', '.pdf']

/**
 * 从文件路径提取纯文本。
 * @param {string} filePath
 * @returns {{ text: string, kind: string }}
 */
export function extractText(filePath) {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.doc') && !lower.endsWith('.docx')) {
    throw new Error('不支持老版 .doc，请另存为 .docx 或 .md/.txt')
  }
  const buf = readFileSync(filePath)
  if (buf.length === 0) throw new Error('文件为空')

  if (lower.endsWith('.docx')) return { text: extractDocx(buf), kind: 'docx' }
  if (lower.endsWith('.pdf')) return { text: extractPdf(buf), kind: 'pdf' }

  const text = buf.toString('utf8')
  if (!text.trim()) throw new Error('文件内容为空')
  return { text, kind: 'text' }
}
