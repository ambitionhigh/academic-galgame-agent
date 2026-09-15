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
import { loadLlm, saveLlm, llmStatus, testLlm, judgeAnswer, DEFAULT_BASE, DEFAULT_MODEL } from './llm.js'

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
 * 首次使用引导。
 *
 * WorkBuddy 版只要求连两样东西：
 *   ① ima 知识库 API —— **必填**，这是出题唯一的真实依据来源
 *   ② LLM —— **二选一**：填自己的 API，或用 WorkBuddy 自己的积分（默认，无需配置）
 * 本地教材是可选的加料，不替代 ima。
 *
 * @param {string} skillPath 本脚本路径（用于生成可直接执行的命令示例）
 */
function setupGuide(skillPath) {
  const mats = listMaterials()
  const ima = credsStatus()
  const llm = llmStatus()
  const cmd = `node "${skillPath}"`

  const hasMaterials = mats.count > 0
  const imaConfigured = ima.configured
  const imaBound = ima.boundSubjects.length > 0
  // ima 是必填项：没配就是没配，不能靠本地教材糊过去
  const needed = !imaConfigured
  const boundNeeded = imaConfigured && !imaBound

  const requirements = [
    {
      item: 'ima 知识库 API',
      required: true,
      done: imaConfigured,
      detail: imaConfigured
        ? `已配置（Client ID ${ima.imaClientId}）`
        : '还没填。这是出题唯一的真实依据来源，必须填。',
      how: 'ima.qq.com 开放平台 → 拿 API Key 与 Client ID',
    },
    {
      item: 'LLM',
      required: false,
      done: true, // 两条路都算完成，只是模式不同
      detail: llm.configured
        ? `自备 API 模式（${llm.llmModel} @ ${llm.llmBaseUrl}）`
        : 'WorkBuddy 积分模式（默认，不填任何东西，由我自己的模型讲解与判分）',
      how: '想用自备 API：llm config --key <Key> [--model <模型>] [--base-url <地址>]',
    },
    {
      item: '本地教材',
      required: false,
      done: hasMaterials,
      detail: hasMaterials ? `已导入 ${mats.count} 份（${mats.totalChars} 字，可加料）` : '没有，可选；不影响 ima 检索',
      how: 'materials add --path "<文件或目录>" --subject "<学科名>"',
    },
  ]

  const out = {
    needed,
    boundNeeded,
    requirements,
    state: {
      materials: { count: mats.count, totalChars: mats.totalChars, dir: mats.dir },
      ima: { configured: imaConfigured, boundSubjects: ima.boundSubjects, credFile: CRED_FILE },
      llm: { mode: llm.mode, modeLabel: llm.modeLabel, configured: llm.configured, model: llm.llmModel },
    },
  }

  if (needed) {
    return {
      ...out,
      reason: '有一件必填的事还没做：**ima 知识库 API 没有配置** —— 出题时拿不到任何真实依据，只能空讲。'
        + '（LLM 那条不用管，不填就是走 WorkBuddy 积分模式。）',
      tellUser: '先如实告诉用户「ima 知识库必须填」，并给出下面拿 Key 的步骤，不要直接开始空讲。',
      steps: [
        '1. 打开 https://ima.qq.com → 左下角头像 → 开放平台 / API（或访问 ima.qq.com/developer），拿到 API Key 与 Client ID',
        `2. ${cmd} ima config --key "<API Key>" --client-id "<Client ID>"`,
        `3. ${cmd} ima kbs                          # 列出你的知识库，让用户挑一个`,
        `4. ${cmd} ima add-subject --kb "<知识库名>"  # 一键变成学科并绑定`,
        `5. ${cmd} retrieve --query "<关键词>" --subject "<学科名>"   # 验证真能检索到`,
      ],
      note: 'LLM 可选：不配置就用 WorkBuddy 自己的积分；想用自己的 key 再跑 llm config。',
    }
  }

  if (boundNeeded) {
    return {
      ...out,
      needed: true,
      reason: 'ima 凭证已配置，但**还没有把任何知识库绑定到学科** —— 检索时不知道该查哪个库。',
      tellUser: '列出用户的知识库，请他挑一个变成学科，然后绑定。',
      steps: [
        `1. ${cmd} ima kbs                           # 列出知识库`,
        `2. ${cmd} ima add-subject --kb "<知识库名>"   # 一键变成学科并绑定`,
        `3. ${cmd} retrieve --query "<关键词>" --subject "<学科名>"   # 验证`,
      ],
    }
  }

  return out
}

const HELP = `学术galgame CLI（WorkBuddy 版）
  status                                          查看状态（含 ima / LLM / 教材库 / 首次使用引导）
  onboard                                         首次使用引导：必填项还差什么
  panel [--port 8790] [--host 127.0.0.1]          启动实时动画面板（长驻进程，请后台运行）
  apply --subject <名> [--mastery n] [--favor n] [--hp n] [--mood joy|disappointed|celebrate|think] [--note 文本]
  add-subject --name <名>                         新增学科
  remove-subject --name <名>                      删除学科
  battle-start --subject <名> --enemy lord|general|king|demon
  battle-apply [--correctness 0~1] [--damage-enemy n] [--damage-self n] [--note 文本]
  battle-retreat                                  撤退
  reset                                           重置全部进度

要连的两样东西（只有这两样）：
  ① ima 知识库 API —— 必填，出题唯一的真实依据来源
  ② LLM —— 二选一：填自己的 API，或用 WorkBuddy 自己的积分（默认，什么都不用填）

ima 知识库（必填）：
  ima status                                      查看凭证与绑定状态（Key 打码）
  ima config --key <API Key> --client-id <Client ID>   保存凭证（只存本机，权限 0600）
  ima test                                        连通性自检
  ima kbs                                         列出你的知识库（名称 → ID）
  ima add-subject --kb <知识库名或ID>              把某个知识库一键变成学科并绑定
  ima bind --subject <学科> --kb <知识库名或ID>     给已有学科绑定知识库
  ima unbind --subject <学科>                      解除绑定
  ima clear                                        清除凭证与全部绑定

LLM（可选，二选一）：
  llm status                                      看现在是「自备 API」还是「WorkBuddy 积分」模式
  llm config --key <Key> [--model <模型>] [--base-url <地址>]
                                                  填自己的 OpenAI 兼容 API（火山方舟/DeepSeek/OpenAI…）
                                                  默认 base：${DEFAULT_BASE}
  llm test                                        连通性自检
  llm clear                                       清空自备 API，回到 WorkBuddy 积分模式

  judge --subject <学科> --question <问题> --answer <玩家回答> [--points "<知识点1;知识点2>"]
                                                  判正确度 0-100；没配自备 API 时返回
                                                  needsAgentJudgement，由你自己判后再 apply

教材库（可选加料，不替代 ima）：
  materials list                                  查看已导入的教材
  materials add --path <文件或目录> [--subject 学科]   导入（支持 .md/.txt/.docx/.pdf，可传目录）
  materials set-subject --id <id>|--name <名> [--subject 学科]   给教材指定/改学科
  materials remove --id <id>|--name <名>          删除一份教材
  materials clear                                 清空教材库

检索：
  retrieve --query <词> [--subject 学科]           出题依据：先查教材库，再查 ima 知识库

存档：\${GALGAME_SAVE:-~/.workbuddy/academic-galgame/save.json}
教材：\${GALGAME_MATERIALS:-~/.workbuddy/academic-galgame/materials}
凭证：\${GALGAME_HOME:-~/.workbuddy/academic-galgame}/credentials.json（只存本机）
环境变量：IMA_API_KEY / IMA_CLIENT_ID / IMA_KB_MAP ｜ LLM_API_KEY / LLM_MODEL / LLM_BASE_URL
`

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0] || 'status'
  const a = parseArgs(argv.slice(1))
  const { state, battle } = loadAll()

  if (cmd === 'help' || a.help) { process.stdout.write(HELP); return }

  if (cmd === 'status') {
    // 一并带出 ima / LLM / 教材库 / 首次使用引导，老师一眼能看到有哪些可用依据、还差什么
    const mats = listMaterials()
    const ima = credsStatus()
    const llm = llmStatus()
    emit(view(state, battle, {
      cmd,
      materials: { dir: mats.dir, count: mats.count, totalChars: mats.totalChars, items: mats.items },
      ima: { configured: ima.configured, boundSubjects: ima.boundSubjects, kbMap: ima.kbMap, credFile: CRED_FILE },
      llm: { mode: llm.mode, modeLabel: llm.modeLabel, configured: llm.configured, model: llm.llmModel, baseUrl: llm.llmBaseUrl },
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

      if (sub === 'test') {
        try {
          const r = await listKbs()
          emit({
            cmd: `${cmd} ${sub}`, ok: r.ok, connected: r.ok,
            kbCount: r.count || 0,
            kbs: (r.items || []).map((x) => x.name),
            error: r.ok ? undefined : '连上了但没拿到知识库列表，检查 Client ID / API Key 是否正确',
          })
          if (!r.ok) process.exitCode = 1
        } catch (e) {
          emit({ cmd: `${cmd} ${sub}`, ok: false, connected: false, error: String((e && e.message) || e) })
          process.exitCode = 1
        }
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

  /* ── LLM（可选，二选一：自备 API / WorkBuddy 积分） ── */
  if (cmd === 'llm') {
    const sub = a._[0] || 'status'
    try {
      if (sub === 'status') { emit({ cmd: `${cmd} ${sub}`, ...llmStatus() }); return }

      if (sub === 'config') {
        const patch = {}
        if (typeof a.key === 'string') patch.llmApiKey = a.key
        if (typeof a.model === 'string') patch.llmModel = a.model
        if (typeof a['base-url'] === 'string') patch.llmBaseUrl = a['base-url']
        if (Object.keys(patch).length === 0) {
          emit({
            ok: false,
            error: 'llm config 需要 --key <API Key>，可选 --model <模型> --base-url <地址>',
            example: `node "${process.argv[1]}" llm config --key "<Key>" --model "${DEFAULT_MODEL}" --base-url "${DEFAULT_BASE}"`,
            note: '不想填也没关系：不填就是 WorkBuddy 积分模式，由 WorkBuddy 自己的模型讲解与判分。',
          })
          process.exitCode = 1
          return
        }
        saveLlm(patch)
        emit({ cmd: `${cmd} ${sub}`, ...llmStatus() })
        return
      }

      if (sub === 'clear') {
        saveLlm({ llmApiKey: '', llmModel: DEFAULT_MODEL, llmBaseUrl: DEFAULT_BASE })
        emit({ cmd: `${cmd} ${sub}`, ...llmStatus(), note: '已回到 WorkBuddy 积分模式' })
        return
      }

      if (sub === 'test') { emit({ cmd: `${cmd} ${sub}`, ...(await testLlm()) }); return }

      emit({ ok: false, error: `未知子命令：llm ${sub}（用 help 查看用法）` })
      process.exitCode = 1
    } catch (e) {
      emit({ ok: false, error: String((e && e.message) || e) })
      process.exitCode = 1
    }
    return
  }

  /* ── 判分：有自备 API 就用它判；没有就交回给 WorkBuddy 自己判 ── */
  if (cmd === 'judge') {
    const subject = typeof a.subject === 'string' ? a.subject : ''
    const question = typeof a.question === 'string' ? a.question : ''
    const answer = typeof a.answer === 'string' ? a.answer : ''
    if (!answer) { emit({ ok: false, error: 'judge 需要 --answer <玩家的回答>' }); process.exitCode = 1; return }

    let points = []
    if (typeof a.points === 'string') points = a.points.split(/[;；|]/).map((s) => s.trim()).filter(Boolean)
    // 没显式给知识点时，带上该学科当前进度，供判分参考
    const subj = subject && state.subjects ? state.subjects[subject] : null

    const r = await judgeAnswer({ subject, question, answer, points, rubric: typeof a.rubric === 'string' ? a.rubric : '' })
    emit({
      cmd, subject: subject || null, level: levelOf(state),
      subjectProgress: subj ? { mastery: subj.mastery || 0, conquered: !!subj.conquered } : null,
      ...r,
      // 未配置自备 API 时，明确把下一步交给 Agent
      next: r.ok
        ? `用 apply --subject "${subject}" --mastery <按正确度给分> --mood <joy|disappointed> --note "<总评>" 写回游戏`
        : 'needsAgentJudgement=true：请你按上面列出/已知的知识点自己给 0-100 的正确度，挑盲点、写追问，再调 apply 写回游戏。',
      modes: {
        ownApi: `已配置自备 API，判定由 ${loadLlm().llmModel} 完成`,
        workbuddyCredits: '未配置自备 API —— 用 WorkBuddy 自己的积分，由你（Agent）判分',
      },
    })
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
