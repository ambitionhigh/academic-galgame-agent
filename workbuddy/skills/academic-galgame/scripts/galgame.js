#!/usr/bin/env node
// 学术galgame · WorkBuddy 技能内嵌 CLI
//
// 每次调用是一个独立进程，因此「存档 + 战斗态」都落在一个 JSON 文件里：
//   默认 ~/.workbuddy/academic-galgame/save.json（可用 GALGAME_SAVE 覆盖）
//
// 用法（全部输出 JSON，便于智能体解析）：
//   node galgame.js status
//   node galgame.js apply --subject 博弈论 --mastery 13 --favor 9 --mood joy --note "..."
//   node galgame.js add-subject --name 博弈论大学习
//   node galgame.js remove-subject --name 博弈论大学习
//   node galgame.js battle-start --subject 博弈论 --enemy lord
//   node galgame.js battle-apply --correctness 0.8 [--damage-enemy 3] [--damage-self 0] [--note "..."]
//   node galgame.js battle-retreat
//   node galgame.js reset
//   node galgame.js help

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createState, migrateState, statusView, applyTeaching, addSubject, removeSubject, levelOf } from './engine/game.js'
import { battleView, startBattle, applyBattle, checkUnlock } from './engine/battle.js'
import { ENEMY_DEFS } from './engine/config.js'

const SAVE = process.env.GALGAME_SAVE
  || join(homedir(), '.workbuddy', 'academic-galgame', 'save.json')

/* ── 读写（存档 + 战斗态一起存） ── */
function loadAll() {
  try {
    const j = JSON.parse(readFileSync(SAVE, 'utf8'))
    return { state: migrateState(j.state), battle: j.battle || null }
  } catch {
    return { state: createState(), battle: null }
  }
}
function saveAll(state, battle) {
  try {
    mkdirSync(dirname(SAVE), { recursive: true })
    writeFileSync(SAVE, JSON.stringify({ state, battle }), 'utf8')
  } catch (e) {
    // 落盘失败不阻断；结果里带上警告
    return String(e.message || e)
  }
  return null
}

/* ── 极简参数解析：--k v / --flag ── */
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++ }
      else out[key] = true
    } else out._.push(a)
  }
  return out
}
const num = (v) => (v === undefined || v === true ? undefined : Number(v))

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
}

function view(state, battle, extra = {}) {
  return { ok: true, save: SAVE, ...extra, game: statusView(state, battle) }
}

/* ── 命令 ── */
const HELP = `学术galgame CLI

  status                                          查看状态
  apply --subject <名> [--mastery n] [--favor n] [--hp n] [--mood joy|disappointed|celebrate|think] [--note 文本]
  add-subject --name <名>                         新增学科
  remove-subject --name <名>                      删除学科
  battle-start --subject <名> --enemy lord|general|king|demon
  battle-apply [--correctness 0~1] [--damage-enemy n] [--damage-self n] [--note 文本]
  battle-retreat                                  撤退
  reset                                           重置全部进度

存档：\${GALGAME_SAVE:-~/.workbuddy/academic-galgame/save.json}
`

function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0] || 'status'
  const a = parseArgs(argv.slice(1))
  const { state, battle } = loadAll()

  if (cmd === 'help' || a.help) { process.stdout.write(HELP); return }

  if (cmd === 'status') {
    emit(view(state, battle, { cmd }))
    return
  }

  if (cmd === 'apply') {
    applyTeaching(state, {
      subject: a.subject,
      masteryDelta: num(a.mastery),
      favorabilityDelta: num(a.favor),
      hpDelta: num(a.hp),
      mood: typeof a.mood === 'string' ? a.mood : undefined,
      note: typeof a.note === 'string' ? a.note : undefined,
    })
    const warn = saveAll(state, battle)
    emit(view(state, battle, { cmd, warn }))
    return
  }

  if (cmd === 'add-subject' || cmd === 'remove-subject') {
    const r = cmd === 'add-subject' ? addSubject(state, a.name) : removeSubject(state, a.name)
    if (!r.ok) { emit({ ok: false, error: r.error }); process.exitCode = 1; return }
    const warn = saveAll(state, battle)
    emit(view(state, battle, { cmd, warn, subjects: Object.keys(state.subjects) }))
    return
  }

  if (cmd === 'reset') {
    const fresh = createState()
    const warn = saveAll(fresh, null)
    emit(view(fresh, null, { cmd, warn }))
    return
  }

  if (cmd === 'battle-start') {
    if (battle) { emit({ ok: false, error: `已有进行中的战斗：${battle.subject}·${battle.enemy}，请先 battle-retreat` }); process.exitCode = 1; return }
    const err = checkUnlock(state, a.subject, a.enemy)
    if (err) { emit({ ok: false, error: err }); process.exitCode = 1; return }
    const b = startBattle(state, a.subject, a.enemy)
    const def = ENEMY_DEFS[a.enemy]
    const warn = saveAll(state, b)
    emit(view(state, b, {
      cmd,
      warn,
      battle: battleView(b),
      rules: '概念题：答对对敌 1 伤 / 答错自伤 10%；开放题：对敌 3×正确度 / 自伤 20%×(1−正确度)；'
        + '领主求助无血条，正确度 ≥0.6 通过。胜利奖励由引擎自动发放，勿再 apply 重复发放。',
      enemyCard: { name: def.name, title: def.title, hp: def.hp },
    }))
    return
  }

  if (cmd === 'battle-apply') {
    if (!battle) { emit({ ok: false, error: '当前没有进行中的战斗（先用 battle-start 开战）' }); process.exitCode = 1; return }
    let result, next
    try {
      ({ result, battle: next } = applyBattle(state, battle, {
        correctness: num(a.correctness),
        damageEnemy: num(a['damage-enemy']),
        damageSelf: num(a['damage-self']),
        note: typeof a.note === 'string' ? a.note : undefined,
      }))
    } catch (e) {
      emit({ ok: false, error: String(e.message || e) }); process.exitCode = 1; return
    }
    const warn = saveAll(state, next)
    emit(view(state, next, { cmd, warn, result, battle: battleView(next), battleEnded: next === null }))
    return
  }

  if (cmd === 'battle-retreat') {
    const had = battle
    const warn = saveAll(state, null)
    emit(view(state, null, { cmd, warn, cleared: !!had, message: had ? `已撤退（${had.subject}）` : '没有进行中的战斗' }))
    return
  }

  emit({ ok: false, error: `未知命令：${cmd}（用 help 查看用法）` })
  process.exitCode = 1
}

try { main() } catch (e) {
  emit({ ok: false, error: String((e && e.message) || e) })
  process.exitCode = 1
}
