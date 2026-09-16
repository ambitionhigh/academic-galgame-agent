// 学术galgame · 前端逻辑（原生 ESM，无框架）
// 只通过 /api/* 与后端通信；立绘是 256×256 的水平精灵图，用 JS 逐帧播放。
//
// 【BYOK 自带密钥】用户填写的方舟 / ima 凭证只保存在本机 localStorage，
// 每次请求随 HTTP 头发送；服务端不存储。→ 每个人用自己的 Key 学自己的资料。
//
// 【教材】上传的 .md/.txt/.docx/.pdf 在浏览器端提取为纯文本，存进会话内存；
// 同时镜像到 IndexedDB，刷新或重开浏览器会自动恢复，不用重新上传。
import { extractText, ACCEPT } from './extract.js'
import { saveStoredCorpus, loadStoredCorpus, clearStoredCorpus } from './store.js'

const FRAME = 256
const CRED_KEY = 'academic-galgame-creds'
const MOOD_LABEL = {
  idle: '平静', joy: '开心', celebrate: '庆祝', disappointed: '失落',
  think: '思考', error: '惊慌', working: '努力', play: '玩耍',
}

const $ = (id) => document.getElementById(id)
const el = {
  mode: $('mode-badge'), level: $('level'), reset: $('reset-btn'), settings: $('settings-btn'),
  sprite: $('sprite'), mood: $('whale-mood'), tier: $('whale-tier'),
  hpText: $('hp-text'), hpBar: $('hp-bar'), favText: $('fav-text'), favBar: $('fav-bar'),
  subjects: $('subjects'), derived: $('derived'), log: $('log'),
  messages: $('messages'), form: $('chat-form'), input: $('chat-input'), send: $('send-btn'),
  battle: $('battle'), enemyName: $('enemy-name'), enemyTitle: $('enemy-title'),
  enemyHpText: $('enemy-hp-text'), enemyHpBar: $('enemy-hp-bar'),
  battleSubject: $('battle-subject'), battleDifficulty: $('battle-difficulty'),
  battleStreak: $('battle-streak'), retreat: $('retreat-btn'),
  modal: $('settings'), modalClose: $('settings-close'),
  cfgArkKey: $('cfg-ark-key'), cfgArkModel: $('cfg-ark-model'), cfgArkBase: $('cfg-ark-base'),
  cfgImaKey: $('cfg-ima-key'), cfgImaClientId: $('cfg-ima-client-id'), cfgImaKbMap: $('cfg-ima-kb-map'),
  cfgTestArk: $('cfg-test-ark'), cfgArkResult: $('cfg-ark-result'),
  cfgTestIma: $('cfg-test-ima'), cfgImaResult: $('cfg-ima-result'),
  cfgListKb: $('cfg-list-kb'), cfgKbRows: $('cfg-kb-rows'),
  cfgNewSubject: $('cfg-new-subject'), cfgAddSubject: $('cfg-add-subject'),
  cfgSubjectResult: $('cfg-subject-result'), cfgSubjectList: $('cfg-subject-list'),
  quickAddSubject: $('quick-add-subject'),
  cfgFiles: $('cfg-files'), cfgFileList: $('cfg-file-list'), cfgDrop: $('cfg-drop'),
  cfgClearFiles: $('cfg-clear-files'), cfgFileResult: $('cfg-file-result'),
  cfgSave: $('cfg-save'), cfgClear: $('cfg-clear'),
}

let busy = false
let spriteTimer = null
let currentSpriteKey = ''
let cachedSubjects = []   // 学科名，用于「按学科选知识库」
let cachedKbs = []        // 拉取到的 ima 知识库 [{id,name}]

/* ══════════ 凭证管理（BYOK）══════════ */
function loadCreds() {
  try { return JSON.parse(localStorage.getItem(CRED_KEY) || '{}') } catch { return {} }
}
function persistCreds(c) { localStorage.setItem(CRED_KEY, JSON.stringify(c)) }
function clearCreds() { localStorage.removeItem(CRED_KEY) }

/** 把凭证转成请求头；服务端只读不存。
 *  ⚠️ HTTP 头只能是 ASCII，而 KB 映射含中文（如 {"博弈论":"..."}），故做 percent-encoding。
 */
function credHeaders() {
  const c = loadCreds()
  const h = {}
  if (c.arkKey) h['x-ark-key'] = c.arkKey
  if (c.arkModel) h['x-ark-model'] = c.arkModel
  if (c.arkBase) h['x-ark-base'] = c.arkBase
  if (c.imaKey) h['x-ima-key'] = c.imaKey
  if (c.imaClientId) h['x-ima-client-id'] = c.imaClientId
  if (c.imaKbMap) h['x-ima-kb-map'] = encodeURIComponent(c.imaKbMap)
  return h
}

function readForm() {
  return {
    arkKey: el.cfgArkKey.value.trim(),
    arkModel: el.cfgArkModel.value.trim(),
    arkBase: el.cfgArkBase.value.trim(),
    imaKey: el.cfgImaKey.value.trim(),
    imaClientId: el.cfgImaClientId.value.trim(),
    imaKbMap: el.cfgImaKbMap.value.trim(),
  }
}

function fillForm(c) {
  el.cfgArkKey.value = c.arkKey || ''
  el.cfgArkModel.value = c.arkModel || ''
  el.cfgArkBase.value = c.arkBase || ''
  el.cfgImaKey.value = c.imaKey || ''
  el.cfgImaClientId.value = c.imaClientId || ''
  el.cfgImaKbMap.value = c.imaKbMap || ''
}

/* ── 立绘逐帧动画 ── */
function setSprite(key, frames = 1) {
  const k = key || 'idle'
  const n = Math.max(1, frames || 1)
  if (currentSpriteKey === `${k}:${n}` && spriteTimer) return
  currentSpriteKey = `${k}:${n}`
  el.sprite.style.backgroundImage = `url(./assets/whale-girl/${k}.png)`
  el.sprite.style.backgroundSize = `${n * FRAME}px ${FRAME}px`
  el.sprite.style.backgroundPositionX = '0px'
  if (spriteTimer) { clearInterval(spriteTimer); spriteTimer = null }
  if (n <= 1) return
  let f = 0
  spriteTimer = setInterval(() => {
    f = (f + 1) % n
    el.sprite.style.backgroundPositionX = `${-f * FRAME}px`
  }, 220)
}

/* ── 渲染属性面板 ── */
function renderState(s) {
  if (!s) return
  el.level.textContent = s.level
  el.hpText.textContent = `${s.player.hp} / ${s.player.maxHp}`
  el.hpBar.style.width = `${Math.round((s.player.hp / s.player.maxHp) * 100)}%`
  el.favText.textContent = `${s.whale.favorability}`
  el.favBar.style.width = `${s.whale.favorability}%`
  el.mood.textContent = MOOD_LABEL[s.mood] || MOOD_LABEL.idle
  el.tier.textContent = `好感档位 ${s.whaleTier}`
  setSprite(s.imageKey, s.imageFrames)

  el.subjects.innerHTML = ''
  for (const [name, v] of Object.entries(s.subjects)) {
    const q = v.quest || {}
    const li = document.createElement('li')
    li.className = `subject${v.conquered ? ' conquered' : ''}`
    li.innerHTML = `
      <div class="subject-head"><span class="name">${escapeHtml(name)}</span><span class="val">${v.mastery} / 100</span></div>
      <div class="bar"><i class="fill" style="width:${v.mastery}%"></i></div>
      <div class="chain">
        <span class="${q.lord ? 'done' : ''}">领主${q.lord ? '✓' : '✗'}</span>
        <span class="${q.general ? 'done' : ''}">魔将${q.general ? '✓' : '✗'}</span>
        <span class="${v.conquered ? 'done' : ''}">魔王${v.conquered ? '✓' : '✗'}</span>
      </div>`
    el.subjects.appendChild(li)
  }

  el.derived.innerHTML = ''
  for (const [name, val] of Object.entries(s.derived || {})) {
    const d = document.createElement('div')
    d.className = 'item'
    d.innerHTML = `<b>${val}</b><span>${escapeHtml(name)}</span>`
    el.derived.appendChild(d)
  }

  el.log.innerHTML = ''
  for (const entry of s.log || []) {
    const li = document.createElement('li')
    li.innerHTML = `${entry.subject ? `<span class="sub">[${escapeHtml(entry.subject)}]</span> ` : ''}${escapeHtml(entry.note)}`
    el.log.appendChild(li)
  }

  renderBattle(s.battle)
}

/* ── 渲染战斗浮层 ── */
function renderBattle(b) {
  if (!b) { el.battle.classList.add('hidden'); return }
  el.battle.classList.remove('hidden')
  el.enemyName.textContent = b.enemyName
  el.enemyTitle.textContent = b.enemyTitle
  if (b.enemyInfinite) {
    el.enemyHpText.textContent = '∞'
    el.enemyHpBar.style.width = '100%'
  } else {
    el.enemyHpText.textContent = `${b.enemyHp} / ${b.enemyMaxHp}`
    el.enemyHpBar.style.width = `${Math.round((b.enemyHp / Math.max(1, b.enemyMaxHp)) * 100)}%`
  }
  el.battleSubject.textContent = b.subject
  el.battleDifficulty.textContent = `难度 ${b.difficulty}`
  el.battleStreak.textContent = `连对 ${b.correctStreak}`
}

/* ── 消息 ── */
function pushMessage(who, text, cls = '') {
  const div = document.createElement('div')
  div.className = `msg ${cls}`
  div.innerHTML = `<span class="who">${escapeHtml(who)}</span><span class="text">${escapeHtml(text)}</span>`
  el.messages.appendChild(div)
  el.messages.scrollTop = el.messages.scrollHeight
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/* ── 与后端通信 ── */
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}), ...credHeaders() }
  const res = await fetch(path, { ...options, headers })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

function setModeBadge(h) {
  if (h.arkConfigured) {
    el.mode.textContent = `方舟 · ${h.model}${h.imaConfigured ? ' · ima' : ''}`
    el.mode.classList.remove('demo')
  } else {
    el.mode.textContent = 'DEMO 模式 · 点「⚙ 设置」填自己的 Key'
    el.mode.classList.add('demo')
  }
}

async function refreshHealth() {
  try { setModeBadge(await api('/api/health')) }
  catch { el.mode.textContent = '后端未连接' }
}

async function sendMessage(text) {
  if (busy) return
  busy = true
  el.send.disabled = true
  if (text) pushMessage('你', text, 'me')

  try {
    const data = await api('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text }),
    })
    if (data.reply) pushMessage('鲸鱼娘', data.reply)
    for (const ev of data.events || []) {
      if (ev.name === 'ag_apply' || String(ev.name).startsWith('ag_battle')) {
        pushMessage('系统', `结算：${ev.name}`, 'sys')
      }
    }
    if (data.state) renderState(data.state)
  } catch (err) {
    pushMessage('系统', `出错了：${err.message}`, 'sys')
  } finally {
    busy = false
    el.send.disabled = false
    el.input.focus()
  }
}

/* ── 设置面板 ── */
async function openSettings() {
  fillForm(loadCreds())
  el.cfgArkResult.textContent = ''
  el.cfgImaResult.textContent = ''
  el.cfgFileResult.textContent = ''
  cachedKbs = []
  renderKbRows()
  el.modal.classList.remove('hidden')
  await loadSubjects()
  renderKbRows()
  renderSubjectList()
  await loadCorpus()
}
function closeSettings() { el.modal.classList.add('hidden') }

function showResult(node, state, msg) {
  node.className = `test-result ${state}`
  node.textContent = msg
}

async function testArk() {
  const c = readForm()
  if (!c.arkKey || !c.arkModel) return showResult(el.cfgArkResult, 'err', '请先填写 API Key 与接入点 ID')
  showResult(el.cfgArkResult, 'pending', '测试中…（约 5~30 秒）')
  // 用表单里的值（尚未保存）测试
  const headers = { 'content-type': 'application/json', 'x-ark-key': c.arkKey, 'x-ark-model': c.arkModel }
  if (c.arkBase) headers['x-ark-base'] = c.arkBase
  try {
    const r = await fetch('/api/test', { method: 'POST', headers, body: JSON.stringify({ kind: 'ark' }) }).then((x) => x.json())
    if (r.ok) showResult(el.cfgArkResult, 'ok', `✓ 连接成功，模型返回：${r.reply}`)
    else showResult(el.cfgArkResult, 'err', `✗ ${r.error || '失败'}`)
  } catch (e) { showResult(el.cfgArkResult, 'err', `✗ ${e.message}`) }
}

async function testIma() {
  const c = readForm()
  if (!c.imaKey || !c.imaClientId) return showResult(el.cfgImaResult, 'err', '请先填写 ima API Key 与 Client ID')
  showResult(el.cfgImaResult, 'pending', '测试中…')
  const headers = { 'content-type': 'application/json', 'x-ima-key': c.imaKey, 'x-ima-client-id': c.imaClientId }
  if (c.imaKbMap) headers['x-ima-kb-map'] = encodeURIComponent(c.imaKbMap)
  try {
    const r = await fetch('/api/test', { method: 'POST', headers, body: JSON.stringify({ kind: 'ima' }) }).then((x) => x.json())
    if (r.ok) {
      showResult(el.cfgImaResult, 'ok', `✓ ${(r.detail && r.detail.note) || '连接正常'}`)
    } else {
      showResult(el.cfgImaResult, 'err', `✗ ${(r.detail && r.detail.error) || r.error || '失败'}`)
    }
  } catch (e) { showResult(el.cfgImaResult, 'err', `✗ ${e.message}`) }
}

/* ── ② 知识库：按名称选择，自动填 ID ── */
function currentKbMap() {
  try { return JSON.parse(el.cfgImaKbMap.value || '{}') } catch { return {} }
}
function writeKbMap(map) {
  el.cfgImaKbMap.value = Object.keys(map).length ? JSON.stringify(map) : ''
}

const KB_HINT = '<p class="kb-hint">点「拉取知识库列表」后，这里会列出你的知识库 —— '
  + '点右侧 <b>「+ 添加为学科」</b> 就能把某个知识库变成一门可学的学科（知识库绑定会自动填好）。</p>'

/** ② 知识库列表：每个知识库可一键「添加为学科」 */
function renderKbRows() {
  if (cachedKbs.length === 0) {
    el.cfgKbRows.innerHTML = KB_HINT
    return
  }
  el.cfgKbRows.innerHTML = ''
  for (const kb of cachedKbs) {
    const isSubject = cachedSubjects.includes(kb.name)
    const row = document.createElement('div')
    row.className = 'kb-item'
    row.innerHTML = `<span class="kb-name">${escapeHtml(kb.name)}</span>`
      + (isSubject
        ? '<span class="already">✓ 已是学科</span>'
        : `<button class="add-subject" data-name="${escapeHtml(kb.name)}" data-id="${escapeHtml(kb.id)}">+ 添加为学科</button>`)
    el.cfgKbRows.appendChild(row)
  }
  el.cfgKbRows.querySelectorAll('.add-subject').forEach((btn) => {
    btn.addEventListener('click', () => addSubject(btn.dataset.name, btn.dataset.id))
  })
}

/** ③ 我的学科：手动增删 + 逐个绑定知识库 */
function renderSubjectList() {
  const map = currentKbMap()
  el.cfgSubjectList.innerHTML = ''
  if (cachedSubjects.length === 0) {
    const li = document.createElement('li')
    li.innerHTML = '<span class="s-name" style="color:var(--muted)">还没有学科 —— 拉取知识库列表后点「+ 添加为学科」，或在上面手动添加</span>'
    el.cfgSubjectList.appendChild(li)
    return
  }
  for (const name of cachedSubjects) {
    const opts = ['<option value="">未绑定知识库</option>']
      .concat(cachedKbs.map((k) => `<option value="${escapeHtml(k.id)}"${map[name] === k.id ? ' selected' : ''}>${escapeHtml(k.name)}</option>`))
      .join('')
    const li = document.createElement('li')
    li.innerHTML = `<span class="s-name">${escapeHtml(name)}</span>
      <select data-name="${escapeHtml(name)}" title="把这个学科绑定到某个知识库">${opts}</select>
      <button class="s-del" data-name="${escapeHtml(name)}" title="移除该学科">×</button>`
    el.cfgSubjectList.appendChild(li)
  }
  el.cfgSubjectList.querySelectorAll('select').forEach((sel) => {
    sel.addEventListener('change', () => {
      const m = currentKbMap()
      if (sel.value) m[sel.dataset.name] = sel.value
      else delete m[sel.dataset.name]
      writeKbMap(m)
      persistCreds(readForm())
      showResult(el.cfgSubjectResult, 'ok', sel.value ? `「${sel.dataset.name}」已绑定知识库` : '已解除绑定')
    })
  })
  el.cfgSubjectList.querySelectorAll('.s-del').forEach((btn) => {
    btn.addEventListener('click', () => removeSubject(btn.dataset.name))
  })
}

/** 添加学科；给了 kbId 就同时绑定知识库（ima 驱动的核心操作） */
async function addSubject(name, kbId) {
  const n = String(name || '').trim()
  if (!n) return showResult(el.cfgSubjectResult, 'err', '请输入学科名')
  showResult(el.cfgSubjectResult, 'pending', `正在添加学科「${n}」…`)
  try {
    await api('/api/subjects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: n }),
    })
    if (kbId) {
      const m = currentKbMap()
      m[n] = kbId
      writeKbMap(m)
      persistCreds(readForm())
    }
    await loadSubjects()
    renderKbRows()
    renderSubjectList()
    await refreshHealth()
    try { renderState(await api('/api/state')) } catch { /* 忽略 */ }
    showResult(el.cfgSubjectResult, 'ok', `✓ 已添加学科「${n}」${kbId ? '并绑定知识库' : ''}`)
    el.cfgNewSubject.value = ''
  } catch (e) {
    showResult(el.cfgSubjectResult, 'err', `✗ ${e.message}`)
  }
}

async function removeSubject(name) {
  if (!confirm(`确定移除学科「${name}」吗？\n该学科的熟练度与任务链会一并删除。`)) return
  try {
    await api(`/api/subjects?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
    const m = currentKbMap()
    delete m[name]
    writeKbMap(m)
    persistCreds(readForm())
    await loadSubjects()
    renderKbRows()
    renderSubjectList()
    try { renderState(await api('/api/state')) } catch { /* 忽略 */ }
    showResult(el.cfgSubjectResult, 'ok', `已移除「${name}」`)
  } catch (e) {
    showResult(el.cfgSubjectResult, 'err', `✗ ${e.message}`)
  }
}

async function loadSubjects() {
  try { cachedSubjects = Object.keys((await api('/api/state')).subjects || {}) } catch { cachedSubjects = [] }
}

async function loadKbList() {
  const c = readForm()
  if (!c.imaKey || !c.imaClientId) return showResult(el.cfgImaResult, 'err', '请先填写 ima API Key 与 Client ID')
  showResult(el.cfgImaResult, 'pending', '正在拉取知识库列表…')
  try {
    const headers = { 'content-type': 'application/json', 'x-ima-key': c.imaKey, 'x-ima-client-id': c.imaClientId }
    const r = await fetch('/api/ima/kbs', { method: 'POST', headers, body: '{}' }).then((x) => x.json())
    if (!r.ok) return showResult(el.cfgImaResult, 'err', `✗ ${r.error || '拉取失败'}`)
    cachedKbs = r.items || []
    showResult(el.cfgImaResult, 'ok', `✓ 拉到 ${cachedKbs.length} 个知识库 —— 点「+ 添加为学科」即可开课`)
    renderKbRows()
    renderSubjectList()
  } catch (e) { showResult(el.cfgImaResult, 'err', `✗ ${e.message}`) }
}

/* ── ③ 我的教材（提取 → 会话内存 + 浏览器持久化）── */
let localCorpus = []   // 本地镜像 [{name, subject, text}]，用于持久化恢复

/** 用服务端返回的文件列表校对本地镜像（服务端为准，本地保留正文） */
function syncLocal(serverFiles) {
  const byName = new Map(localCorpus.map((f) => [f.name, f]))
  const next = []
  for (const sf of serverFiles || []) {
    const local = byName.get(sf.name)
    if (local) { local.subject = sf.subject || ''; next.push(local) }
  }
  localCorpus = next
  saveStoredCorpus(localCorpus).catch(() => {})
}

function renderFileList(files, totalChars) {
  el.cfgFileList.innerHTML = ''
  for (const f of files) {
    const opts = ['<option value="">通用（所有学科）</option>']
      .concat(cachedSubjects.map((s) => `<option value="${escapeHtml(s)}"${f.subject === s ? ' selected' : ''}>${escapeHtml(s)}</option>`))
      .join('')
    const li = document.createElement('li')
    li.innerHTML = `
      <span class="f-name"><b>${escapeHtml(f.name)}</b><span class="sz">${Number(f.chars || 0).toLocaleString()} 字</span></span>
      <select data-id="${escapeHtml(f.id)}" title="限定给某个学科；「通用」表示所有学科都可用">${opts}</select>
      <button class="f-del" data-id="${escapeHtml(f.id)}" title="删除这份教材">×</button>`
    el.cfgFileList.appendChild(li)
  }
  el.cfgFileList.querySelectorAll('select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const target = localCorpus.find((f) => f.name === sel.closest('li').querySelector('.f-name b').textContent)
      if (target) { target.subject = sel.value; saveStoredCorpus(localCorpus).catch(() => {}) }
      try {
        const r = await api('/api/corpus', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: sel.dataset.id, subject: sel.value }),
        })
        renderFileList(r.files || [], r.totalChars || 0)
        showResult(el.cfgFileResult, 'ok', sel.value ? `已限定为「${sel.value}」` : '已设为通用')
      } catch (e) { showResult(el.cfgFileResult, 'err', `✗ ${e.message}`) }
    })
  })
  el.cfgFileList.querySelectorAll('.f-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const r = await api(`/api/corpus?id=${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' })
        syncLocal(r.files || [])
        renderFileList(r.files || [], r.totalChars || 0)
        showResult(el.cfgFileResult, 'ok', '已删除该文件')
      } catch (e) { showResult(el.cfgFileResult, 'err', `✗ ${e.message}`) }
    })
  })
  if (files.length) {
    const li = document.createElement('li')
    li.className = 'total'
    li.innerHTML = `<span>合计 ${files.length} 个文件 · 已存本机浏览器（刷新不丢）</span><span class="sz">${Number(totalChars || 0).toLocaleString()} 字</span>`
    el.cfgFileList.appendChild(li)
  }
}

async function loadCorpus() {
  try {
    const r = await api('/api/corpus')
    renderFileList(r.files || [], r.totalChars || 0)
  } catch { /* 忽略 */ }
}

/** 把 [{name, text, subject}] 上传到服务端，并同步本地镜像 */
async function postCorpus(payload) {
  const r = await api('/api/corpus', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: payload }),
  })
  // 合并进本地镜像（同名覆盖），只保留服务端仍存在的
  const byName = new Map(localCorpus.map((f) => [f.name, f]))
  for (const p of payload) byName.set(p.name, { name: p.name, subject: p.subject || '', text: p.text })
  localCorpus = (r.files || []).map((sf) => byName.get(sf.name)).filter(Boolean)
  localCorpus.forEach((f, i) => { f.subject = (r.files[i] || {}).subject || '' })
  saveStoredCorpus(localCorpus).catch(() => {})
  return r
}

/** 从 File 列表提取文本并上传 */
async function uploadFiles(fileList) {
  const files = Array.from(fileList || [])
  if (!files.length) return
  showResult(el.cfgFileResult, 'pending', `正在解析 ${files.length} 个文件…`)
  const payload = []
  const errors = []
  for (const f of files) {
    try {
      const { text } = await extractText(f)
      payload.push({ name: f.name, text, subject: '' })
    } catch (e) {
      errors.push(`${f.name}：${e.message}`)
    }
  }
  if (!payload.length) {
    showResult(el.cfgFileResult, 'err', `✗ ${errors.join('；')}`)
    return
  }
  try {
    const r = await postCorpus(payload)
    renderFileList(r.files || [], r.totalChars || 0)
    const okMsg = `✓ 已载入 ${(r.files || []).length} 个文件${r.truncated ? '（超出上限已截断）' : ''}`
    showResult(el.cfgFileResult, errors.length ? 'err' : 'ok', errors.length ? `${okMsg}；失败：${errors.join('；')}` : okMsg)
    pushMessage('系统', `已载入你的教材（${(r.files || []).length} 个文件），老师会优先从这些资料出题。`, 'sys')
  } catch (e) { showResult(el.cfgFileResult, 'err', `✗ ${e.message}`) }
}

/** 启动时：若服务端本会话没有教材，而浏览器里存着，则自动恢复 */
async function restoreCorpus() {
  try {
    const stored = await loadStoredCorpus()
    if (!stored.length) return
    const server = await api('/api/corpus')
    if ((server.files || []).length > 0) { localCorpus = stored; syncLocal(server.files); return }
    localCorpus = stored
    const r = await postCorpus(stored.map((f) => ({ name: f.name, text: f.text, subject: f.subject || '' })))
    renderFileList(r.files || [], r.totalChars || 0)
    pushMessage('系统', `已从本机浏览器恢复 ${(r.files || []).length} 个教材文件。`, 'sys')
  } catch { /* 忽略 */ }
}

/* ── 拖拽上传：把 .md/.txt 拖进虚线框即可 ── */
function bindDropZone() {
  const zone = el.cfgDrop
  if (!zone) return
  const stop = (e) => { e.preventDefault(); e.stopPropagation() }
  for (const ev of ['dragenter', 'dragover']) {
    zone.addEventListener(ev, (e) => { stop(e); zone.classList.add('over') })
  }
  for (const ev of ['dragleave', 'dragend', 'drop']) {
    zone.addEventListener(ev, (e) => { stop(e); zone.classList.remove('over') })
  }
  zone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer
    const files = dt && dt.files ? Array.from(dt.files) : []
    if (files.length) uploadFiles(files)
  })
}
bindDropZone()

/* ── 事件绑定 ── */
el.form.addEventListener('submit', (e) => {
  e.preventDefault()
  const text = el.input.value.trim()
  if (!text) return
  el.input.value = ''
  sendMessage(text)
})

el.reset.addEventListener('click', async () => {
  if (!confirm('确定重置你的进度吗？（只影响你自己这份存档）')) return
  const data = await api('/api/reset', { method: 'POST' })
  el.messages.innerHTML = ''
  renderState(data.state)
  pushMessage('系统', '进度已重置。', 'sys')
})

el.retreat.addEventListener('click', () => sendMessage('撤退'))

el.settings.addEventListener('click', openSettings)
el.modalClose.addEventListener('click', closeSettings)
el.modal.addEventListener('click', (e) => { if (e.target === el.modal) closeSettings() })
el.cfgSave.addEventListener('click', async () => {
  persistCreds(readForm())
  closeSettings()
  await refreshHealth()
  pushMessage('系统', '凭证已保存到本机浏览器（服务端不存储）。', 'sys')
})
el.cfgClear.addEventListener('click', async () => {
  clearCreds()
  fillForm({})
  showResult(el.cfgArkResult, '', '')
  showResult(el.cfgImaResult, '', '')
  await refreshHealth()
  pushMessage('系统', '已清空本机凭证，回到 DEMO 模式。', 'sys')
})
el.cfgTestArk.addEventListener('click', testArk)
el.cfgTestIma.addEventListener('click', testIma)
el.cfgListKb.addEventListener('click', loadKbList)
el.cfgAddSubject.addEventListener('click', () => addSubject(el.cfgNewSubject.value))
el.cfgNewSubject.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addSubject(el.cfgNewSubject.value) }
})
if (el.quickAddSubject) {
  el.quickAddSubject.addEventListener('click', async () => {
    const name = prompt('新学科名（建议与你的 ima 知识库同名）：')
    if (!name) return
    try {
      await api('/api/subjects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      cachedSubjects = Object.keys((await api('/api/state')).subjects || {})
      renderState(await api('/api/state'))
      pushMessage('系统', `已添加学科「${name.trim()}」，可以开始教学了。`, 'sys')
    } catch (e) {
      pushMessage('系统', `添加学科失败：${e.message}`, 'sys')
    }
  })
}
el.cfgFiles.addEventListener('change', (e) => uploadFiles(e.target.files))
el.cfgClearFiles.addEventListener('click', async () => {
  try {
    await api('/api/corpus', { method: 'DELETE' })
    localCorpus = []
    await clearStoredCorpus().catch(() => {})
    renderFileList([], 0)
    el.cfgFiles.value = ''
    showResult(el.cfgFileResult, 'ok', '已清空我的教材（含浏览器本地副本）')
  } catch (e) { showResult(el.cfgFileResult, 'err', `✗ ${e.message}`) }
})

/* ── 启动 ── */
async function boot() {
  // 文件选择器接受的后缀与 extract.js 保持同一真源
  if (el.cfgFiles) el.cfgFiles.setAttribute('accept', ACCEPT)

  // 深链优先：先开面板，不被后面的网络/存储操作阻塞
  const wantSettings = location.hash === '#settings'
  if (wantSettings) openSettings()

  await refreshHealth()
  try { renderState(await api('/api/state')) } catch { /* 忽略 */ }

  // 教材：从浏览器本地副本恢复（若本会话服务端还没有）；失败或超时都不影响使用
  await restoreCorpus()

  if (!wantSettings) {
    const c = loadCreds()
    if (!c.arkKey) {
      pushMessage('系统', '尚未配置大模型：点右上角「⚙ 设置」填入你自己的火山方舟 Key，即可用真模型教学；不填也能在 DEMO 模式试玩。', 'sys')
    }
    pushMessage('系统', '鲸鱼娘正在准备今天的课程……', 'sys')
    await sendMessage('')
  }
}

boot()
