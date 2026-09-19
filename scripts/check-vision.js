#!/usr/bin/env node
/**
 * 视觉读页的自检 —— **不需要联网、不需要模型、不需要任何真实书籍**。
 *
 * 这里测的是「能不能把 PDF 里的页面图正确地抠出来」这一段。
 * 为什么这段值得单独测：从 PDF 里抠图看起来是纯搬运，其实坑很多，
 * 而且**错了也不会报错** —— 编出来的 PNG 照样能打开，只是内容是花的，
 * 模型读出来就是乱码。开发时真踩过两个：
 *   · 颜色空间写成 /DeviceGray|G/，而 "/DeviceRGB" 里也有个 G
 *     → RGB 被当灰度，只用了 1/3 的像素
 *   · streamOf 返回的是 latin1 字符串，直接拿去 base64 / inflate
 *     → 所有 >127 的字节都被破坏
 * 这两个都不会抛异常，只会让结果悄悄变差。所以这里做**逐像素比对**。
 *
 * 用法：node scripts/check-vision.js
 */
import zlib from 'node:zlib'

const ROOT = new URL('../src/agent/', import.meta.url).href
const { encodePng, applyPredictor, pageImages, visionStatus } = await import(ROOT + 'visionread.js')

let pass = 0
let fail = 0
function check (name, ok, info = '') {
  if (ok) { pass++; console.log('  ✓ %s%s', name, info ? '   ' + info : '') }
  else { fail++; console.log('  ✗ %s%s', name, info ? '   ' + info : '') }
  return ok
}

/* ── 造一张有辨识度的测试图：每个像素都不一样（纯色会被压缩掩盖问题） ── */
function makeRgb (w, h) {
  const b = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      b[i] = (x * 7 + y * 13) & 0xff
      b[i + 1] = (x * 31 + y * 3) & 0xff
      b[i + 2] = (x ^ y) & 0xff
    }
  }
  return b
}
function makeGray (w, h) {
  const b = Buffer.alloc(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b[y * w + x] = (x * 5 + y * 11) & 0xff
  return b
}

/** 解开我们自己编的 PNG（固定 filter 0，所以解回来很直接） */
function decodeOwnPng (png) {
  let off = 8
  let w = 0; let h = 0; let colorType = 0
  const idat = []
  while (off < png.length) {
    const len = png.readUInt32BE(off)
    const type = png.subarray(off + 4, off + 8).toString('latin1')
    const data = png.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colorType = data[9] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  const channels = colorType === 0 ? 1 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const out = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) raw.copy(out, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  return { w, h, channels, pixels: out }
}

/** 用给定参数拼一个只有一个图像对象的极简 PDF */
function buildPdf ({ w, h, channels, filter, data, predictor = null }) {
  const colorSpace = channels === 1 ? '/DeviceGray' : '/DeviceRGB'
  let parms = ''
  if (predictor) {
    parms = ` /DecodeParms << /Predictor ${predictor} /Colors ${channels} /BitsPerComponent 8 /Columns ${w} >>`
  }
  const imgDict = `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} `
    + `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /${filter}${parms} /Length ${data.length} >>`
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] `
      + '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  const head = Buffer.from('%PDF-1.6\n', 'latin1')
  const parts = [head]
  const offs = []
  let pos = head.length
  for (let i = 0; i < objs.length; i++) {
    offs.push(pos)
    const b = Buffer.from(`${i + 1} 0 obj\n${objs[i]}\nendobj\n`, 'latin1')
    parts.push(b); pos += b.length
  }
  offs.push(pos)
  const imgObj = Buffer.concat([
    Buffer.from(`5 0 obj\n${imgDict}\nstream\n`, 'latin1'), data,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ])
  parts.push(imgObj); pos += imgObj.length
  const xref = pos
  let tail = `xref\n0 6\n0000000000 65535 f \n`
  for (const o of offs) tail += String(o).padStart(10, '0') + ' 00000 n \n'
  tail += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  parts.push(Buffer.from(tail, 'latin1'))
  return Buffer.concat(parts)
}

console.log('\n  视觉读页 · 自检（离线，不需要模型）')
console.log('  ' + '─'.repeat(68))

// 用真实页面量级的尺寸：pageImages 会把小图当 logo/装饰滤掉（阈值 25 万像素），
// 这里必须超过它，否则测的就不是「抠图」而是「过滤」了。
const W = 640
const H = 480

/* ① PNG 编码本身：结构 + 逐像素 */
{
  const src = makeRgb(W, H)
  const png = encodePng(W, H, 3, src)
  const sig = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const iend = png.subarray(png.length - 8, png.length - 4).toString('latin1') === 'IEND'
  check('① encodePng 结构合法（签名 + IEND）', sig && iend)

  const back = decodeOwnPng(png)
  check('① encodePng 逐像素可还原（RGB）',
    back.w === W && back.h === H && back.channels === 3 && back.pixels.equals(src),
    `${back.w}x${back.h} ch=${back.channels}`)
}

/* ② 灰度 PNG */
{
  const src = makeGray(W, H)
  const back = decodeOwnPng(encodePng(W, H, 1, src))
  check('② encodePng 逐像素可还原（灰度）',
    back.channels === 1 && back.pixels.equals(src), `ch=${back.channels}`)
}

/* ③ FlateDecode + DeviceRGB —— 就是踩过坑的那条分支 */
{
  const src = makeRgb(W, H)
  const pdf = buildPdf({ w: W, h: H, channels: 3, filter: 'FlateDecode', data: zlib.deflateSync(src, { level: 6 }) })
  const { pages } = pageImages(pdf)
  const ok = pages.length === 1 && pages[0].mime === 'image/png' && pages[0].w === W && pages[0].h === H
  check('③ FlateDecode + /DeviceRGB 抠出一张整页 PNG', ok,
    pages.length ? `${pages[0].w}x${pages[0].h} ${pages[0].mime}` : '没抠到')

  if (ok) {
    const back = decodeOwnPng(pages[0].data)
    // 这条断言就是那个 G 的正则的照妖镜：认错颜色空间时通道数会变成 1，像素必然对不上
    check('③ 抠出来的像素与原始 RGB **完全一致**',
      back.channels === 3 && back.pixels.equals(src),
      `ch=${back.channels} 字节 ${back.pixels.length}/${src.length}`)
  }
}

/* ④ FlateDecode + DeviceGray */
{
  const src = makeGray(W, H)
  const pdf = buildPdf({ w: W, h: H, channels: 1, filter: 'FlateDecode', data: zlib.deflateSync(src, { level: 6 }) })
  const { pages } = pageImages(pdf)
  const back = pages.length ? decodeOwnPng(pages[0].data) : null
  check('④ FlateDecode + /DeviceGray 像素完全一致',
    Boolean(back) && back.channels === 1 && back.pixels.equals(src),
    back ? `ch=${back.channels}` : '没抠到')
}

/* ⑤ DCTDecode 原样透传（一个字节都不能动） */
{
  const fake = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x80, 0xfe, 0xff, 0xd9])
  const pdf = buildPdf({ w: W, h: H, channels: 3, filter: 'DCTDecode', data: fake })
  const { pages } = pageImages(pdf)
  check('⑤ DCTDecode 原样透传（字节零改动）',
    pages.length === 1 && pages[0].mime === 'image/jpeg' && pages[0].data.equals(fake),
    pages.length ? `${pages[0].data.length} 字节` : '没抠到')
}

/* ⑥ Predictor 还原 —— 不还原的话模型只会读到噪声 */
{
  const src = makeRgb(W, H)
  const stride = W * 3
  const predicted = Buffer.alloc((stride + 1) * H)
  for (let y = 0; y < H; y++) {
    predicted[y * (stride + 1)] = 2                       // filter type 2 = Up
    for (let j = 0; j < stride; j++) {
      const cur = src[y * stride + j]
      const up = y > 0 ? src[(y - 1) * stride + j] : 0
      predicted[y * (stride + 1) + 1 + j] = (cur - up) & 0xff
    }
  }
  const restored = applyPredictor(predicted, `/DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${W} >>`, W, 3)
  check('⑥ PNG Predictor 能还原成原始像素', restored.equals(src),
    `${restored.length} 字节`)

  // 走完整条路：带 Predictor 的 PDF 也要抠出正确的图
  const pdf = buildPdf({
    w: W, h: H, channels: 3, filter: 'FlateDecode',
    data: zlib.deflateSync(predicted, { level: 6 }), predictor: 15,
  })
  const { pages } = pageImages(pdf)
  const back = pages.length ? decodeOwnPng(pages[0].data) : null
  check('⑥ 带 Predictor 的 PDF 端到端像素一致',
    Boolean(back) && back.pixels.equals(src), back ? 'ok' : '没抠到')
}

/* ⑦ 没有预测器时不能乱动数据 */
{
  const src = makeRgb(W, H)
  const same = applyPredictor(src, '<< /Filter /FlateDecode >>', W, 3)
  check('⑦ 无 Predictor 时原样返回（不误伤）', same === src || same.equals(src))
}

/* ⑧ 状态自检不炸，且报的是真实的配置 */
{
  const st = visionStatus()
  check('⑧ visionStatus 能给出可读状态',
    typeof st.ready === 'boolean' && typeof st.configured === 'boolean',
    `ready=${st.ready} base=${st.base || '(未配)'}`)
}

console.log('\n  ' + '─'.repeat(68))
console.log(`  ${pass}/${pass + fail} 通过` + (fail ? `  ✗ ${fail} 个失败` : '  ✓ 全绿') + '\n')
process.exit(fail ? 1 : 0)
