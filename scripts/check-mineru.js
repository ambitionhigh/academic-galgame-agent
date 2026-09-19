#!/usr/bin/env node
// MinerU 适配器契约验证 —— Python 与 Node 两边都验。
//
// MinerU（github.com/opendatalab/MinerU）带 OCR，能读内置解析器啃不动的扫描版 PDF。
// 但它要装几 GB 模型，所以做成**可选**：没装就完全不参与；装了才在必要时当救援。
//
// 真装 MinerU 成本很高，所以这里用一个「假 mineru」来验证**契约**：
//   ① 能不能探测到 CLI
//   ② GALGAME_MINERU=0 时是否完全不参与
//   ③ auto 模式：扫描件读不出来 → 是否请它救援、JSON 是否解析正确
//   ④ auto 模式：文字版 PDF 是否**不惊动**它（省时间）
//   ⑤ always 模式：是否优先用它
//   ⑥ **绝不能传 --remote**（那会把用户资料上传到别人服务器）
//
// 用法：node scripts/check-mineru.js

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const PYDIR = join(REPO, 'python')
const WORK = join(REPO, '.tmp', 'mineru-stub')
const ARGV_LOG = join(WORK, 'argv.log')
const STUB = join(WORK, 'mineru.bat')
const SCANNED = join(WORK, 'scanned.pdf')

// ── 搭假 CLI ──────────────────────────────────────────────
mkdirSync(WORK, { recursive: true })
writeFileSync(join(WORK, 'mineru_stub.py'), `
import sys, os, json
# 故意跟随控制台代码页（不强制 UTF-8），用来验证适配器有没有替我们强制
with open(os.environ['MINERU_ARGV_LOG'], 'a', encoding='utf-8') as f:
    f.write(json.dumps(sys.argv[1:], ensure_ascii=False) + "\\n")
body = "# 扫描版书的正文\\n\\n" + "这一段是 MinerU 通过 OCR 抽出来的内容，内置解析器读不到它。" * 40
print(json.dumps({"parse": {"status": "done"}, "content": {"content": body}}, ensure_ascii=False))
`, 'utf8')
writeFileSync(STUB, '@echo off\r\npython "%~dp0mineru_stub.py" %*\r\n', 'utf8')

// 一个「扫描版」PDF：有页面但没有任何文字内容
writeFileSync(SCANNED, Buffer.from(
  '%PDF-1.4\n'
  + '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n'
  + 'trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1'))

let bad = 0
const check = (label, ok, extra) => {
  console.log(`    ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) return ok
  return true
}
const fail = (ok) => { if (!ok) bad++ }

function readArgv() {
  try {
    return readFileSync(ARGV_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch { return [] }
}
const clearArgv = () => { try { rmSync(ARGV_LOG, { force: true }) } catch { /* ignore */ } }

// ── Python 侧：把结果写成文件（受限环境里管道 stdio 会被拒）────────
function pyRun(code, env, outFile) {
  const script = join(WORK, 'py_side.py')
  writeFileSync(script, `
import sys, json, io
sys.path.insert(0, ${JSON.stringify(PYDIR)})
buf = io.StringIO()
_stdout = sys.stdout
sys.stdout = buf
try:
${code.split('\n').map((l) => '    ' + l).join('\n')}
finally:
    sys.stdout = _stdout
open(${JSON.stringify(outFile)}, 'w', encoding='utf-8').write(buf.getvalue())
`, 'utf8')
  const r = spawnSync('python', [script], {
    stdio: 'ignore',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...env },
  })
  if (r.error) return `__ERROR__ ${r.error.message}`
  try { return readFileSync(outFile, 'utf8').trim() } catch { return '' }
}

const ENV_BASE = { MINERU_CMD: STUB, MINERU_ARGV_LOG: ARGV_LOG, GALGAME_MINERU: '' }

/** 起一个干净的 node 进程跑一段代码，结果写到文件再读回来
 *  （不用管道：受限环境里 Node 捕获子进程输出会 EPERM） */
function nodeRun(code, env) {
  const outFile = join(WORK, 'node-out.txt')
  try { rmSync(outFile, { force: true }) } catch { /* ignore */ }
  // ⚠️ Windows 上动态 import() 只认 file:// URL，直接给 D:\... 会报
  //    ERR_UNSUPPORTED_ESM_URL_SCHEME
  const modUrl = pathToFileURL(resolve(REPO, 'src/agent/textract.js')).href
  writeFileSync(join(WORK, 'node_side.mjs'), `
import { writeFileSync } from 'node:fs'
const m = await import(${JSON.stringify(modUrl)})
const fs = await import('node:fs')
${code}
`, 'utf8')
  spawnSync(process.execPath, [join(WORK, 'node_side.mjs')], { stdio: 'ignore', env: { ...process.env, ...env } })
  try { return readFileSync(outFile, 'utf8') } catch { return '' }
}

console.log('\n  MinerU 适配器契约验证（Python 与 Node 两边）')
console.log('  ' + '─'.repeat(66))

// ══════════ Node 侧 ══════════
console.log('\n  ▸ Node 侧（src/agent/textract.js）')
const NODE_ENV = { MINERU_CMD: STUB, MINERU_ARGV_LOG: ARGV_LOG }
{
  const SCAN = `const r = m.extractText(fs.readFileSync(${JSON.stringify(SCANNED)}), 'scanned.pdf')`
  const BOOK = `const r = m.extractText(fs.readFileSync('D:/deepseek harness/.tmp/books/book1_pdf.pdf'), 'book1_pdf.pdf')`
  const out = (expr) => `writeFileSync(${JSON.stringify(join(WORK, 'node-out.txt'))}, ${expr})`

  // ① 探测
  let r = nodeRun(`${out("m.mineruAvailable() + '|' + m.mineruCommand()")}`, { ...NODE_ENV, GALGAME_MINERU: '' })
  fail(check('探测到 CLI', r.startsWith('true|'), r))

  // ② 关掉
  clearArgv()
  r = nodeRun(`${out('m.mineruAvailable() + "|" + (() => { ' + SCAN + '; return r.kind + "|" + r.text.length })()')}`,
    { ...NODE_ENV, GALGAME_MINERU: '0' })
  fail(check('GALGAME_MINERU=0 → 完全不参与', r.startsWith('false|pdf-scanned|0'), r))
  fail(check('GALGAME_MINERU=0 → 没调用过假 CLI', readArgv().length === 0))

  // ③ auto：扫描件救援
  clearArgv()
  r = nodeRun(`${out('(() => { ' + SCAN + '; return r.kind + "|" + r.text.length })()')}`,
    { ...NODE_ENV, GALGAME_MINERU: 'auto' })
  let argv = readArgv().flat()
  fail(check('扫描件 → MinerU 救援成功', r.startsWith('pdf+mineru|') && !r.endsWith('|0'), r))
  fail(check('确实调用了假 CLI', argv.length > 0))
  fail(check('**没有传 --remote**（隐私边界）', !argv.includes('--remote'), argv.slice(0, 7).join(' ')))
  fail(check('用了 --json', argv.includes('--json')))
  fail(check('**带了档位且默认 basic**',
    argv.includes('--tier') && argv[argv.indexOf('--tier') + 1] === 'basic',
    argv.slice(-3).join(' ')))
  fail(check('请求了全部页面', argv.includes('all')))
  fail(check('**带了档位且默认 basic**（不传的话 MinerU 会走 standard，白下几 GB 的 VLM）',
    argv.includes('--tier') && argv[argv.indexOf('--tier') + 1] === 'basic',
    argv.slice(-3).join(' ')))

  // ④ auto：文字版不惊动它
  clearArgv()
  r = nodeRun(`${out('(() => { ' + BOOK + '; return r.kind + "|" + r.text.length })()')}`,
    { ...NODE_ENV, GALGAME_MINERU: 'auto' })
  fail(check('文字版 PDF 走内置解析器', r.startsWith('pdf|'), r))
  fail(check('字数与基线一致（250407）', r.includes('250407'), r))
  fail(check('没调用 MinerU（省时间）', readArgv().length === 0))

  // ⑤ always
  clearArgv()
  r = nodeRun(`${out('(() => { ' + BOOK + '; return r.kind + "|" + r.text.length })()')}`,
    { ...NODE_ENV, GALGAME_MINERU: 'always' })
  fail(check('always 模式 → 优先用 MinerU', r.startsWith('pdf+mineru|'), r))
}

// ══════════ Python 侧 ══════════
console.log('\n  ▸ Python 侧（python/agent/textract.py）')
{
  const PY_BOOK = 'D:/deepseek harness/.tmp/books/book1_pdf.pdf'
  const pyOut = join(WORK, 'py-out.txt')

  // ① 探测
  let out = pyRun(`
from agent.textract import mineru_command, mineru_available
print(mineru_available(), mineru_command())`, { ...ENV_BASE }, pyOut)
  fail(check('探测到 CLI', out.trim().startsWith('True'), out.trim()))

  // ② 关掉
  clearArgv()
  out = pyRun(`
from agent.textract import extract_text, mineru_available
t, k, note = extract_text(open(${JSON.stringify(SCANNED)}, 'rb').read(), 'scanned.pdf')
print(mineru_available(), '|', k, '|', len(t))`, { ...ENV_BASE, GALGAME_MINERU: '0' }, pyOut)
  fail(check('GALGAME_MINERU=0 → 完全不参与', out.startsWith('False | pdf-scanned | 0'), out))
  fail(check('GALGAME_MINERU=0 → 没调用过假 CLI', readArgv().length === 0))

  // ③ auto：扫描件救援
  clearArgv()
  out = pyRun(`
from agent.textract import extract_text
t, k, note = extract_text(open(${JSON.stringify(SCANNED)}, 'rb').read(), 'scanned.pdf')
print(k, '|', len(t))`, { ...ENV_BASE }, pyOut)
  const argv = readArgv().flat()
  fail(check('扫描件 → MinerU 救援成功', out.startsWith('pdf+mineru |') && !out.endsWith('| 0'), out))
  fail(check('**没有传 --remote**（隐私边界）', !argv.includes('--remote'), argv.slice(0, 6).join(' ')))
  fail(check('用了 --json', argv.includes('--json')))
  fail(check('**带了档位且默认 basic**',
    argv.includes('--tier') && argv[argv.indexOf('--tier') + 1] === 'basic',
    argv.slice(-3).join(' ')))

  // ④ 文字版不惊动它
  clearArgv()
  out = pyRun(`
from agent.textract import extract_text
t, k, note = extract_text(open(${JSON.stringify(PY_BOOK)}, 'rb').read(), 'book1_pdf.pdf')
print(k, '|', len(t))`, { ...ENV_BASE }, pyOut)
  fail(check('文字版 PDF 走内置解析器', out.startsWith('pdf |'), out))
  fail(check('字数与基线一致（250407）', out.includes('250407'), out))
  fail(check('没调用 MinerU', readArgv().length === 0))

  // ⑤ always
  clearArgv()
  out = pyRun(`
from agent.textract import extract_text
t, k, note = extract_text(open(${JSON.stringify(PY_BOOK)}, 'rb').read(), 'book1_pdf.pdf')
print(k, '|', len(t))`, { ...ENV_BASE, GALGAME_MINERU: 'always' }, pyOut)
  fail(check('always 模式 → 优先用 MinerU', out.startsWith('pdf+mineru |'), out))
}

console.log('\n  ' + '─'.repeat(66))
console.log(bad ? `  ✗ 有 ${bad} 项不通过\n` : '  ✓ 适配器契约全部通过（两语言一致）\n')
process.exit(bad ? 1 : 0)
