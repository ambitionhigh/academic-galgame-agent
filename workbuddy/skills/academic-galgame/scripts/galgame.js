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
import { listMaterials, addMaterial, removeMaterial, setMaterialSubject, clearMaterials, retrieve, materialsDir } from './materials.js'
import { loadCreds, saveCreds, credsStatus, listKbs, resolveKb, retrieveIma, CRED_FILE } from './ima.js'

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
/**
 * 首次使用引导：当既没有教材、也没有可用的 ima 绑定时，
 * 明确告诉用户「现在没有真实依据」并给出两条接入路径。
 * @param {string} skillPath 本脚本路径（用于生成可直接执行的命令示例）
 */
function setupGuide(skillPath) {
  const mats = listMaterials()
  const ima = credsStatus()
  const hasMaterials = mats.count > 0
  const hasIma = ima.configured && ima.boundSubjects.length > 0
  const needed = !hasMaterials && !hasIma
  const cmd = `node "${skillPath}"`

  if (!needed) {
    return {
      needed: false,
      state: {
        materials: { count: mats.count, totalChars: mats.totalChars },
        ima: { configured: ima.configured, boundSubjects: ima.boundSubjects },
      },
    }
  }

  return {
    needed: true,
    state: {
      materials: { count: mats.count, dir: mats.dir },
      ima: { configured: ima.configured, boundSubjects: ima.boundSubjects },
    },
    reason: '目前**既没有导入教材、也没有可用的 ima 知识库绑定** —— 出题时拿不到任何真实依据，只能空讲。',
    tellUser: '先告诉用户这个情况，并请他选一条路（见 options），不要直接开始空讲。',
    options: [
      {
        name: 'A. 导入本地教材（最快）',
        when: '用户手上有 .md / .txt / .docx / .pdf 笔记或讲义',
        steps: [
          `${cmd} materials add --path "<文件或目录>" --subject "<学科名>"`,
          `${cmd} add-subject --name "<学科名>"          # 该学科还不存在时`,
          `${cmd} retrieve --query "<关键词>" --subject "<学科名>"   # 验证检索得到`,
        ],
      },
      {
        name: 'B. 接入 ima 知识库',
        when: '用户资料在腾讯 ima 知识库里',
        steps: [
          `${cmd} ima config --key "<API Key>" --client-id "<Client ID>"`,
          `${cmd} ima kbs                                # 列出用户的知识库`,
          `${cmd} ima add-subject --kb "<知识库名>"       # 一键变成学科并绑定`,
          `${cmd} retrieve --query "<关键词>" --subject "<学科名>"   # 验证检索得到`,
        ],
      },
    ],
    note: '两条路可以并用：retrieve 会先查本地教材库，没命中再查 ima 知识库。',
  }
}

const HELP = `学术galgame CLI
  status                                          查看状态（含教材库/ima/首次使用引导）
  onboard                                         首次使用引导：没配资料时该怎么做
  panel [--port 8790] [--host 127.0.0.1]          启动实时动画面板（长驻进程，请后台运行）
  apply --subject <名> [--mastery n] [--favor n] [--hp n] [--mood joy|disappointed|celebrate|think] [--note 文本]
  add-subject --name <名>                         新增学科
  remove-subject --name <名>                      删除学科
  battle-start --subject <名> --enemy lord|general|king|demon
  battle-apply [--correctness 0~1] [--damage-enemy n] [--damage-self n] [--note 文本]
  battle-retreat                                  撤退
  reset                                           重置全部进度

教材库（出题的真实依据）：
  materials list                                  查看已导入的教材
  materials add --path <文件或目录> [--subject 学科]   导入（支持 .md/.txt/.docx/.pdf，可传目录）
  materials set-subject --id <id>|--name <名> [--subject 学科]   给教材指定/改学科
  materials remove --id <id>|--name <名>          删除一份教材
  materials clear                                 清空教材库

ima 知识库（可与教材库并用）：
  ima status                                      查看凭证与绑定状态（Key 打码）
  ima config --key <API Key> --client-id <Client ID>   保存凭证（只存本机，权限 0600）
  ima kbs                                         列出你的知识库（名称 → ID）
  ima add-subject --kb <知识库名或ID>              把某个知识库一键变成学科并绑定
  ima bind --subject <学科> --kb <知识库名或ID>     给已有学科绑定知识库
  ima unbind --subject <学科>                      解除绑定
  ima clear                                        清除凭证与全部绑定

检索：
  retrieve --query <词> [--subject 学科]           出题依据：先查教材库，再查 ima 知识库

存档：\${GALGAME_SAVE:-~/.workbuddy/academic-galgame/save.json}
教材：\${GALGAME_MATERIALS:-~/.workbuddy/academic-galgame/materials}
凭证：\${GALGAME_HOME:-~/.workbuddy/academic-galgame}/credentials.json（只存本机）
`

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0] || 'status'
  const a = parseArgs(argv.slice(1))
  const { state, battle } = loadAll()

  if (cmd === 'help' || a.help) { process.stdout.write(HELP); return }

  if (cmd === 'status') {
    // 一并带出教材库 / ima 概况 / 首次使用引导，老师一眼能看到有哪些可用依据
    const mats = listMaterials()
    const ima = credsStatus()
    emit(view(state, battle, {
      cmd,
      materials: { dir: mats.dir, count: mats.count, totalChars: mats.totalChars, items: mats.items },
      ima: { configured: ima.configured, boundSubjects: ima.boundSubjects, kbMap: ima.kbMap, credFile: CRED_FILE },
      setup: setupGuide(process.argv[1]),
    }))
    return
  }

  // 首次使用引导：单独命令，方便老师主动调用
  if (cmd === 'onboard' || cmd === 'guide') {
    emit({ ok: true, cmd, ...setupGuide(process.argv[1]) })
    return
  }

  /* ── 实时动画面板（长驻进程，请在后台运行） ── */
  if (cmd === 'panel') {
    const port = Number(a.port || process.env.GALGAME_PANEL_PORT || 8790)
    const host = typeof a.host === 'string' ? a.host : '127.0.0.1'
    const { startPanel } = await import('./panel.js')
    startPanel({ port, host })
    // 进程保持运行以提供服务；由调用方在后台管理
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

  /* ── 教材库 ── */
  if (cmd === 'materials') {
    const sub = a._[0] || 'list'
    const key = (typeof a.id === 'string' && a.id) || (typeof a.name === 'string' && a.name) || ''
    try {
      if (sub === 'list') { emit({ cmd: `${cmd} ${sub}`, ...listMaterials() }); return }
      if (sub === 'add') {
        if (typeof a.path !== 'string') { emit({ ok: false, error: 'materials add 需要 --path <文件或目录>' }); process.exitCode = 1; return }
        const r = addMaterial(a.path, typeof a.subject === 'string' ? a.subject : '')
        emit({ cmd: `${cmd} ${sub}`, ...r })
        if (!r.ok) process.exitCode = 1
        return
      }
      if (sub === 'set-subject') {
        if (!key) { emit({ ok: false, error: '需要 --id 或 --name 指定教材' }); process.exitCode = 1; return }
        const r = setMaterialSubject(key, typeof a.subject === 'string' ? a.subject : '')
        emit({ cmd: `${cmd} ${sub}`, ...r })
        if (!r.ok) process.exitCode = 1
        return
      }
      if (sub === 'remove') {
        if (!key) { emit({ ok: false, error: '需要 --id 或 --name 指定教材' }); process.exitCode = 1; return }
        const r = removeMaterial(key)
        emit({ cmd: `${cmd} ${sub}`, ...r })
        if (!r.ok) process.exitCode = 1
        return
      }
      if (sub === 'clear') { emit({ cmd: `${cmd} ${sub}`, ...clearMaterials() }); return }
      emit({ ok: false, error: `未知子命令：materials ${sub}（用 help 查看用法）` })
      process.exitCode = 1
    } catch (e) {
      emit({ ok: false, error: String((e && e.message) || e) })
      process.exitCode = 1
    }
    return
  }

  /* ── ima 知识库 ── */
  if (cmd === 'ima') {
    const sub = a._[0] || 'status'
    try {
      if (sub === 'status') { emit({ cmd: `${cmd} ${sub}`, ...credsStatus() }); return }

      if (sub === 'config') {
        const patch = {}
        if (typeof a.key === 'string') patch.imaApiKey = a.key
        if (typeof a['client-id'] === 'string') patch.imaClientId = a['client-id']
        if (Object.keys(patch).length === 0) {
          emit({ ok: false, error: 'ima config 需要 --key <API Key> 和/或 --client-id <Client ID>' })
          process.exitCode = 1
          return
        }
        saveCreds(patch)
        emit({ cmd: `${cmd} ${sub}`, ...credsStatus() })
        return
      }

      if (sub === 'clear') {
        saveCreds({ imaApiKey: '', imaClientId: '', kbMap: {} })
        emit({ cmd: `${cmd} ${sub}`, ...credsStatus() })
        return
      }

      if (sub === 'kbs') {
        const r = await listKbs()
        emit({ cmd: `${cmd} ${sub}`, ...r })
        if (!r.ok) process.exitCode = 1
        return
      }

      if (sub === 'add-subject') {
        const kbName = (typeof a.kb === 'string' && a.kb) || a._[1]
        if (!kbName) { emit({ ok: false, error: 'ima add-subject 需要 --kb <知识库名或ID>' }); process.exitCode = 1; return }
        const kb = await resolveKb(kbName)
        const r = addSubject(state, kb.name)
        if (!r.ok && !/已存在/.test(r.error)) { emit({ ok: false, error: r.error }); process.exitCode = 1; return }
        const cur = loadCreds()
        cur.kbMap[kb.name] = kb.id
        saveCreds({ kbMap: cur.kbMap })
        const warn = saveAll(state, battle)
        emit(view(state, battle, {
          cmd: `${cmd} ${sub}`, warn,
          subject: kb.name, kb: { name: kb.name, id: kb.id }, alreadyExisted: !r.ok,
        }))
        return
      }

      if (sub === 'bind') {
        const subjectName = typeof a.subject === 'string' ? a.subject : ''
        const kbName = typeof a.kb === 'string' ? a.kb : ''
        if (!subjectName || !kbName) { emit({ ok: false, error: 'ima bind 需要 --subject <学科> --kb <知识库名或ID>' }); process.exitCode = 1; return }
        const kb = await resolveKb(kbName)
        const cur = loadCreds()
        cur.kbMap[subjectName] = kb.id
        saveCreds({ kbMap: cur.kbMap })
        emit({ ok: true, cmd: `${cmd} ${sub}`, bound: { subject: subjectName, kb: kb.name, kbId: kb.id }, kbMap: cur.kbMap })
        return
      }

      if (sub === 'unbind') {
        const subjectName = (typeof a.subject === 'string' && a.subject) || a._[1] || ''
        if (!subjectName) { emit({ ok: false, error: 'ima unbind 需要 --subject <学科>' }); process.exitCode = 1; return }
        const cur = loadCreds()
        const had = cur.kbMap[subjectName] || null
        delete cur.kbMap[subjectName]
        saveCreds({ kbMap: cur.kbMap })
        emit({ ok: true, cmd: `${cmd} ${sub}`, unbound: subjectName, had, kbMap: cur.kbMap })
        return
      }

      emit({ ok: false, error: `未知子命令：ima ${sub}（用 help 查看用法）` })
      process.exitCode = 1
    } catch (e) {
      emit({ ok: false, error: String((e && e.message) || e) })
      process.exitCode = 1
    }
    return
  }

  /* ── 检索：本地教材库 → ima 知识库（按此顺序回落，都没有就如实说明） ── */
  if (cmd === 'retrieve') {
    const q = (typeof a.query === 'string' && a.query) || a._.join(' ')
    const subject = typeof a.subject === 'string' ? a.subject : undefined
    if (!q) { emit({ ok: false, error: 'retrieve 需要 --query <词>' }); process.exitCode = 1; return }

    // ① 本地教材库
    let local = null
    try { local = retrieve(q, subject) } catch (e) { local = { ok: false, source: 'materials', items: [], error: String((e && e.message) || e) } }
    if (local && local.ok) { emit({ cmd, query: q, subject: subject || null, ...local }); return }

    // ② ima 知识库
    let imaRes = null
    try { imaRes = await retrieveIma(q, subject) } catch (e) { imaRes = { ok: false, source: 'ima', items: [], error: String((e && e.message) || e) } }
    if (imaRes && imaRes.ok) { emit({ cmd, query: q, subject: subject || null, ...imaRes }); return }

    // ③ 都没有 → 如实说明缺什么
    emit({
      ok: false, cmd, query: q, subject: subject || null, items: [],
      error: (local && local.error) || (imaRes && imaRes.error) || '没有可用依据',
      materialsError: local && local.error,
      imaError: imaRes && imaRes.error,
      hint: '先 materials add 导入教材，或 ima config 配置知识库后用 ima add-subject / ima bind 绑定学科',
    })
    process.exitCode = 1
    return
  }

  emit({ ok: false, error: `未知命令：${cmd}（用 help 查看用法）` })
  process.exitCode = 1
}

main().catch((e) => {
  emit({ ok: false, error: String((e && e.message) || e) })
  process.exitCode = 1
})
