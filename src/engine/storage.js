// 存档读写：默认写到项目内 ./data/save.json（已 gitignore），可用 GALGAME_SAVE 覆盖。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createState, migrateState } from './game.js'

const DEFAULT_SAVE = resolve(process.cwd(), 'data/save.json')

export class Storage {
  /** @param {string} [file] 存档路径 */
  constructor(file = process.env.GALGAME_SAVE || DEFAULT_SAVE) {
    this.file = resolve(file)
  }

  /** 读存档；不存在或损坏时返回全新状态 */
  load() {
    try {
      if (!existsSync(this.file)) return createState()
      const raw = readFileSync(this.file, 'utf8')
      return migrateState(JSON.parse(raw))
    } catch {
      return createState()
    }
  }

  /** 写存档；失败静默（不阻断游戏） */
  save(state) {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(state), 'utf8')
      return true
    } catch {
      return false
    }
  }
}
