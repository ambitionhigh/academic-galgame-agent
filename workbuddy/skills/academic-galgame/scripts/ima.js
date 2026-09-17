// ima 知识库接入（Node 侧，零依赖）
//
// 凭证只存本地，绝不进仓库：
//   ${GALGAME_HOME:-~/.workbuddy/academic-galgame}/credentials.json
//   环境变量优先：IMA_API_KEY / IMA_CLIENT_ID / IMA_KB_MAP
//
// 接口（实测）：POST https://ima.qq.com/openapi/wiki/v1/...
//   get_addable_knowledge_base_list { limit }            → data.addable_knowledge_base_list[{ id, name }]
//   search_knowledge { knowledge_base_id, query, limit } → data.info_list[{ media_id, title }]
//   get_media_info { media_id }                          → data.url_info.url（带签名的正文地址）
import { readCredsFile, saveCreds, mask, HOME, CRED_FILE } from './creds.js'

const HOST = 'ima.qq.com'
const BASE = '/openapi/wiki/v1'
const MAX_CHARS = 1200
const MAX_SECTIONS = 3

export { HOME, CRED_FILE, saveCreds }

/* ══════════ 凭证 ══════════ */

/** 生效凭证：环境变量 > 本地文件 */
export function loadCreds() {
  const f = readCredsFile()
  let kbMap = f.kbMap || {}
  if (process.env.IMA_KB_MAP) {
    try { kbMap = JSON.parse(process.env.IMA_KB_MAP) } catch { /* 用文件里的 */ }
  }
  return {
    imaApiKey: process.env.IMA_API_KEY || f.imaApiKey || '',
    imaClientId: process.env.IMA_CLIENT_ID || f.imaClientId || '',
    kbMap,
  }
}

export function credsStatus() {
  const c = loadCreds()
  return {
    ok: true,
    file: CRED_FILE,
    configured: Boolean(c.imaApiKey && c.imaClientId),
    imaApiKey: mask(c.imaApiKey),
    imaClientId: mask(c.imaClientId),
    fromEnv: Boolean(process.env.IMA_API_KEY || process.env.IMA_CLIENT_ID),
    kbMap: c.kbMap,
    boundSubjects: Object.keys(c.kbMap),
  }
}

/* ══════════ 接口调用 ══════════ */

async function imaPost(path, body, creds) {
  const res = await fetch(`https://${HOST}${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'ima-openapi-clientid': creds.imaClientId,
      'ima-openapi-apikey': creds.imaApiKey,
    },
    body: JSON.stringify(body || {}),
  })
  return await res.json()
}

function requireCreds(creds) {
  if (!creds.imaApiKey || !creds.imaClientId) {
    throw new Error(`ima 未配置：先运行 ima config --key <API Key> --client-id <Client ID>（或设置环境变量 IMA_API_KEY / IMA_CLIENT_ID）`)
  }
}

/** 列出可用的知识库（名称 → ID） */
export async function listKbs() {
  const creds = loadCreds()
  requireCreds(creds)
  // 主接口可传 limit ≤ 50；兜底接口 limit 必须 ≤ 20
  let j = await imaPost('/get_addable_knowledge_base_list', { limit: 50 }, creds)
  if (j.code !== 0) j = await imaPost('/search_knowledge_base', { limit: 20 }, creds)
  if (j.code !== 0) throw new Error(`ima 返回 code ${j.code}：${j.msg || ''}`)

  const d = j.data || {}
  const raw = d.addable_knowledge_base_list || d.info_list || d.list || d.knowledge_base_items || d.items || (Array.isArray(d) ? d : [])
  const items = []
  for (const it of raw) {
    const id = it.knowledge_base_id || it.kb_id || it.id || it.base_id || ''
    const name = it.name || it.title || it.knowledge_base_name || '(未命名)'
    if (id) items.push({ id, name })
  }
  return { ok: items.length > 0, count: items.length, items }
}

/** 按名称或 ID 找知识库 */
export async function resolveKb(nameOrId) {
  const { items } = await listKbs()
  const hit = items.find((x) => x.id === nameOrId || x.name === nameOrId)
  if (!hit) {
    throw new Error(`没找到知识库「${nameOrId}」。可用：${items.map((x) => x.name).join(' / ') || '(空)'}`)
  }
  return hit
}

/* ══════════ 检索 ══════════ */

/**
 * 下载回来的东西是不是「书」的原始二进制（PDF / EPUB / zip / 图片…）。
 *
 * ima 的 get_media_info 给的是**原始文件**地址。往知识库里放的是 PDF/EPUB 时，
 * 拿到的就是几十 MB 二进制；当文本读只会得到 `%PDF-1.6 %äüöß...` 这种乱码。
 * 把乱码喂给模型等于让它读天书 —— 宁可如实说「读不了」。
 */
function binaryKind(buf) {
  const head = buf.subarray(0, 8).toString('latin1')
  if (head.startsWith('%PDF')) return 'PDF'
  if (head.startsWith('PK')) return '压缩包（EPUB/Word/Excel）'
  if (head.startsWith('\x89PNG') || head.startsWith('\xff\xd8\xff') || head.startsWith('GIF8')) return '图片'
  if (head.startsWith('RIFF')) return '音视频'
  if (head.startsWith('ID3')) return '音频'
  const probe = buf.subarray(0, 1024)
  for (let i = 0; i < probe.length; i++) if (probe[i] === 0) return '二进制文件'
  return ''
}

/**
 * 在该学科绑定的 ima 知识库里检索真实片段。
 * 未配置 / 未绑定 → 返回 null（交给上层回落到本地教材库）
 */
export async function retrieveIma(query, subject) {
  const creds = loadCreds()
  if (!creds.imaApiKey || !creds.imaClientId) return null

  const kbId = creds.kbMap[subject] || Object.values(creds.kbMap)[0] || ''
  if (!kbId) return null

  const sj = await imaPost('/search_knowledge', { knowledge_base_id: kbId, query: String(query || ''), cursor: '' }, creds)
  if (sj.code !== 0) {
    return { ok: false, source: 'ima', items: [], error: `ima 检索失败 code ${sj.code}：${sj.msg || ''}` }
  }
  const hits = (sj.data && sj.data.info_list) || []
  const items = []
  let unreadable = 0
  for (const h of hits.slice(0, 2)) {
    const entry = { title: h.title, source: 'ima', subject: subject || '', content: '' }
    try {
      const mj = await imaPost('/get_media_info', { media_id: h.media_id }, creds)
      const url = mj && mj.data && mj.data.url_info && mj.data.url_info.url
      if (url) {
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
        const kind = binaryKind(buf)
        if (kind) {
          unreadable++
          entry.error = `这是 ${kind} 原始文件，要先抽出正文才能读`
        } else {
          entry.content = buf.toString('utf8').slice(0, MAX_CHARS)
        }
      }
    } catch (e) {
      entry.error = String((e && e.message) || e)
    }
    items.push(entry)
  }
  const usable = items.filter((x) => x.content)
  if (!usable.length && unreadable) {
    return {
      ok: false, source: 'ima', count: hits.length, items: [],
      error: `知识库里的《${(items[0] && items[0].title) || '这本书'}》是 PDF/EPUB 原始文件，技能包还没做正文抽取`,
      hint: 'ima 自己的搜索只匹配书名，拿不到书里的内容。'
        + '要么把书转成 .md / .txt 再放进知识库，要么用带正文抽取的版本'
        + '（academic-galgame-agent 的 Python 版已实现：python/agent/textract.py + ima_index.py）。',
    }
  }
  return { ok: usable.length > 0, source: 'ima', count: hits.length, items: usable.slice(0, MAX_SECTIONS) }
}
