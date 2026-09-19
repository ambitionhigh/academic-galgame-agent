/**
 * PDF 最底层的字节操作 —— textract.js 和 visionread.js 共用这一份。
 *
 * 为什么要单独一个文件：抽正文（textract）和抠页面图（visionread）都要
 * 「遍历对象 → 取字典 → 取流」。同一件事写两遍就是两个 owner，
 * 改一处忘一处必然对不上，所以只留这一份实现。
 *
 * 全部只依赖字符串操作，零第三方依赖。
 */

/** 带捕获组的全局匹配 → 返回每次匹配的完整数组 */
export function* matchAll(s, re) {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let m
  while ((m = r.exec(s))) {
    yield m
    if (m.index === r.lastIndex) r.lastIndex++
  }
}

const OBJ_RE = /(\d+)\s+(\d+)\s+obj\b/g

/** 把 `12 0 obj ... endobj` 全部收成 Map<对象号, 对象体> */
export function findObjects(s) {
  const objs = new Map()
  let m
  OBJ_RE.lastIndex = 0
  while ((m = OBJ_RE.exec(s))) {
    const num = parseInt(m[1], 10)
    let end = s.indexOf('endobj', m.index + m[0].length)
    if (end < 0) end = s.length
    objs.set(num, s.slice(m.index + m[0].length, end))   // 后出现的覆盖前面的，与 Python 一致
  }
  return objs
}

/** 取对象体里最外层的一对 `<< >>`（会正确地跨过嵌套的字典） */
export function dictOf(body) {
  const start = body.indexOf('<<')
  if (start < 0) return ''
  let depth = 0
  let i = start
  while (i < body.length - 1) {
    if (body[i] === '<' && body[i + 1] === '<') { depth++; i += 2; continue }
    if (body[i] === '>' && body[i + 1] === '>') {
      depth--
      i += 2
      if (depth === 0) return body.slice(start, i)
      continue
    }
    i++
  }
  return body.slice(start)
}

/** 取 `stream ... endstream` 之间的原始字节（**未解压**） */
export function streamOf(body) {
  const i = body.indexOf('stream')
  if (i < 0) return ''
  let j = i + 6
  if (body.slice(j, j + 2) === '\r\n') j += 2
  else if (body[j] === '\n' || body[j] === '\r') j += 1

  // 优先信 /Length：它是权威值。`endstream` 前面那个换行是**分隔符、不算数据**，
  // 而流数据本身完全可能就以换行结尾 —— 靠「去掉末尾换行」猜会把真实字节吃掉。
  // （间接引用 `/Length 12 0 R` 取不到数值，退回下面的按标记切。）
  const lm = body.slice(0, i).match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/)
  if (lm) {
    const n = parseInt(lm[1], 10)
    if (n > 0 && j + n <= body.length) return body.slice(j, j + n)
  }

  const k = body.lastIndexOf('endstream')
  if (k <= j) return ''
  let end = k
  if (body[end - 2] === '\r' && body[end - 1] === '\n') end -= 2
  else if (body[end - 1] === '\n' || body[end - 1] === '\r') end -= 1
  return body.slice(j, end)
}
