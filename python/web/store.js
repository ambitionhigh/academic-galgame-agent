// 教材本地持久化：把上传的教材存在**你自己的浏览器**里（IndexedDB）。
// 作用：刷新页面、关掉浏览器再回来，教材自动恢复到当前会话 —— 不用重新上传。
// 隐私：内容只存在本机浏览器，不会因为换设备而同步；「清空我的教材」会一并删除。

const DB_NAME = 'academic-galgame'
const STORE = 'corpus'
const VERSION = 1
const TIMEOUT_MS = 3000   // 存储不可用/被禁用时不能让应用卡死

/** 给可能挂起的 IndexedDB 操作加超时（无头浏览器、隐私模式、禁用存储等场景） */
function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('IndexedDB 操作超时（存储可能被禁用）')), ms)),
  ])
}

function openDb() {
  return withTimeout(new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('当前浏览器不支持 IndexedDB'))
    let req
    try { req = indexedDB.open(DB_NAME, VERSION) } catch (e) { return reject(e) }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'name' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IndexedDB 被其他标签页阻塞'))
  }))
}

/** 覆盖保存全部教材（[{name, subject, text}]） */
export async function saveStoredCorpus(files) {
  const db = await openDb()
  return withTimeout(new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite')
    const s = t.objectStore(STORE)
    s.clear()
    for (const f of files || []) s.put({ name: f.name, subject: f.subject || '', text: f.text })
    t.oncomplete = () => resolve(true)
    t.onerror = () => reject(t.error)
  }))
}

/** 读出全部教材 */
export async function loadStoredCorpus() {
  const db = await openDb()
  return withTimeout(new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  }))
}

/** 清空 */
export async function clearStoredCorpus() {
  const db = await openDb()
  return withTimeout(new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite')
    t.objectStore(STORE).clear()
    t.oncomplete = () => resolve(true)
    t.onerror = () => reject(t.error)
  }))
}
