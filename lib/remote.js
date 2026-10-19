// lib/remote.js — 每日更新的目录
//
// GitHub Actions 每天跑一次 dsh-pick build，把 catalog.json 和一个很小的 meta.json 推到本仓库的
// catalog 分支（.github/workflows/catalog.yml）。插件在 DSH 里启动时、之后每 6 小时问一次：
// 先取 meta.json 比新旧，真有更新才下载完整目录（约 1.5 MB），校验后原子写进 ~/.dsh/dsh-pick/，
// 再换上新目录。取不到（没网、被墙）就继续用手上的，什么都不报——随包自带的那份永远兜底。
//
// 镜像按顺序试：jsDelivr 国内一般能直连；raw.githubusercontent.com 兜底。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { cachePath, dshHome, loadCatalog, newerCatalog, reloadCatalog } from './engine.js'

export const REPO = 'AIcivilization/dsh-pick'
export const BRANCH = 'catalog'
export const MIRRORS = [
  `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/`,
  `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`,
]
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const TIMEOUT_MS = { meta: 8000, catalog: 60000 }

const statePath = env => join(dshHome(env), 'dsh-pick', 'remote.json')

async function readState(env) {
  try {
    return JSON.parse(await readFile(statePath(env), 'utf8'))
  } catch {
    return {}
  }
}

async function writeAtomic(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

async function getJson(fetchImpl, url, timeoutMs) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/** 下载来的目录像不像样：包够多、字段齐。防止镜像返回半截文件或错误页 */
export function validCatalog(cat) {
  if (!cat || typeof cat !== 'object' || !cat.packages || typeof cat.packages !== 'object') return false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(cat.anchor || ''))) return false
  const list = Object.values(cat.packages)
  return list.length >= 500 && list.slice(0, 50).every(r => r && typeof r.n === 'string' && typeof r.w === 'number')
}

/**
 * 检查并下载更新的目录。
 * @param {object} [opt]
 * @param {boolean} [opt.force] 不管 6 小时内查过没有，马上查
 * @returns {Promise<{checked: boolean, updated: boolean, anchor?: string, mirror?: string, error?: string}>}
 */
export async function refreshCatalog({ fetchImpl = globalThis.fetch, env = process.env, force = false, now = Date.now } = {}) {
  const state = await readState(env)
  if (!force && state.checkedAt && now() - Date.parse(state.checkedAt) < CHECK_EVERY_MS) {
    return { checked: false, updated: false }
  }
  const current = await loadCatalog({ env })
  let lastError = ''
  for (const base of MIRRORS) {
    try {
      const meta = await getJson(fetchImpl, base + 'meta.json', TIMEOUT_MS.meta)
      const done = async (result) => {
        await writeAtomic(statePath(env), JSON.stringify({ checkedAt: new Date(now()).toISOString(), anchor: meta.anchor || null, mirror: base }))
        return result
      }
      // meta 不比手上的新：不下载
      if (!newerCatalog({ ...meta, packages: {} }, current)) return done({ checked: true, updated: false, anchor: current.anchor, mirror: base })
      const cat = await getJson(fetchImpl, base + 'catalog.json', TIMEOUT_MS.catalog)
      if (!validCatalog(cat)) throw new Error('目录文件不完整')
      if (!newerCatalog(cat, current)) return done({ checked: true, updated: false, anchor: current.anchor, mirror: base })
      await writeAtomic(cachePath(env), JSON.stringify(cat))
      reloadCatalog({ ...cat, source: 'remote' })
      return done({ checked: true, updated: true, anchor: cat.anchor, mirror: base })
    } catch (e) {
      lastError = e && e.message ? e.message : String(e)
    }
  }
  // 都连不上：不记 checkedAt，下一轮再试
  return { checked: true, updated: false, error: lastError }
}

/** 最近一次检查的记录（设置页显示用） */
export function remoteState(env = process.env) {
  return readState(env)
}
