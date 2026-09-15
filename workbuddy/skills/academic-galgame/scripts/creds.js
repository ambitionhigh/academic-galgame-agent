// 本地凭证（ima 与 LLM 共用一份文件）
//
//   ${GALGAME_HOME:-~/.workbuddy/academic-galgame}/credentials.json
//   写入时权限 0600；环境变量优先于文件
//
// 为什么放一起：技能只需要「两份外部 API 连接」——
//   · ima 知识库 API（资料依据，必填）
//   · LLM API（可选：不填就用 WorkBuddy 自己的积分/模型）
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOME = process.env.GALGAME_HOME || join(homedir(), '.workbuddy', 'academic-galgame')
export const CRED_FILE = join(HOME, 'credentials.json')

/** 只读文件内容（不含环境变量覆盖） */
export function readCredsFile() {
  try {
    const j = JSON.parse(readFileSync(CRED_FILE, 'utf8'))
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {}
  } catch {
    return {}
  }
}

/** 合并写入（权限 0600） */
export function saveCreds(patch) {
  const next = { ...readCredsFile(), ...patch }
  mkdirSync(HOME, { recursive: true })
  writeFileSync(CRED_FILE, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(CRED_FILE, 0o600) } catch { /* Windows 上忽略 */ }
  return next
}

/** 打码显示（只露头尾） */
export const mask = (v) => (v ? `${v.slice(0, 6)}…${v.slice(-4)}（长度 ${v.length}）` : '')
