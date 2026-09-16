#!/usr/bin/env node
// 下载打包所需的 Python wheel（纯 Node，零依赖）
//
// 为什么不用 pip 自己下：这台机器上 pip 连 PyPI 会卡死，而 Node 的 fetch 完全正常。
// 所以用 Node 把 wheel 拉到本地，再让 pip 走 --no-index 离线安装。
//
// 用法：
//   node fetch-wheels.js                  # 下到 desktop/.wheels
//   node fetch-wheels.js --out <目录>
//   node fetch-wheels.js --pkg pyinstaller --pkg altgraph
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// PyInstaller 在 Windows 上的运行期依赖（setuptools / packaging / pywin32 本机已有）
const DEFAULT_PKGS = [
  'pyinstaller',
  'pyinstaller-hooks-contrib',
  'altgraph',
  'pefile',
  'pywin32-ctypes',
]

function parseArgs(argv) {
  const out = { pkg: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out' && argv[i + 1]) { out.out = argv[++i]; continue }
    if (a === '--pkg' && argv[i + 1]) { out.pkg.push(argv[++i]); continue }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const OUT = resolve(args.out || join(HERE, '..', '.wheels'))
const PKGS = args.pkg.length ? args.pkg : DEFAULT_PKGS

/** 给一个 wheel 文件名打分；不兼容的返回 -1 */
function scoreWheel(name) {
  if (!name.endsWith('.whl')) return -1
  const n = name.toLowerCase()
  if (/(macosx|manylinux|musllinux|linux_|i686|aarch64|arm64|ppc64|s390x|32\.exe)/.test(n)) return -1
  let score = 0
  if (n.includes('win_amd64')) score += 100
  else if (n.includes('none-any')) score += 50
  else return -1                                  // 其它平台轮子一律不要
  if (n.includes('cp314')) score += 20            // 正好是 3.14
  else if (/cp3\d\d/.test(n) && !n.includes('abi3')) score -= 100  // 别的 Python 版本，排除
  if (n.includes('py3-none') || n.includes('py2.py3-none')) score += 10
  return score
}

async function getJson(url) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 30000)
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

async function download(url, dest) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 180000)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const buf = Buffer.from(await r.arrayBuffer())
    writeFileSync(dest, buf)
    return buf.length
  } finally {
    clearTimeout(t)
  }
}

async function pick(pkg) {
  const meta = await getJson(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`)
  const releases = meta.releases || {}
  const versions = Object.keys(releases)
  // 按版本号从新到旧排（忽略预发布）
  const ranked = versions
    .filter((v) => !/[a-zA-Z]/.test(v))
    .sort((a, b) => {
      const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pb[i] || 0) - (pa[i] || 0)
        if (d) return d
      }
      return 0
    })
  for (const v of ranked) {
    const files = (releases[v] || []).filter((f) => f.packagetype === 'bdist_wheel' || f.filename.endsWith('.whl'))
    const best = files
      .map((f) => ({ f, s: scoreWheel(f.filename) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)[0]
    if (best) return { version: v, file: best.f }
  }
  throw new Error(`${pkg}: 没找到适用于 Windows / Python 3.14 的 wheel`)
}

mkdirSync(OUT, { recursive: true })
console.log(`目标目录：${OUT}\n`)

const results = []
for (const pkg of PKGS) {
  try {
    const { version, file } = await pick(pkg)
    const dest = join(OUT, file.filename)
    if (existsSync(dest)) {
      console.log(`  ✓ ${pkg.padEnd(26)} ${version.padEnd(12)} 已存在`)
      results.push({ pkg, version, file: file.filename, bytes: 0, cached: true })
      continue
    }
    const bytes = await download(file.url, dest)
    console.log(`  ✓ ${pkg.padEnd(26)} ${version.padEnd(12)} ${(bytes / 1024).toFixed(0)} KB`)
    results.push({ pkg, version, file: file.filename, bytes })
  } catch (e) {
    console.log(`  ✗ ${pkg.padEnd(26)} ${e.message}`)
    results.push({ pkg, error: e.message })
  }
}

const failed = results.filter((r) => r.error)
console.log(`\n完成：${results.length - failed.length}/${results.length}`)
if (failed.length) {
  console.log('失败：' + failed.map((f) => f.pkg).join(', '))
  process.exitCode = 1
}
