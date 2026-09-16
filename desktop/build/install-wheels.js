#!/usr/bin/env node
// 把 .wheels 里的 wheel 解包成可直接 import 的目录（纯 Node，零依赖）
//
// wheel 本质就是 zip，安装 = 解压 + 把 *.data/{purelib,platlib,scripts} 摆到正确位置。
// 这样完全不需要 pip（这台机器上 pip 被沙箱挡着，装不动）。
//
// 用法：
//   node install-wheels.js                 # 解到 desktop/.pylibs
//   node install-wheels.js --out <目录>
//
// 之后这样用：
//   set PYTHONPATH=<.pylibs 的绝对路径>
//   python -m PyInstaller ...
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) out.out = argv[++i]
    if (argv[i] === '--wheels' && argv[i + 1]) out.wheels = argv[++i]
  }
  return out
}
const args = parseArgs(process.argv.slice(2))
const WHEELS = resolve(args.wheels || join(HERE, '..', '.wheels'))
const OUT = resolve(args.out || join(HERE, '..', '.pylibs'))

/* ══════════ 极简 ZIP 读取 ══════════ */

function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error('不是有效的 zip（找不到 EOCD）')
}

function listEntries(buf) {
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

function readEntry(buf, entry) {
  const p = entry.localOff
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`本地头损坏：${entry.name}`)
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const start = p + 30 + nameLen + extraLen
  const data = buf.subarray(start, start + entry.compSize)
  if (entry.method === 0) return Buffer.from(data)
  if (entry.method === 8) return inflateRawSync(data)
  throw new Error(`不支持的压缩方式 ${entry.method}：${entry.name}`)
}

/* ══════════ 解包 ══════════ */

function write(rel, data) {
  const dest = join(OUT, rel)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, data)
}

mkdirSync(OUT, { recursive: true })
const wheels = readdirSync(WHEELS).filter((f) => f.endsWith('.whl'))
if (!wheels.length) {
  console.error(`没找到 wheel：${WHEELS}\n先跑 node build/fetch-wheels.js`)
  process.exit(1)
}

let files = 0
for (const w of wheels) {
  const buf = readFileSync(join(WHEELS, w))
  const entries = listEntries(buf)
  let transplanted = 0
  for (const e of entries) {
    if (e.name.endsWith('/')) continue
    const data = readEntry(buf, e)
    const m = e.name.match(/^([^/]+?)\.data\/(purelib|platlib|scripts|data)\/(.+)$/)
    if (m) {
      const kind = m[2]
      const rest = m[3]
      if (kind === 'purelib' || kind === 'platlib') write(rest, data)
      else if (kind === 'scripts') write(join('Scripts', rest), data)
      else write(join('_data', rest), data)
      transplanted++
      continue
    }
    write(e.name, data)
    files++
  }
  console.log(`  ✓ ${w}  → ${entries.length} 项${transplanted ? `（含 ${transplanted} 项 .data 迁移）` : ''}`)
}

console.log(`\n解包完成：${wheels.length} 个 wheel → ${OUT}`)
console.log(`验证：set PYTHONPATH=${OUT} && python -c "import PyInstaller;print(PyInstaller.__version__)"`)
