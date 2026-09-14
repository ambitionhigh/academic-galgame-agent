// 教材文本提取（纯浏览器端，零依赖）
//   .md / .txt / .markdown / text/*  → 直接读
//   .docx                            → 解 ZIP 取 word/document.xml 再剥标签
//   .pdf                             → 尽力而为：解压 stream + 抽取文本操作符
//
// 只用浏览器原生 API（DecompressionStream / TextDecoder），不需要任何第三方库。

/** 用浏览器原生 API 解压（format: 'deflate' = zlib 包装，'deflate-raw' = 裸 deflate） */
async function inflateWith(bytes, format) {
  const ds = new DecompressionStream(format)
  const stream = new Blob([bytes]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** ZIP 条目用裸 deflate */
const inflateRaw = (bytes) => inflateWith(bytes, 'deflate-raw')

const HTML_ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'", '&#39;': "'" }

function unescapeXml(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#39);/g, (m) => HTML_ENTITIES[m] || m)
}

/* ══════════ .docx ══════════ */

function docxXmlToText(xml) {
  return unescapeXml(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 从 zip 字节里取出指定条目的内容（支持 stored / deflate） */
async function unzipEntry(buf, dv, wantName) {
  // 找 End of Central Directory（从尾部往前扫，最多 64KB 注释）
  let eocd = -1
  const floor = Math.max(0, buf.length - 66000)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP/.docx（找不到中央目录结尾）')

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
    // 兼容某些工具（如 PowerShell Compress-Archive）把条目名写成反斜杠的情况
    const name = new TextDecoder('utf-8').decode(buf.subarray(off + 46, off + 46 + nameLen)).replace(/\\/g, '/')

    if (name === wantName) {
      if (localOff + 30 > buf.length) throw new Error('.docx 结构异常（本地头越界）')
      const lNameLen = dv.getUint16(localOff + 26, true)
      const lExtraLen = dv.getUint16(localOff + 28, true)
      const dataStart = localOff + 30 + lNameLen + lExtraLen
      const raw = buf.subarray(dataStart, dataStart + compSize)
      if (method === 8) return await inflateRaw(raw)
      if (method === 0) return raw
      throw new Error(`.docx 使用了不支持的压缩方式（method ${method}）`)
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`.docx 里没有找到 ${wantName}`)
}

async function extractDocx(file) {
  const buf = new Uint8Array(await file.arrayBuffer())
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const xmlBytes = await unzipEntry(buf, dv, 'word/document.xml')
  const xml = new TextDecoder('utf-8').decode(xmlBytes)
  const text = docxXmlToText(xml)
  if (!text) throw new Error('.docx 里没有提取到文字（可能是纯图片文档）')
  return text
}

/* ══════════ .pdf（尽力而为） ══════════ */

/** 解码 PDF 字面量字符串里的转义 */
function decodePdfLiteral(s) {
  return s
    .replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c] || c))
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\\r?\n/g, '')
}

/** 解码 <hex> 字符串：4 的倍数按 2 字节 CID（中文 PDF 常见）猜，否则按单字节 */
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

/** 从 PDF 内容流里抽取文本操作符 */
function extractPdfTextOps(content) {
  const out = []
  // 逐 BT…ET 文本块处理
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
      } else if (t.startsWith('(')) {
        line += decodePdfLiteral(t.slice(1, -1))
      } else if (t.startsWith('<')) {
        line += decodePdfHex(t.slice(1, -1))
      }
    }
    if (line.trim()) out.push(line.trim())
  }
  if (!matched) {
    // 没有 BT/ET（少见），退化为直接抓字符串
    const re = /\((?:\\.|[^\\()])*\)/g
    let m
    while ((m = re.exec(content))) out.push(decodePdfLiteral(m[0].slice(1, -1)))
  }
  return out.join('\n')
}

/** 判断提取结果是否像人话（避免把乱码喂给模型） */
function looksLikeText(s) {
  if (!s || s.length < 20) return false
  const good = (s.match(/[\u4e00-\u9fa5A-Za-z0-9，。、；：！？（）《》""''.,;:!?()\-—\s]/g) || []).length
  return good / s.length > 0.75
}

async function extractPdf(file) {
  const buf = new Uint8Array(await file.arrayBuffer())
  const latin = new TextDecoder('latin1').decode(buf)
  const chunks = []

  const re = /stream\r?\n/g
  let m
  while ((m = re.exec(latin))) {
    const start = m.index + m[0].length

    // 优先用字典里的 /Length 精确定位（比 indexOf('endstream') 可靠得多）
    const dictStart = latin.lastIndexOf('obj', m.index)
    const dict = latin.slice(dictStart > 0 ? dictStart : 0, m.index)
    const lm = /\/Length\s+(\d+)/.exec(dict)
    const end = lm ? start + parseInt(lm[1], 10) : latin.indexOf('endstream', start)
    if (!(end > start) || end > buf.length) { continue }

    const raw = buf.subarray(start, end)
    let content = null
    // PDF 的 FlateDecode 用 zlib 包装；少数实现用裸 deflate
    for (const fmt of ['deflate', 'deflate-raw']) {
      try {
        content = new TextDecoder('latin1').decode(await inflateWith(raw, fmt))
        break
      } catch { /* 换下一种 */ }
    }
    if (content && content.includes('BT')) chunks.push(extractPdfTextOps(content))
    re.lastIndex = end
  }

  const text = chunks.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

  if (!looksLikeText(text)) {
    throw new Error(
      '未能从 PDF 提取到可靠文本。常见原因：扫描件/图片型 PDF、字体子集需要 ToUnicode 映射、内容流在对象流里。' +
      '请改用 .md / .txt / .docx，或把 PDF 里的文字复制出来另存为 .md。',
    )
  }
  return text
}

/* ══════════ 统一入口 ══════════ */

/** 支持的文件后缀（用于 UI 的 accept 与拖拽校验） */
export const ACCEPT = '.md,.markdown,.txt,.docx,.pdf,text/plain,text/markdown'

/**
 * 从 File 提取纯文本。
 * @param {File} file
 * @returns {Promise<{text:string, kind:string}>}
 */
export async function extractText(file) {
  const name = String(file.name || '').toLowerCase()
  const type = String(file.type || '')

  if (name.endsWith('.docx')) return { text: await extractDocx(file), kind: 'docx' }
  if (name.endsWith('.pdf')) return { text: await extractPdf(file), kind: 'pdf' }
  if (name.endsWith('.doc')) {
    throw new Error('不支持老版 .doc，请另存为 .docx 或 .md/.txt')
  }
  // 其余当纯文本（含 .md/.txt 与 text/*）
  const text = await file.text()
  if (!text.trim()) throw new Error('文件内容为空')
  return { text, kind: type.startsWith('text/') ? 'text' : 'text' }
}
