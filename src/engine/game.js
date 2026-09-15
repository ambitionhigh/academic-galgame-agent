// 游戏核心状态机（纯逻辑：不依赖 agent / server，不发网络请求）
import {
  SEED_SUBJECTS, PLAYER_MAX_HP, MASTERY_PER_LEVEL, STATE_FRAMES,
  TIER_IMAGE, MOOD_TTL_MS, FAVOR_TIERS, DERIVED_WEIGHTS,
} from './config.js'

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

/** 新建一个学科档案 */
export function newSubject() {
  return { mastery: 0, conquered: false, quest: { lord: false, general: false, king: false } }
}

/** 全新存档 */
export function createState() {
  const s = {
    player: { hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, title: '学徒' },
    whale: { favorability: 0 },
    subjects: {},
    mood: null,
    log: [],
    demonTries: 0,
    defeats: {},
  }
  for (const n of SEED_SUBJECTS) s.subjects[n] = newSubject()
  return s
}

/** 读取旧存档时的向后兼容补全（缺失字段补默认值） */
export function migrateState(state) {
  if (!state || !state.player || !state.subjects) return createState()
  if (!state.mood) state.mood = null
  if (typeof state.demonTries !== 'number') state.demonTries = 0
  if (!state.defeats) state.defeats = {}
  if (!Array.isArray(state.log)) state.log = []
  for (const k of Object.keys(state.subjects)) {
    const sub = state.subjects[k]
    if (!sub.quest) sub.quest = { lord: false, general: false, king: false }
    if (typeof sub.mastery !== 'number') sub.mastery = 0
    if (sub.conquered === undefined) sub.conquered = false
  }
  return state
}

export function totalMastery(state) {
  let total = 0
  for (const k of Object.keys(state.subjects)) total += state.subjects[k].mastery || 0
  return total
}

export function levelOf(state) {
  return 1 + Math.floor(totalMastery(state) / MASTERY_PER_LEVEL)
}

/** 好感度档位 0~4 */
export function whaleTier(state) {
  const f = state.whale.favorability || 0
  for (let i = 0; i < FAVOR_TIERS.length; i++) if (f >= FAVOR_TIERS[i]) return 4 - i
  return 0
}

/** 生效中的心情：超过存活时间的视为已回落（返回 null） */
export function effectiveMood(state) {
  if (state.mood && state.mood.name && STATE_FRAMES[state.mood.name] && (Date.now() - state.mood.at < MOOD_TTL_MS)) {
    return state.mood.name
  }
  return null
}

/** 当前该显示哪张立绘（心情优先，过期回落到好感档位） */
export function currentImageKey(state) {
  return effectiveMood(state) || TIER_IMAGE[whaleTier(state)] || 'idle'
}

/** 是否已解锁魔神（全部学科魔王通关 = 研究生） */
export function demonUnlocked(state) {
  const keys = Object.keys(state.subjects)
  return keys.length > 0 && keys.every((k) => !!state.subjects[k].conquered)
}

/** 派生能力（装饰性数值，0~100） */
export function derivedAttributes(state) {
  const out = {}
  for (const [name, weights] of Object.entries(DERIVED_WEIGHTS)) {
    let sum = 0
    for (const [subject, w] of Object.entries(weights)) {
      sum += ((state.subjects[subject] && state.subjects[subject].mastery) || 0) * w
    }
    out[name] = Math.round(clamp(sum, 0, 100))
  }
  return out
}

/** 写一条日志（保留最近 50 条） */
export function logNote(state, note, subject = null) {
  state.log.unshift({ at: Date.now(), note, subject })
  if (state.log.length > 50) state.log.pop()
}

/** 设置鲸鱼娘心情（8 秒后自动回落） */
export function setMood(state, name) {
  if (name && STATE_FRAMES[name]) state.mood = { name, at: Date.now() }
}

/**
 * 教学/答题结算（非战斗）。返回结算后的可读摘要。
 * @param {object} state 存档状态（原地修改）
 * @param {{subject?:string, masteryDelta?:number, favorabilityDelta?:number, hpDelta?:number, mood?:string, note?:string}} args
 */
export function applyTeaching(state, args = {}) {
  if (args.subject) {
    if (!state.subjects[args.subject]) state.subjects[args.subject] = newSubject()
    if (typeof args.masteryDelta === 'number') {
      const sub = state.subjects[args.subject]
      sub.mastery = clamp(sub.mastery + args.masteryDelta, 0, 100)
    }
  }
  if (typeof args.favorabilityDelta === 'number') {
    state.whale.favorability = clamp(state.whale.favorability + args.favorabilityDelta, 0, 100)
  }
  if (typeof args.hpDelta === 'number') {
    state.player.hp = clamp(state.player.hp + args.hpDelta, 0, state.player.maxHp)
  }
  setMood(state, args.mood)
  logNote(state, args.note || '教学结算', args.subject || null)
  return statusView(state)
}

/** 新增学科 */
export function addSubject(state, name) {
  const n = String(name || '').trim()
  if (!n) return { ok: false, error: '学科名不能为空' }
  if (n.length > 40) return { ok: false, error: '学科名过长（≤40 字）' }
  if (state.subjects[n]) return { ok: false, error: `学科「${n}」已存在` }
  state.subjects[n] = newSubject()
  logNote(state, `新增学科：${n}`, n)
  return { ok: true, subjects: state.subjects }
}

/** 删除学科（连带其熟练度与任务链）；至少保留一个 */
export function removeSubject(state, name) {
  const n = String(name || '').trim()
  if (!n) return { ok: false, error: '学科名不能为空' }
  if (!state.subjects[n]) return { ok: false, error: `没有这个学科：${n}` }
  if (Object.keys(state.subjects).length <= 1) return { ok: false, error: '至少要保留一个学科' }
  delete state.subjects[n]
  logNote(state, `移除学科：${n}`, null)
  return { ok: true, subjects: state.subjects }
}

/** 汇总给 UI / LLM 的状态视图 */
export function statusView(state, battle = null) {
  const imgKey = currentImageKey(state)
  return {
    player: state.player,
    whale: state.whale,
    whaleTier: whaleTier(state),
    mood: effectiveMood(state),
    level: levelOf(state),
    totalMastery: totalMastery(state),
    derived: derivedAttributes(state),
    subjects: state.subjects,
    log: state.log.slice(0, 8),
    demonUnlocked: demonUnlocked(state),
    demonTries: state.demonTries || 0,
    imageKey: imgKey,
    imageFrames: STATE_FRAMES[imgKey] || 1,
    battle,
  }
}
