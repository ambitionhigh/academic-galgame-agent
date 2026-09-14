// 学术galgame · 前端逻辑（原生 ESM，无框架）
// 只通过 /api/* 与后端通信；立绘是 256×256 的水平精灵图，用 JS 逐帧播放。
//
// 【BYOK 自带密钥】用户填写的方舟 / ima 凭证只保存在本机 localStorage，
// 每次请求随 HTTP 头发送；服务端不存储。→ 每个人用自己的 Key 学自己的资料。

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
  cfgFiles: $('cfg-files'), cfgFileList: $('cfg-file-list'),
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

const KB_HINT = '<p class="kb-hint">点「拉取知识库列表」后，这里会按学科列出下拉框 —— 直接用<b>名称</b>选即可，ID 自动填。</p>'

function renderKbRows() {
  const map = currentKbMap()
  const subjects = cachedSubjects.length ? cachedSubjects : Object.keys(map)
  if (cachedKbs.length === 0 || subjects.length === 0) {
    el.cfgKbRows.innerHTML = KB_HINT
    return
  }
  el.cfgKbRows.innerHTML = ''
  for (const subj of subjects) {
    const opts = ['<option value="">（不用知识库）</option>']
      .concat(cachedKbs.map((k) => `<option value="${escapeHtml(k.id)}"${map[subj] === k.id ? ' selected' : ''}>${escapeHtml(k.name)}</option>`))
      .join('')
    const row = document.createElement('label')
    row.className = 'kb-row'
    row.innerHTML = `<span>${escapeHtml(subj)}</span><select data-subject="${escapeHtml(subj)}">${opts}</select>`
    el.cfgKbRows.appendChild(row)
  }
  el.cfgKbRows.querySelectorAll('select').forEach((sel) => {
    sel.addEventListener('change', () => {
      const m = currentKbMap()
      if (sel.value) m[sel.dataset.subject] = sel.value
      else delete m[sel.dataset.subject]
      writeKbMap(m)
    })
  })
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
    showResult(el.cfgImaResult, 'ok', `✓ 拉到 ${cachedKbs.length} 个知识库，请按学科选择`)
    renderKbRows()
  } catch (e) { showResult(el.cfgImaResult, 'err', `✗ ${e.message}`) }
}

/* ── ③ 我的教材（上传 → 只存本会话内存）── */
function renderFileList(files, totalChars) {
  el.cfgFileList.innerHTML = ''
  for (const f of files) {
    const li = document.createElement('li')
    li.innerHTML = `<span>${escapeHtml(f.name)}</span><span class="sz">${Number(f.chars || 0).toLocaleString()} 字</span>`
    el.cfgFileList.appendChild(li)
  }
  if (files.length) {
    const li = document.createElement('li')
    li.innerHTML = `<span>合计 ${files.length} 个文件</span><span class="sz">${Number(totalChars || 0).toLocaleString()} 字</span>`
    el.cfgFileList.appendChild(li)
  }
}

async function loadCorpus() {
  try {
    const r = await api('/api/corpus')
    renderFileList(r.files || [], r.totalChars || 0)
  } catch { /* 忽略 */ }
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList || [])
  if (!files.length) return
  showResult(el.cfgFileResult, 'pending', `正在读取 ${files.length} 个文件…`)
  const payload = []
  for (const f of files) {
    try { payload.push({ name: f.name, text: await f.text() }) } catch { /* 跳过读不了的 */ }
  }
  try {
    const r = await api('/api/corpus', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: payload }),
    })
    renderFileList(r.files || [], r.totalChars || 0)
    showResult(el.cfgFileResult, 'ok', `✓ 已载入 ${(r.files || []).length} 个文件${r.truncated ? '（超出上限已截断）' : ''}`)
    pushMessage('系统', `已载入你的教材（${(r.files || []).length} 个文件），老师会优先从这些资料出题。`, 'sys')
  } catch (e) { showResult(el.cfgFileResult, 'err', `✗ ${e.message}`) }
}

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
el.cfgFiles.addEventListener('change', (e) => uploadFiles(e.target.files))
el.cfgClearFiles.addEventListener('click', async () => {
  try {
    await api('/api/corpus', { method: 'DELETE' })
    renderFileList([], 0)
    el.cfgFiles.value = ''
    showResult(el.cfgFileResult, 'ok', '已清空我的教材')
  } catch (e) { showResult(el.cfgFileResult, 'err', `✗ ${e.message}`) }
})

/* ── 启动 ── */
async function boot() {
  await refreshHealth()
  try { renderState(await api('/api/state')) } catch { /* 忽略 */ }

  // 支持 http://host/#settings 直接打开设置面板
  if (location.hash === '#settings') {
    openSettings()
  } else {
    const c = loadCreds()
    if (!c.arkKey) {
      pushMessage('系统', '尚未配置大模型：点右上角「⚙ 设置」填入你自己的火山方舟 Key，即可用真模型教学；不填也能在 DEMO 模式试玩。', 'sys')
    }
    pushMessage('系统', '鲸鱼娘正在准备今天的课程……', 'sys')
    await sendMessage('')
  }
}

boot()
