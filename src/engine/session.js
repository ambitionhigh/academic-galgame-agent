// 会话层：持有「存档状态 + 当前战斗态」，把引擎能力暴露成一组工具方法。
// agent 层只通过这里改动游戏，不直接碰 state/battle 内部结构。
import { Storage } from './storage.js'
import { createState, statusView, applyTeaching, addSubject } from './game.js'
import { startBattle, applyBattle, battleView } from './battle.js'

export class GameSession {
  constructor(storage = new Storage()) {
    this.storage = storage
    this.state = storage.load()
    /** 战斗态：仅内存，进程重启即清空（设计如此） */
    this.battle = null
  }

  save() { this.storage.save(this.state) }

  /** 完整状态视图（UI 与 LLM 共用） */
  status() { return statusView(this.state, battleView(this.battle)) }

  /**
   * 教学/答题结算（非战斗）。
   * @param {{subject?:string, masteryDelta?:number, favorabilityDelta?:number, hpDelta?:number, mood?:string, note?:string}} args
   */
  teaching(args) {
    const view = applyTeaching(this.state, args)
    this.save()
    return view
  }

  addSubject(name) {
    const r = addSubject(this.state, name)
    this.save()
    return r
  }

  battleStart(subject, enemy) {
    const b = startBattle(this.state, subject, enemy)
    this.battle = b
    this.save()
    return { ok: true, battle: battleView(b) }
  }

  battleApply(args) {
    if (!this.battle) throw new Error('当前没有进行中的战斗（请先 ag_battle_start 开战）')
    const { result, battle } = applyBattle(this.state, this.battle, args)
    this.battle = battle
    this.save()
    return { ...result, battle: battleView(battle) }
  }

  battleRetreat() {
    const had = this.battle
    this.battle = null
    return { ok: true, cleared: !!had, message: had ? `已撤退（${had.subject}）` : '没有进行中的战斗' }
  }

  reset() {
    this.state = createState()
    this.battle = null
    this.save()
    return this.status()
  }
}
