#!/usr/bin/env node
// 跨语言一致性检查：同一批文件，Node 版和 Python 版抽出的正文必须**逐字节相同**。
//
// 为什么需要它：正文抽取有两份实现（src/agent/textract.js 与 python/agent/textract.py），
// 一份改了另一份没改，就会出现「桌面版能读、Node 版读不了」这种最难查的问题。
// 把它当成回归测试跑。
//
// 用法：
//   node scripts/check-textract.js <放着一堆 .pdf/.epub/.docx 的目录>
//   node scripts/check-textract.js            # 默认读 GALGAME_TEXT_FIXTURES 环境变量
//
// 注意：两边的「同一个文件」要用**同一份字节**。这个脚本直接读目录，不下载任何东西。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractText } from '../src/agent/textract.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const dir = process.argv[2] || process.env.GALGAME_TEXT_FIXTURES || ''
if (!dir || !existsSync(dir)) {
  console.error('用法：node scripts/check-textract.js <文件目录>')
  console.error('（放进几个真实的 .pdf / .epub / .docx 再跑，用来对比两版实现）')
  process.exit(2)
}

const files = readdirSync(dir)
  .filter((f) => /\.(pdf|epub|docx|txt|html?|md)$/i.test(f))
  .sort()
if (!files.length) {
  console.error(`目录里没有可比对的文件：${dir}`)
  process.exit(2)
}

console.log(`\n  跨语言一致性检查（Node ↔ Python）`)
console.log(`  样本目录：${dir}`)
console.log(`  文件数  ：${files.length}\n`)

// ── Node 侧结果 ──────────────────────────────────────────────
const jsResult = {}
for (const f of files) {
  const buf = readFileSync(join(dir, f))
  let r
  try {
    r = extractText(buf, f)
  } catch (e) {
    r = { text: '', kind: 'ERROR', note: String((e && e.message) || e) }
  }
  jsResult[f] = {
    len: r.text.length,
    kind: r.kind,
    sha: createHash('sha1').update(r.text, 'utf8').digest('hex').slice(0, 12),
  }
}

// ── Python 侧结果：写文件而不是走管道 ────────────────────────
// （受限环境里管道 stdio 会被拒；写临时文件两种环境都能跑）
const tmp = mkdtempSync(join(tmpdir(), 'textract-check-'))
const pyOut = join(tmp, 'py.json')
const pyScript = join(tmp, 'py_side.py')

writeFileSync(pyScript, `
import sys, os, json, hashlib
sys.path.insert(0, ${JSON.stringify(join(REPO, 'python'))})
from agent.textract import extract_text
d = ${JSON.stringify(dir)}
out = {}
for f in sorted(os.listdir(d)):
    p = os.path.join(d, f)
    if not os.path.isfile(p): continue
    if not f.lower().endswith(('.pdf', '.epub', '.docx', '.txt', '.html', '.htm', '.md')): continue
    try:
        t, k, n = extract_text(open(p, 'rb').read(), f)
        out[f] = {'len': len(t), 'kind': k, 'sha': hashlib.sha1(t.encode('utf-8')).hexdigest()[:12]}
    except Exception as e:
        out[f] = {'len': 0, 'kind': 'ERROR', 'sha': '', 'note': str(e)}
open(${JSON.stringify(pyOut)}, 'w', encoding='utf-8').write(json.dumps(out, ensure_ascii=False))
`, 'utf8')

const run = spawnSync('python', [pyScript], { stdio: 'ignore' })
if (run.error || !existsSync(pyOut)) {
  console.error('  ✗ 跑不动 Python 侧（需要本机有 python）：', (run.error && run.error.message) || '没产出结果文件')
  process.exit(1)
}
const pyResult = JSON.parse(readFileSync(pyOut, 'utf8'))

// ── 比对 ─────────────────────────────────────────────────────
let pass = 0
const bad = []
for (const f of files) {
  const a = jsResult[f]
  const b = pyResult[f]
  if (!b) { bad.push([f, 'Python 侧没有结果', JSON.stringify(a), '-']); continue }
  const same = a.len === b.len && a.sha === b.sha && a.kind === b.kind
  if (same) { console.log(`  ✓ ${f}  ${a.kind}  ${a.len} 字  ${a.sha}`); pass++ }
  else {
    console.log(`  ✗ ${f}`)
    console.log(`      Node   : ${a.kind}  ${a.len} 字  ${a.sha}`)
    console.log(`      Python : ${b.kind}  ${b.len} 字  ${b.sha}`)
    bad.push([f, '不一致', `${a.kind}/${a.len}/${a.sha}`, `${b.kind}/${b.len}/${b.sha}`])
  }
}

console.log(`\n  结果：${pass}/${files.length} 一致`)
if (bad.length) {
  console.log('  ⚠️ 两版实现已经跑偏，请把 src/agent/textract.js 与 python/agent/textract.py 对齐。\n')
  process.exit(1)
}
console.log('  ✓ 两版实现完全一致\n')
