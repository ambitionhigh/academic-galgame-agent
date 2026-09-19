/**
 * 视觉读页 —— 让「有眼睛的模型」直接看扫描书的页面。
 *
 * 为什么需要这一路：
 *   扫描件之所以读不出字，是因为整页就是**一张图**。与其费劲做 OCR，
 *   不如把页面图丢给多模态模型，让它把图上的字念出来 —— 一页一两秒，
 *   不需要下载任何模型，配一个地址就能用（也可以完全本地，见下）。
 *
 * 零依赖怎么拿到页面图：
 *   不渲染 PDF（那要 pdfium 这类原生库）。扫描件的每一页在 PDF 里本来就是
 *   一个**嵌进去的整页位图**，我们直接从 PDF 对象结构里把它抠出来：
 *     · /DCTDecode  —— 流里就是一张现成的 JPEG，原样拿来用
 *     · /FlateDecode —— 解压得到裸像素，用 Node 自带的 zlib 编成 PNG
 *   这条路对「扫描件」（也正是唯一需要它的场景）几乎总是有效。
 *
 * 和 MinerU 的分工：
 *   · 视觉模型：配好就能用，零模型下载，快。可以完全本地（Ollama）。
 *   · MinerU  ：全本地离线，但要装 800 MB 模型，慢。
 *   默认顺序是「先视觉、后 MinerU」。
 *
 * ⚠️ 隐私边界：走远程 API 时**页面图片会被发到模型厂商**。
 *    想完全不外传就用本地模型：GALGAME_VISION_BASE=http://127.0.0.1:11434/v1
 */

import zlib from 'node:zlib'

import { findObjects, dictOf, streamOf, matchAll } from './pdfbytes.js'

export const DEFAULT_MAX_PAGES = Number(process.env.GALGAME_VISION_MAX_PAGES || 40)
export const PAGE_TIMEOUT = Number(process.env.GALGAME_VISION_TIMEOUT || 180) * 1000

/** 小于这个尺寸的图是装饰/logo，不是正文页面 */
const MIN_PAGE_IMAGE_PIXELS = 250000

/** 让模型只吐正文，别加解释 —— 抽取不是聊天 */
export const DEFAULT_PROMPT = [
  '把这张书页图片里的文字**完整、逐字**转写成纯文本，保持原有段落顺序。',
  '要求：',
  '· 只输出正文，不要任何解释、不要加「以下是」「这张图片」之类的话；',
  '· 不要翻译、不要改写、不要总结；',
  '· 看不清的字用 □ 代替，不要猜；',
  '· 如果整页没有文字（比如纯插图页），只回一个空行。',
].join('\n')

/**
 * 读开关。**每次现读**，不要缓存成模块常量 ——
 * 缓存的话测试改不动它，用户在跑起来之后再设环境变量也不生效。
 */
export function visionMode() {
  return (process.env.GALGAME_VISION || 'auto').trim().toLowerCase()
}

export function visionConfig() {
  return {
    base: (process.env.GALGAME_VISION_BASE || '').trim().replace(/\/+$/, ''),
    model: (process.env.GALGAME_VISION_MODEL || '').trim(),
    key: (process.env.GALGAME_VISION_KEY || '').trim(),
    maxPages: DEFAULT_MAX_PAGES,
    timeout: PAGE_TIMEOUT,
    prompt: process.env.GALGAME_VISION_PROMPT || DEFAULT_PROMPT,
  }
}

export function visionConfigured() {
  const c = visionConfig()
  return Boolean(c.base && c.model)
}

/** 这一路能不能用：开关允许 + 地址模型都配了（图像抠取是纯 JS，永远可用）。 */
export function visionAvailable() {
  if (['0', 'off', 'false', 'no', 'none'].includes(visionMode())) return false
  return visionConfigured()
}

export function visionStatus() {
  const c = visionConfig()
  return {
    configured: visionConfigured(),
    renderer: true,               // 纯 JS，不依赖任何外部渲染器
    ready: visionAvailable(),
    base: c.base || null,
    model: c.model || null,
    extractor: 'embedded-image',
    maxPages: c.maxPages,
  }
}

/* ══════════════════════════════════════════════════════════════════
   PDF → 页面图片（纯 JS，零依赖）
   ══════════════════════════════════════════════════════════════════ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32 (buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** 裸像素 → PNG（Node 自带 zlib 就够，不用任何图像库） */
export function encodePng (width, height, channels, raw) {
  const colorType = channels === 1 ? 0 : 2
  const stride = width * channels
  const rows = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    rows[y * (stride + 1)] = 0                     // filter: none
    raw.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8                                      // bit depth
  ihdr[9] = colorType
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(rows, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 从 PDF 对象里抠页面图；返回 [{w,h,mime,data}]，按页序。 */
export function pageImages (buf, maxPages = DEFAULT_MAX_PAGES) {
  const s = buf.toString('latin1')
  const objs = findObjects(s)
  if (!objs.size) return { pages: [], note: '这个 PDF 没有可解析的对象结构' }

  const pages = []
  for (const [num, body] of objs) {
    const d = dictOf(body)
    if (/\/Type\s*\/Page\b/.test(d) && !/\/Type\s*\/Pages\b/.test(d)) pages.push([num, d])
  }
  pages.sort((a, b) => a[0] - b[0])
  if (!pages.length) return { pages: [], note: '没找到页面对象' }

  const out = []
  let unsupported = 0
  let tooSmall = 0

  for (const [, d] of pages) {
    if (out.length >= maxPages) break
    for (const num of xobjectNums(objs, d)) {
      const body = objs.get(num) || ''
      // streamOf 给的是 latin1 字符串（PDF 对象是当文本扫的），
      // 但图像流里全是二进制字节 —— 必须先按 latin1 还原成 Buffer，
      // 否则 base64 编码和 zlib 解压都会把 >127 的字节搞坏。
      const img = imageFromObject(dictOf(body), Buffer.from(streamOf(body), 'latin1'))
      if (!img) continue
      if (img.unsupported) { unsupported++; continue }
      if (img.w * img.h < MIN_PAGE_IMAGE_PIXELS) { tooSmall++; continue }
      out.push(img)
    }
  }

  let note = ''
  if (!out.length && unsupported) {
    note = '这本 PDF 的页面图是 ' + unsupported + ' 张 CCITT/JPEG2000 编码的（浏览器和模型都不认这两种），读不了'
  } else if (!out.length && tooSmall) {
    note = '只找到 ' + tooSmall + ' 张小图（logo/装饰），没有整页的正文图'
  }
  return { pages: out, note }
}

function xobjectNums (objs, pageDict) {
  let res = ''
  const rm = pageDict.match(/\/Resources\s*(\d+)\s+\d+\s+R/)
  if (rm) res = dictOf(objs.get(parseInt(rm[1], 10)) || '')
  else {
    const rm2 = pageDict.match(/\/Resources\s*<</)
    if (rm2) res = dictOf(pageDict.slice(rm2.index))
  }
  if (!res) return []
  let xo = ''
  const xm = res.match(/\/XObject\s*<<([\s\S]*?)>>/)
  if (xm) xo = xm[1]
  else {
    const xr = res.match(/\/XObject\s+(\d+)\s+\d+\s+R/)
    if (xr) xo = dictOf(objs.get(parseInt(xr[1], 10)) || '')
  }
  const nums = []
  for (const [, , num] of matchAll(xo, /\/([A-Za-z0-9#_.\-]+)\s+(\d+)\s+\d+\s+R/g)) {
    nums.push(parseInt(num, 10))
  }
  return nums
}

/** 一个图像 XObject → {w,h,mime,data}；认不出来返回 null 或 {unsupported:true} */
function imageFromObject (dict, rawStream) {
  if (!/\/Subtype\s*\/Image/.test(dict)) return null
  const w = parseInt((dict.match(/\/Width\s+(\d+)/) || [])[1] || '0', 10)
  const h = parseInt((dict.match(/\/Height\s+(\d+)/) || [])[1] || '0', 10)
  if (!w || !h) return null

  const filters = ((dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/) || [])[1] || '')
  if (/DCTDecode/.test(filters)) {
    // 流里就是一张现成的 JPEG —— 一个字节都不用解
    return { w, h, mime: 'image/jpeg', data: rawStream }
  }
  if (/CCITTFaxDecode|JPXDecode|JBIG2Decode/.test(filters)) {
    return { unsupported: true, w, h }
  }
  if (/FlateDecode/.test(filters)) {
    let raw
    try { raw = zlib.inflateSync(rawStream) } catch { try { raw = zlib.inflateRawSync(rawStream) } catch { return null } }
    const bpc = parseInt((dict.match(/\/BitsPerComponent\s+(\d+)/) || [])[1] || '8', 10)
    if (bpc !== 8) return { unsupported: true, w, h }          // 1/2/4 位的要靠解码器，跳过

    // 颜色空间要**精确**匹配：曾经写成 /DeviceGray|G/，而 "/DeviceRGB" 里也有个 G，
    // 结果把 RGB 当灰度编，图只用了 1/3 的像素、模型读出来是花的。
    const cs = ((dict.match(/\/ColorSpace\s*(\/\w+)/) || [])[1] || '/DeviceRGB')
    const channels = /^\/(DeviceGray|G)$/.test(cs) ? 1 : /^\/(DeviceCMYK|CMYK)$/.test(cs) ? 4 : 3
    if (channels === 4) return { unsupported: true, w, h }      // CMYK 要先转色，跳过

    raw = applyPredictor(raw, dict, w, channels)
    if (raw.length < w * h * channels) return null
    const pixels = raw.subarray(0, w * h * channels)
    return { w, h, mime: 'image/png', data: encodePng(w, h, channels, pixels) }
  }
  return null
}

/**
 * 还原 PNG/TIFF 预测器（PNG predictors）。
 *
 * 很多 PDF 里的 Flate 图像不是裸像素，而是「每行前面加一个 filter type 字节」的
 * PNG 预测编码。不还原的话拿到的就是一堆差分值 —— 编出来的 PNG 能打开，
 * 但内容全是噪声，模型只会读出一堆乱码。这个坑很隐蔽，必须处理。
 */
export function applyPredictor (raw, dict, width, channels) {
  const dp = dict.match(/\/DecodeParms\s*<<([\s\S]*?)>>/)
  if (!dp) return raw
  const pred = parseInt((dp[1].match(/\/Predictor\s+(\d+)/) || [])[1] || '1', 10)
  if (!(pred >= 10)) return raw                    // 1 = 没用预测器
  const colors = parseInt((dp[1].match(/\/Colors\s+(\d+)/) || [])[1] || String(channels), 10)
  const bpc = parseInt((dp[1].match(/\/BitsPerComponent\s+(\d+)/) || [])[1] || '8', 10)
  const columns = parseInt((dp[1].match(/\/Columns\s+(\d+)/) || [])[1] || String(width), 10)

  const bpp = Math.max(1, Math.ceil(colors * bpc / 8))      // 每像素字节数（预测的最小单位）
  const rowLen = Math.ceil(colors * bpc * columns / 8)
  const rows = Math.floor(raw.length / (rowLen + 1))
  if (!rows || !rowLen) return raw

  const out = Buffer.alloc(rowLen * rows)
  let prev = Buffer.alloc(rowLen)
  for (let r = 0; r < rows; r++) {
    const ft = raw[r * (rowLen + 1)]
    const row = Buffer.from(raw.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1)))
    if (ft === 1 || ft === 2 || ft === 3 || ft === 4) {
      for (let j = 0; j < rowLen; j++) {
        const a = j >= bpp ? row[j - bpp] : 0
        const b = prev[j]
        const c = j >= bpp ? prev[j - bpp] : 0
        let add = 0
        if (ft === 1) add = a
        else if (ft === 2) add = b
        else if (ft === 3) add = (a + b) >> 1
        else {
          const p = a + b - c
          const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c)
          add = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
        }
        row[j] = (row[j] + add) & 0xff
      }
    }
    row.copy(out, r * rowLen)
    prev = row
  }
  return out
}

/* ══════════════════════════════════════════════════════════════════
   调用模型
   ══════════════════════════════════════════════════════════════════ */

/** 把一页图的文字念出来。 */
export async function transcribePage (img, cfg = visionConfig(), timeoutMs) {
  const b64 = img.data.toString('base64')
  const body = {
    model: cfg.model,
    temperature: 0,
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: cfg.prompt },
        { type: 'image_url', image_url: { url: `data:${img.mime};base64,${b64}` } },
      ],
    }],
  }
  const headers = { 'Content-Type': 'application/json' }
  if (cfg.key) headers.Authorization = 'Bearer ' + cfg.key

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs || cfg.timeout)
  try {
    const res = await fetch(cfg.base + '/chat/completions', {
      method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    let j
    try { j = JSON.parse(text) } catch { throw new Error('返回的不是 JSON：' + text.slice(0, 120)) }
    const msg = j.choices && j.choices[0] && j.choices[0].message
    return ((msg && msg.content) || '').trim()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 读整本 PDF。返回 {text, pages, note}。
 * onProgress(i, n, info) 用来给界面报进度。
 */
export async function readPdf (buf, filename = '', onProgress) {
  const cfg = visionConfig()
  if (!visionAvailable()) return { text: '', pages: 0, note: '没配视觉模型' }

  const { pages, note } = pageImages(buf, cfg.maxPages)
  if (!pages.length) return { text: '', pages: 0, note: note || '这本书里没有可读的页面图' }

  const chunks = []
  let failed = 0
  for (let i = 0; i < pages.length; i++) {
    const img = pages[i]
    if (onProgress) onProgress(i + 1, pages.length, `${img.w}×${img.h}`)
    try {
      const t = await transcribePage(img, cfg)
      if (t) chunks.push(t)
    } catch (e) {
      failed++
      if (onProgress) onProgress(i + 1, pages.length, '失败：' + e.message.slice(0, 60))
      if (failed >= 3 && !chunks.length) {
        return { text: '', pages: pages.length, note: '连续几页都读失败：' + e.message.slice(0, 120) }
      }
    }
  }

  const text = chunks.join('\n\n')
  let out = ''
  if (failed) out = `${failed}/${pages.length} 页读取失败`
  return { text, pages: pages.length, note: out }
}

/* ══════════════════════════════════════════════════════════════════
   下面是给 textract.js 复用的 PDF 底层件（同一份实现，别各写一套）
   ══════════════════════════════════════════════════════════════════ */
