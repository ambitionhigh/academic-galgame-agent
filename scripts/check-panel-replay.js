#!/usr/bin/env node
// 验证「回合回放」的重建逻辑是否正确 —— **两处实现都验**：
//   · WorkBuddy 面板  workbuddy/skills/academic-galgame/panel/index.html
//   · 网页界面        python/web/app.js（与 src/web/app.js 同源）
//
// 关键不变量：**把可见窗口的所有轮次正推完，最后一轮的快照必须等于当前真实状态。**
// 不等于就说明增量没记全、或累加逻辑错了 —— 那回放出来的数字就是编的。
//
// 做法：把每一处的 buildTurns **真跑起来**调用，而不是复制一份逻辑来测。
// 顺带保证两处实现不会各自跑偏。
//
// 用法：node scripts/check-panel-replay.js

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { createState, applyTeaching, statusView } from '../src/engine/game.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const PANEL = resolve(REPO, 'workbuddy/skills/academic-galgame/panel/index.html')
const WEBAPP = resolve(REPO, 'python/web/app.js')

/** 从源码里抠出一个具名函数的完整源码（按大括号配对） */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) return ''
  const open = src.indexOf('{', start)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return ''
}

function loadBuildTurnsFromPanel() {
  const html = readFileSync(PANEL, 'utf8')
  const m = html.match(/<script>([\s\S]*?)<\/script>/)
  if (!m) throw new Error('面板里没找到 <script>')

  function fakeEl() {
    return {
      textContent: '', innerHTML: '', value: '', disabled: false,
      style: new Proxy({}, { get: () => '', set: () => true }),
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild() {}, addEventListener() {}, setAttribute() {},
      offsetWidth: 0, children: [],
    }
  }
  const els = new Map()
  const sandbox = {
    console,
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, fakeEl()); return els.get(id) },
      createElement: () => fakeEl(),
    },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
    fetch: () => new Promise(() => {}),        // poll 永不返回，别干扰测试
    Date, Math, JSON, Object, Array, String, Number, RegExp, isNaN, parseInt, parseFloat,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(m[1], sandbox)
  if (typeof sandbox.buildTurns !== 'function') throw new Error('面板脚本里没有 buildTurns')
  return sandbox.buildTurns
}

function loadBuildTurnsFromWebApp() {
  const src = readFileSync(WEBAPP, 'utf8')
  const fnSrc = extractFunction(src, 'buildTurns')
  if (!fnSrc) throw new Error('网页 app.js 里没有 buildTurns')
  return vm.runInNewContext(`(${fnSrc})`, { Object, Array, String, Number })
}

// ── 造一个真实状态：五轮教学 + 一轮会触发 clamp 的超量奖励 ──
const state = createState()
applyTeaching(state, { subject: '博弈论', masteryDelta: 13, favorabilityDelta: 9, mood: 'joy', note: '独立答对' })
applyTeaching(state, { subject: '博弈论', masteryDelta: 7, favorabilityDelta: 5, mood: 'think', note: '提示后答对' })
applyTeaching(state, { subject: '博弈论', masteryDelta: -2, favorabilityDelta: -1, mood: 'disappointed', note: '答错' })
applyTeaching(state, { subject: '健康', masteryDelta: 11, favorabilityDelta: 7, mood: 'joy', note: '独立答对' })
applyTeaching(state, { subject: '健康', masteryDelta: 6, favorabilityDelta: 4, mood: 'think', note: '提示后答对' })
applyTeaching(state, { subject: '健康', masteryDelta: 200, favorabilityDelta: 50, note: '超量奖励（会被夹住）' })

const g = statusView(state)

let bad = 0
const check = (label, ok) => { console.log(`  ${ok ? '✓' : '✗'} ${label}`); if (!ok) bad++ }

console.log('\n  回合回放重建验证（两处实现）')
console.log('  ' + '─'.repeat(66))

const impls = [
  ['WorkBuddy 面板', loadBuildTurnsFromPanel],
  ['网页界面 app.js', loadBuildTurnsFromWebApp],
]
const results = []

for (const [name, loader] of impls) {
  console.log(`\n  ▸ ${name}`)
  let buildTurns
  try {
    buildTurns = loader()
  } catch (e) {
    check(`加载失败：${e.message}`, false)
    continue
  }
  const turns = buildTurns(g)
  results.push([name, turns])

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]
    const subs = Object.entries(t.after.sub).filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('・') || '—'
    console.log(`     ${String(i + 1).padStart(2)}  ${String(t.subject || '—').padEnd(7)}`
      + `${String(t.mastery ?? 0).padStart(5)} /${String(t.favor ?? 0).padStart(4)}   `
      + `${subs} ・ 好感 ${t.after.fav}`)
  }

  const last = turns[turns.length - 1]
  for (const [sub, v] of Object.entries(g.subjects)) {
    check(`${sub}：末值 ${last.after.sub[sub] ?? 0} == 当前 ${v.mastery}`, (last.after.sub[sub] ?? 0) === v.mastery)
  }
  check(`好感度：末值 ${last.after.fav} == 当前 ${g.whale.favorability}`, last.after.fav === g.whale.favorability)
  check(`HP：末值 ${last.after.hp} == 当前 ${g.player.hp}`, last.after.hp === g.player.hp)
  check('没有负熟练度（基线反推正确）', !turns.some((t) => Object.values(t.after.sub).some((v) => v < 0)))
  check(`clamp 如实记录：要求 +200 → 实际 +${last.mastery}（17 → 100）`, last.mastery === 83)
}

// ── 两处实现必须给出完全一样的回放 ──
if (results.length === 2) {
  console.log('\n  ▸ 两处实现是否一致')
  const [a, b] = results.map(([, t]) => JSON.stringify(t))
  check('WorkBuddy 面板 与 网页界面 的回放结果逐字节相同', a === b)
}

console.log('\n  ' + '─'.repeat(66))
console.log(bad ? `  ✗ 有 ${bad} 项不通过\n` : '  ✓ 全部通过：回放出来的数字与真实状态完全一致\n')
process.exit(bad ? 1 : 0)

