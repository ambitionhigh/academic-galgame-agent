#!/usr/bin/env node
// 从鲸鱼娘立绘生成 Windows 图标（.ico）—— 纯 Node，零依赖
//
// 做三件事：
//   ① 解码 PNG（8 位 RGBA、非隔行）→ 原始像素
//   ② 裁剪出人物（默认裁头部，小尺寸图标才看得清）→ 缩放到 256/128/64/48/32/16
//   ③ 把多尺寸 PNG 打包进一个 .ico（Vista 以后都支持 PNG 载荷）
//
// 用法：
//   node make-icon.js                                  # 默认：think.png 裁头部 → 鲸鱼娘.ico
//   node make-icon.js --src idle.png --crop 55,20,150,150 --out 鲸鱼娘.ico
//   node make-icon.js --full                           # 不裁剪，用整张立绘
import { readFileSync, writeFileSync } from 'node:fs'
import { inflateSync, deflateSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const SPRITES = join(REPO, 'src', 'web', 'assets', 'whale-girl')

/* ══════════ 参数 ══════════ */

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const n = argv[i + 1]
      if (n !== undefined && !n.startsWith('--')) { out[k] = n; i++ } else out[k] = true
    } else out._.push(a)
  }
  return out
}

const a = parseArgs(process.argv.slice(2))
const SRC = join(SPRITES, typeof a.src === 'string' ? a.src : 'think.png')
const OUT = resolve(typeof a.out === 'string' ? a.out : join(HERE, '鲸鱼娘.ico'))
const SIZES = (typeof a.sizes === 'string' ? a.sizes : '256,128,64,48,32,16')
  .split(',').map((s) => Number(s.trim())).filter((n) => n > 0 && n <= 256)

// 默认裁头部：从 256×256 立绘里取 (56,18) 起 150×150 —— 脸和呆毛都在，小图标也认得出
const CROP = a.full ? null : (typeof a.crop === 'string'
  ? a.crop.split(',').map(Number)
  : [56, 18, 150, 150])

/* ══════════ PNG 解码（8 位 RGBA，非隔行） ══════════ */

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件')
  let off = 8
  let w = 0, h = 0, colorType = 0, bitDepth = 0, interlace = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]; interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`只支持 8 位色深，实际是 ${bitDepth}`)
  if (interlace !== 0) throw new Error('不支持隔行（Adam7）PNG')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`不支持的 colorType ${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const px = Buffer.alloc(w * h * 4)
  const line = Buffer.alloc(stride)
  const prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[p++]
    raw.copy(line, 0, p, p + stride); p += stride
    unfilter(filter, line, prev, channels)
    for (let x = 0; x < w; x++) {
      const s = x * channels
      const d = (y * w + x) * 4
      if (channels === 4) { px[d] = line[s]; px[d + 1] = line[s + 1]; px[d + 2] = line[s + 2]; px[d + 3] = line[s + 3] }
      else if (channels === 3) { px[d] = line[s]; px[d + 1] = line[s + 1]; px[d + 2] = line[s + 2]; px[d + 3] = 255 }
      else if (channels === 1) { px[d] = px[d + 1] = px[d + 2] = line[s]; px[d + 3] = 255 }
      else { px[d] = px[d + 1] = px[d + 2] = line[s]; px[d + 3] = line[s + 1] }
    }
    line.copy(prev)
  }
  return { w, h, px }
}

function unfilter(type, line, prev, bpp) {
  const n = line.length
  if (type === 0) return
  for (let i = 0; i < n; i++) {
    const x = line[i]
    const A = i >= bpp ? line[i - bpp] : 0
    const B = prev[i]
    const C = i >= bpp ? prev[i - bpp] : 0
    let v
    if (type === 1) v = x + A
    else if (type === 2) v = x + B
    else if (type === 3) v = x + ((A + B) >> 1)
    else if (type === 4) v = x + paeth(A, B, C)
    else throw new Error(`未知过滤器 ${type}`)
    line[i] = v & 0xff
  }
}
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
}

/* ══════════ 裁剪 + 缩放（面积平均，质量足够做图标） ══════════ */

function crop(img, [x0, y0, cw, ch]) {
  x0 = Math.max(0, Math.min(img.w - 1, x0 | 0))
  y0 = Math.max(0, Math.min(img.h - 1, y0 | 0))
  cw = Math.min(cw | 0, img.w - x0)
  ch = Math.min(ch | 0, img.h - y0)
  const out = Buffer.alloc(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    img.px.copy(out, y * cw * 4, ((y + y0) * img.w + x0) * 4, ((y + y0) * img.w + x0 + cw) * 4)
  }
  return { w: cw, h: ch, px: out }
}

function resize(img, size) {
  const out = Buffer.alloc(size * size * 4)
  const sx = img.w / size, sy = img.h / size
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy))
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx))
      let r = 0, g = 0, b = 0, al = 0, n = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const s = (yy * img.w + xx) * 4
          const alpha = img.px[s + 3] / 255
          // 按 alpha 加权，避免透明边缘把颜色拉黑
          r += img.px[s] * alpha; g += img.px[s + 1] * alpha; b += img.px[s + 2] * alpha
          al += alpha; n++
        }
      }
      const d = (y * size + x) * 4
      if (al > 0) {
        out[d] = Math.round(r / al); out[d + 1] = Math.round(g / al); out[d + 2] = Math.round(b / al)
      }
      out[d + 3] = Math.round((al / n) * 255)
    }
  }
  return { w: size, h: size, px: out }
}

/* ══════════ PNG 编码 ══════════ */

function crc32(buf) {
  let c, crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = c ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function encodePng(img) {
  const { w, h, px } = img
  const stride = w * 4
  const raw = Buffer.alloc(h * (stride + 1))
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0 // 过滤器 0（不过滤）
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ══════════ ICO 打包（PNG 载荷） ══════════ */

function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)               // reserved
  header.writeUInt16LE(1, 2)               // type = icon
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + images.length * 16
  for (const { size, png } of images) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size          // 256 记作 0
    e[1] = size >= 256 ? 0 : size
    e[2] = 0; e[3] = 0
    e.writeUInt16LE(1, 4)                  // planes
    e.writeUInt16LE(32, 6)                 // bit count
    e.writeUInt32LE(png.length, 8)         // 图像数据字节数
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += png.length
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

/* ══════════ 主流程 ══════════ */

const src = decodePng(readFileSync(SRC))
const body = CROP ? crop(src, CROP) : src
console.log(`源图   ${SRC}`)
console.log(`        ${src.w}×${src.h} → ${CROP ? `裁 (${CROP.join(', ')}) → ` : ''}${body.w}×${body.h}`)

const images = SIZES.map((size) => ({ size, png: encodePng(resize(body, size)) }))
writeFileSync(OUT, buildIco(images))
console.log(`图标   ${OUT}`)
console.log(`        尺寸 ${SIZES.join(' / ')}，共 ${(buildIco(images).length / 1024).toFixed(1)} KB`)
