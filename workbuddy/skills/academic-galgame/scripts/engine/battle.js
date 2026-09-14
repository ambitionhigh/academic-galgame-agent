// 战斗（场景任务）状态机。战斗态只存在内存，不写存档；永久进度写在存档里。
import { ENEMY_DEFS, LORD_PASS, NEAR_DEATH } from './config.js'
import { clamp, logNote, setMood, demonUnlocked, newSubject } from './game.js'

/** 战斗的可读视图（给 UI 与 LLM） */
export function battleView(battle) {
  if (!battle) return null
  const def = ENEMY_DEFS[battle.enemy]
  return {
    subject: battle.subject,
    enemy: battle.enemy,
    enemyName: def.name,
    enemyTitle: def.title,
    enemyInfinite: battle.enemy === 'demon',
    enemyHp: battle.enemyHp,
    enemyMaxHp: battle.enemyMaxHp,
    difficulty: battle.difficulty,
    questionCount: battle.questionCount,
    correctStreak: battle.correctStreak,
  }
}

/** 开战前的解锁校验。返回 null 表示可开战，否则返回错误文案。 */
export function checkUnlock(state, subject, enemy) {
  const sub = state.subjects[subject]
  const def = ENEMY_DEFS[enemy]
  if (!sub) return `未知学科：${subject}（可用 ag_add_subject 添加）`
  if (!def) return `未知敌人：${enemy}（可选 lord / general / king / demon）`
  const m = sub.mastery || 0
  if (enemy === 'lord') {
    if (m < 60) return `领主求助需「${subject}」熟练度 ≥ 60（当前 ${m}）`
    if (sub.quest.lord) return '领主求助已完成，可挑战魔将（熟练度 ≥ 75）'
  }
  if (enemy === 'general') {
    if (!sub.quest.lord) return '需先完成领主求助'
    if (m < 75) return `魔将需「${subject}」熟练度 ≥ 75（当前 ${m}）`
    if (sub.quest.general) return '魔将已讨伐，可挑战学科魔王（熟练度 ≥ 90）'
  }
  if (enemy === 'king') {
    if (!sub.quest.general) return '需先讨伐魔将'
    if (m < 90) return `学科魔王需「${subject}」熟练度 ≥ 90（当前 ${m}）`
    if (sub.conquered) return '该学科魔王已讨伐（★）'
  }
  if (enemy === 'demon' && !demonUnlocked(state)) return '魔神尚未现身：需全部学科魔王通关（研究生）'
  return null
}

/** 开战：成功返回 battle 对象，失败抛错 */
export function startBattle(state, subject, enemy) {
  if (!state.subjects[subject]) state.subjects[subject] = newSubject()
  const err = checkUnlock(state, subject, enemy)
  if (err) throw new Error(err)
  const def = ENEMY_DEFS[enemy]
  return {
    subject,
    enemy,
    enemyHp: def.hp === null ? 0 : def.hp,
    enemyMaxHp: def.hp === null ? 0 : def.hp,
    difficulty: 1 + ((state.defeats[`${subject}:${enemy}`]) || 0),
    questionCount: 0,
    correctStreak: 0,
    startedAt: Date.now(),
    difficultyBumped: false,
  }
}

/** 胜利结算：写永久进度 + 自动发奖励 */
function settleVictory(state, battle) {
  const def = ENEMY_DEFS[battle.enemy]
  const sub = state.subjects[battle.subject]
  sub.quest[def.key] = true
  if (def.key === 'king') sub.conquered = true
  if (def.key !== 'demon') {
    sub.mastery = clamp(sub.mastery + def.reward.mastery, 0, 100)
    state.whale.favorability = clamp(state.whale.favorability + def.reward.favor, 0, 100)
    state.defeats[`${battle.subject}:${def.key}`] = 0
  }
  if (demonUnlocked(state)) state.player.title = '研究生'
  setMood(state, 'celebrate')
  logNote(state, `讨伐成功：${battle.subject}·${def.name}（难度 ${battle.difficulty}）`, battle.subject)
  return { mastery: def.reward.mastery, favor: def.reward.favor }
}

/**
 * 结算一次攻击/答题。
 * @param {object} state 存档状态（原地修改）
 * @param {object} battle 当前战斗（原地读取）
 * @param {{correctness?:number, damageEnemy?:number, damageSelf?:number, note?:string}} args
 * @returns {{ result: object, battle: object|null }} battle=null 表示战斗已结束
 */
export function applyBattle(state, battle, args = {}) {
  const def = ENEMY_DEFS[battle.enemy]
  const correct = typeof args.correctness === 'number' ? clamp(args.correctness, 0, 1) : null
  battle.questionCount++
  if (correct !== null && correct >= LORD_PASS) battle.correctStreak++
  else if (correct !== null) battle.correctStreak = 0

  const dSelf = Math.max(0, Number(args.damageSelf) || 0)
  const result = { ok: true, note: args.note || null, hp: state.player.hp }

  // 领主求助：无血条，按正确度判定
  if (battle.enemy === 'lord') {
    if (correct === null) throw new Error('领主求助需传入 correctness（0~1）')
    if (correct >= LORD_PASS) {
      const reward = settleVictory(state, battle)
      return { result: { ...result, victory: true, reward }, battle: null }
    }
    state.player.hp = clamp(state.player.hp - Math.round(state.player.maxHp * 0.1), 0, state.player.maxHp)
    setMood(state, 'disappointed')
    return {
      result: { ...result, failed: true, reason: `领主求助未达标（正确度 ${correct} < ${LORD_PASS}），扣 10% HP` },
      battle,
    }
  }

  // 魔神：无限血，一次对峙后收束（暗线推进）
  if (battle.enemy === 'demon') {
    state.player.hp = clamp(state.player.hp - dSelf, 0, state.player.maxHp)
    state.demonTries = (state.demonTries || 0) + 1
    state.whale.favorability = clamp(state.whale.favorability + def.reward.favor, 0, 100)
    setMood(state, correct !== null && correct >= LORD_PASS ? 'think' : 'disappointed')
    logNote(state, `魔神对峙：${battle.subject}（第 ${state.demonTries} 次），暗线推进`, battle.subject)
    return {
      result: { ...result, demonResolved: true, demonTries: state.demonTries, message: '魔神的力量深不见底……本次对峙结束，暗线浮现。' },
      battle: null,
    }
  }

  // 常规战斗
  const dEnemy = Math.max(0, Number(args.damageEnemy) || 0)
  battle.enemyHp = Math.max(0, battle.enemyHp - dEnemy)
  state.player.hp = clamp(state.player.hp - dSelf, 0, state.player.maxHp)

  if (battle.enemyHp <= 0) {
    const reward = settleVictory(state, battle)
    return { result: { ...result, victory: true, reward, message: `${def.title}被打败了！` }, battle: null }
  }
  if (state.player.hp <= 0) {
    state.player.hp = clamp(Math.round(state.player.maxHp * NEAR_DEATH), 1, state.player.maxHp)
    state.defeats[`${battle.subject}:${battle.enemy}`] = (state.defeats[`${battle.subject}:${battle.enemy}`] || 0) + 1
    setMood(state, 'disappointed')
    logNote(state, `败北：${battle.subject}·${def.name}（重试难度 +1）`, battle.subject)
    return { result: { ...result, defeat: true, rescued: true, message: '鲸鱼娘把你救回来了（HP → 30），特训后重试。' }, battle: null }
  }
  if (!battle.difficultyBumped && state.player.hp <= state.player.maxHp * NEAR_DEATH) {
    battle.difficultyBumped = true
    state.defeats[`${battle.subject}:${battle.enemy}`] = (state.defeats[`${battle.subject}:${battle.enemy}`] || 0) + 1
    setMood(state, 'error')
    logNote(state, `濒死营救：${battle.subject}·${def.name}（特训，重试难度 +1）`, battle.subject)
    return { result: { ...result, nearDeath: true, rescued: true, message: '鲸鱼娘营救：濒死！特训后重试难度 +1。' }, battle }
  }
  return { result, battle }
}
