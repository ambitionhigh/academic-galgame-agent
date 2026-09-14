// 教材库：让老师出题有「真实依据」，而不是凭空编
//
// 目录：${GALGAME_MATERIALS:-~/.workbuddy/academic-galgame/materials}/
//   index.json     教材元数据 [{ id, name, subject, chars, addedAt, source }]
//   <id>.txt       提取后的纯文本（导入时一次性提取，检索时直接读）
//
// 与 Web 版 corpus 一致的语义：
//   · 支持 .md / .txt / .docx / .pdf
//   · 可为每份教材指定学科；检索时取「该学科 + 通用（未指定）」
//   · 同名教材视为更新
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, extname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { extractText, SUPPORTED } from './extract.js'

export const DIR = process.env.GALGAME_MATERIALS
  || join(homedir(), '.workbuddy', 'academic-galgame', 'materials')
const indexPath = () => join(DIR, 'index.json')
const contentPath = (id) => join(DIR, id + '.txt')

function readIndex() {
  try {
    const j = JSON.parse(readFileSync(indexPath(), 'utf8'))
    return Array.isArray(j) ? j : []
  } catch { return [] }
}
function writeIndex(list) {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(indexPath(), JSON.stringify(list, null, 2), 'utf8')
}

/** 展开路径（支持传目录，递归收集受支持的文件） */
function collectFiles(p, depth = 0) {
  if (depth > 5) return []
  let st
  try { st = statSync(p) } catch { return [] }
  if (st.isFile()) return [p]
  const out = []
  for (const name of readdirSync(p)) {
    const full = join(p, name)
    try {
      if (statSync(full).isDirectory()) out.push(...collectFiles(full, depth + 1))
      else if (SUPPORTED.includes(extname(name).toLowerCase())) out.push(full)
    } catch { /* 跳过读不了的 */ }
  }
  return out
}

export function materialsDir() { return DIR }

export function listMaterials() {
  const index = readIndex()
  return {
    ok: true,
    dir: DIR,
    count: index.length,
    totalChars: index.reduce((n, x) => n + (x.chars || 0), 0),
    items: index.map((x) => ({ id: x.id, name: x.name, subject: x.subject || '', chars: x.chars })),
  }
}

/**
 * 导入教材（文件或目录）。同名视为更新。
 * @param {string} sourcePath 文件或目录路径
 * @param {string} [subject] 限定学科；留空 = 通用
 */
export function addMaterial(sourcePath, subject = '') {
  const abs = resolve(sourcePath)
  if (!existsSync(abs)) throw new Error(`路径不存在：${abs}`)
  const files = collectFiles(abs).filter((f) => SUPPORTED.includes(extname(f).toLowerCase()))
  if (files.length === 0) {
    throw new Error(`没有可导入的文件（支持 ${SUPPORTED.join(' / ')}）`)
  }

  mkdirSync(DIR, { recursive: true })
  const index = readIndex()
  const added = []
  const failed = []

  for (const file of files) {
    try {
      const { text, kind } = extractText(file)
      const name = basename(file)
      const at = index.findIndex((x) => x.name === name)
      const id = at >= 0 ? index[at].id : randomUUID()
      writeFileSync(contentPath(id), text, 'utf8')
      const item = { id, name, subject: subject || '', chars: text.length, kind, addedAt: Date.now(), source: file }
      if (at >= 0) index[at] = item
      else index.push(item)
      added.push({ id, name, subject: item.subject, chars: item.chars, kind })
    } catch (e) {
      failed.push({ file: basename(file), error: String((e && e.message) || e) })
    }
  }

  writeIndex(index)
  return { ok: added.length > 0, added, failed, total: index.length }
}

/** 给某份教材改学科（id 或 name 均可定位） */
export function setMaterialSubject(idOrName, subject = '') {
  const index = readIndex()
  const hit = index.find((x) => x.id === idOrName || x.name === idOrName)
  if (!hit) return { ok: false, error: `未找到教材：${idOrName}` }
  hit.subject = subject || ''
  writeIndex(index)
  return { ok: true, item: { id: hit.id, name: hit.name, subject: hit.subject, chars: hit.chars } }
}

export function removeMaterial(idOrName) {
  const index = readIndex()
  const hit = index.find((x) => x.id === idOrName || x.name === idOrName)
  if (!hit) return { ok: false, error: `未找到教材：${idOrName}` }
  try { rmSync(contentPath(hit.id), { force: true }) } catch { /* 忽略 */ }
  writeIndex(index.filter((x) => x.id !== hit.id))
  return { ok: true, removed: { id: hit.id, name: hit.name, subject: hit.subject || '' } }
}

export function clearMaterials() {
  const index = readIndex()
  for (const it of index) { try { rmSync(contentPath(it.id), { force: true }) } catch { /* 忽略 */ } }
  writeIndex([])
  return { ok: true, removed: index.length }
}

/* ══════════ 检索 ══════════ */

function tokenize(text) {
  const s = String(text || '').toLowerCase()
  const tokens = new Set()
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) tokens.add(w)
  const cjk = s.match(/[\u4e00-\u9fa5]/g) || []
  for (const ch of cjk) tokens.add(ch)
  for (let i = 0; i + 1 < cjk.length; i++) tokens.add(cjk[i] + cjk[i + 1])
  return [...tokens]
}

function splitSections(text) {
  const sections = []
  let current = { title: '正文', body: [] }
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) {
      if (current.body.length) sections.push(current)
      current = { title: m[2].trim(), body: [] }
    } else current.body.push(line)
  }
  if (current.body.length) sections.push(current)
  return sections
}

const MAX_SECTIONS = 3
const MAX_CHARS = 1200

/**
 * 在教材库里检索真实片段（给老师出题当依据）。
 * @param {string} query 查询词
 * @param {string} [subject] 学科；取「该学科 + 通用」，该学科无可用教材时如实返回空
 */
export function retrieve(query, subject) {
  const index = readIndex()
  if (index.length === 0) {
    return { ok: false, source: 'materials', total: 0, items: [], error: '教材库为空：先用 materials add 导入资料' }
  }

  let pool = index
  if (subject) {
    pool = index.filter((x) => !x.subject || x.subject === subject)
    if (pool.length === 0) {
      return {
        ok: false, source: 'materials', total: index.length, items: [],
        error: `该学科（${subject}）没有可用教材：库里所有教材都指定了别的学科，且没有「通用」教材`,
      }
    }
  }

  const tokens = tokenize(`${query || ''} ${subject || ''}`)
  if (tokens.length === 0) return { ok: false, source: 'materials', total: index.length, items: [], error: '查询为空' }

  const scored = []
  for (const it of pool) {
    let text
    try { text = readFileSync(contentPath(it.id), 'utf8') } catch { continue }
    for (const sec of splitSections(text)) {
      const body = sec.body.join('\n').trim()
      if (!body) continue
      const hay = `${sec.title}\n${body}`.toLowerCase()
      let score = 0
      for (const t of tokens) if (hay.includes(t)) score += t.length >= 2 ? 2 : 1
      if (score > 0) {
        scored.push({ score, title: sec.title, source: it.name, subject: it.subject || '', content: body.slice(0, MAX_CHARS) })
      }
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const items = scored.slice(0, MAX_SECTIONS).map(({ title, source, subject: s, content }) => ({ title, source, subject: s, content }))
  return {
    ok: items.length > 0,
    source: 'materials',
    total: index.length,
    count: items.length,
    items,
    hint: items.length === 0 ? '该查询在教材里没有命中，可换关键词，或先确认教材已导入' : undefined,
  }
}
