// 学术galgame · 前端逻辑（原生 ESM，无框架）
// 只通过 /api/* 与后端通信；立绘是 256×256 的水平精灵图，用 JS 逐帧播放。

const FRAME = 256
const MOOD_LABEL = {
  idle: '平静', joy: '开心', celebrate: '庆祝', disappointed: '失落',
  think: '思考', error: '惊慌', working: '努力', play: '玩耍',
}

const $ = (id) => document.getElementById(id)
const el = {
  mode: $('mode-badge'), level: $('level'), reset: $('reset-btn'),
  sprite: $('sprite'), mood: $('whale-mood'), tier: $('whale-tier'),
  hpText: $('hp-text'), hpBar: $('hp-bar'), favText: $('fav-text'), favBar: $('fav-bar'),
  subjects: $('subjects'), derived: $('derived'), log: $('log'),
  messages: $('messages'), form: $('chat-form'), input: $('chat-input'), send: $('send-btn'),
  battle: $('battle'), enemyName: $('enemy-name'), enemyTitle: $('enemy-title'),
  enemyHpText: $('enemy-hp-text'), enemyHpBar: $('enemy-hp-bar'),
  battleSubject: $('battle-subject'), battleDifficulty: $('battle-difficulty'),
  battleStreak: $('battle-streak'), retreat: $('retreat-btn'),
}

let busy = false
let spriteTimer = null
let currentSpriteKey = ''

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

  // 学科
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

  // 派生能力
  el.derived.innerHTML = ''
  for (const [name, val] of Object.entries(s.derived || {})) {
    const d = document.createElement('div')
    d.className = 'item'
    d.innerHTML = `<b>${val}</b><span>${escapeHtml(name)}</span>`
    el.derived.appendChild(d)
  }

  // 日志
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
async function api(path, options) {
  const res = await fetch(path, options)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
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

/* ── 事件绑定 ── */
el.form.addEventListener('submit', (e) => {
  e.preventDefault()
  const text = el.input.value.trim()
  if (!text) return
  el.input.value = ''
  sendMessage(text)
})

el.reset.addEventListener('click', async () => {
  if (!confirm('确定重置全部进度吗？')) return
  const data = await api('/api/reset', { method: 'POST' })
  el.messages.innerHTML = ''
  renderState(data.state)
  pushMessage('系统', '进度已重置。', 'sys')
})

el.retreat.addEventListener('click', () => sendMessage('撤退'))

/* ── 启动 ── */
async function boot() {
  try {
    const health = await api('/api/health')
    if (health.arkConfigured) {
      el.mode.textContent = `火山方舟 · ${health.model}`
      el.mode.classList.remove('demo')
    } else {
      el.mode.textContent = 'DEMO 模式（未配置 ARK_API_KEY）'
      el.mode.classList.add('demo')
    }
  } catch {
    el.mode.textContent = '后端未连接'
  }

  try {
    renderState(await api('/api/state'))
  } catch { /* 忽略 */ }

  pushMessage('系统', '鲸鱼娘正在准备今天的课程……', 'sys')
  await sendMessage('')
}

boot()
