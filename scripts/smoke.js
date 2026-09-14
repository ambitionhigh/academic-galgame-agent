// 离线自测：不联网、不调用模型，验证引擎 / 检索 / 会话是否正常。
// 运行：npm run smoke
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { Storage } from '../src/engine/storage.js'
import { GameSession } from '../src/engine/session.js'
import { localCorpusRetrieve } from '../src/agent/retriever.js'
import { demonUnlocked } from '../src/engine/game.js'

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  \u2713 ${name}`)
  } catch (err) {
    console.error(`  \u2717 ${name}\n    ${err.message}`)
    process.exitCode = 1
  }
}

const saveFile = join(tmpdir(), `acgal-smoke-${Date.now()}.json`)
const session = new GameSession(new Storage(saveFile))

console.log('\n学术galgame Agent · 离线自测\n')

// ── 引擎：初始状态 ──
test('初始状态：等级 1、HP 100、5 个初始学科', () => {
  const s = session.status()
  assert.equal(s.level, 1)
  assert.equal(s.player.hp, 100)
  assert.equal(Object.keys(s.subjects).length, 5)
  assert.equal(s.battle, null)
})

// ── 引擎：教学结算与升级 ──
test('教学结算：熟练度累加并触发升级（50 点 / 级）', () => {
  session.teaching({ subject: '博弈论', masteryDelta: 60, favorabilityDelta: 10, note: '自测：教学结算' })
  const s = session.status()
  assert.equal(s.subjects['博弈论'].mastery, 60)
  assert.equal(s.whale.favorability, 10)
  assert.equal(s.level, 2, `总熟练度 60 应为 2 级，实际 ${s.level}`)
})

// ── 引擎：解锁链校验 ──
test('解锁链：领主未完成时不能挑战魔将', () => {
  assert.throws(() => session.battleStart('博弈论', 'general'), /领主/)
})

test('解锁链：熟练度不足时不能挑战领主', () => {
  assert.throws(() => session.battleStart('投资', 'lord'), /熟练度/)
})

// ── 引擎：领主求助（无血条，按正确度判定）──
test('领主求助：正确度 0.8 ≥ 0.6 通关，自动发奖励 +3 熟练', () => {
  session.battleStart('博弈论', 'lord')
  const out = session.battleApply({ correctness: 0.8, note: '自测：领主求助' })
  assert.equal(out.victory, true)
  assert.equal(out.battle, null)
  const s = session.status()
  assert.equal(s.subjects['博弈论'].quest.lord, true)
  assert.equal(s.subjects['博弈论'].mastery, 63, `应 60+3=63，实际 ${s.subjects['博弈论'].mastery}`)
})

// ── 引擎：魔将战斗（有血条，伤害累积）──
test('魔将战斗：累积伤害击破后胜利并写入任务链', () => {
  session.teaching({ subject: '博弈论', masteryDelta: 12 }) // 75，满足魔将条件
  session.battleStart('博弈论', 'general')
  let out = null
  for (let i = 0; i < 15; i++) {
    out = session.battleApply({ correctness: 1, damageEnemy: 3, damageSelf: 0 })
    if (out.victory) break
  }
  assert.equal(out.victory, true, '应在 15 次内击破魔将（HP 15 / 每次 3 伤）')
  assert.equal(session.status().subjects['博弈论'].quest.general, true)
})

test('战斗态在结束后清空', () => {
  assert.equal(session.status().battle, null)
})

// ── 引擎：撤退 ──
test('撤退：清除战斗态且无惩罚', () => {
  session.teaching({ subject: '投资', masteryDelta: 60 })
  session.battleStart('投资', 'lord')
  assert.notEqual(session.status().battle, null)
  const r = session.battleRetreat()
  assert.equal(r.cleared, true)
  assert.equal(session.status().battle, null)
})

// ── 引擎：存档持久化 ──
test('存档：写入后可被新会话读回（含任务链）', () => {
  const reloaded = new GameSession(new Storage(saveFile))
  const s = reloaded.status()
  // 60（教学）+3（领主）+12（教学）=75，魔将胜利 +5 → 80
  assert.equal(s.subjects['博弈论'].mastery, 80)
  assert.equal(s.subjects['博弈论'].quest.lord, true)
  assert.equal(s.subjects['博弈论'].quest.general, true)
})

// ── 引擎：魔神解锁判定 ──
test('魔神解锁：需全部学科魔王通关', () => {
  assert.equal(demonUnlocked(session.state), false)
})

// ── 检索：本地语料 ──
test('检索：能从 corpus/ 命中「纳什均衡」', () => {
  const r = localCorpusRetrieve('纳什均衡', '博弈论')
  assert.equal(r.ok, true, `检索失败：${r.error || '无命中'}`)
  assert.ok(r.items.length > 0)
  assert.ok(r.items[0].content.length > 0)
})

// ── 会话：重置 ──
test('重置：回到初始状态', () => {
  session.reset()
  const s = session.status()
  assert.equal(s.level, 1)
  assert.equal(s.subjects['博弈论'].mastery, 0)
})

// 清理临时存档
try { rmSync(saveFile, { force: true }) } catch { /* 忽略 */ }

console.log(`\n${process.exitCode ? '✗ 有失败项' : `✓ 全部通过（${passed} 项）`}\n`)
