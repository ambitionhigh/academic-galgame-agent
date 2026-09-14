// 极简 .env 加载器（零依赖）：让 Node < 20.6（不支持 --env-file）也能读 .env。
// 已存在的环境变量优先，不被覆盖。
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

export function loadEnv(file = resolve(process.cwd(), '.env')) {
  if (!existsSync(file)) return false
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return false }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
  return true
}
