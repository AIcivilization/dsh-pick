// lib/market-source.js — 把 dsh-pick 的插件索引加进 DSH「插件 → 发现」的索引源
//
// 「发现」页由 DSH 的 pluginMarket 服务读用户配置的索引源（官方的实验功能「自定义插件索引」）。
// 它提供 listIndexes() 和 setIndexes(urls)：setIndexes 用整份列表替换，所以要带上已有的再加我们的。
//
// 规矩：装上后自动加一次；用户之后在「发现」里删掉了，就尊重他，不再自动加回来
// （本机 ~/.dsh/dsh-pick/market.json 记着加过没有）。设置页的按钮是用户明确要加，不受这条限制。

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { dshHome } from './engine.js'
import { INDEX_URL } from './market-index.js'

const stateFile = env => join(dshHome(env), 'dsh-pick', 'market.json')

async function readState(env) {
  try { return JSON.parse(await readFile(stateFile(env), 'utf8')) } catch { return {} }
}
async function writeState(env, state) {
  await mkdir(dirname(stateFile(env)), { recursive: true })
  await writeFile(stateFile(env), JSON.stringify(state))
}

/** listIndexes 的答复里的地址（每项可能是字符串，也可能是 { url, ... }） */
async function configured(market) {
  const list = await market.listIndexes()
  return (Array.isArray(list) ? list : []).map(x => (typeof x === 'string' ? x : x && x.url)).filter(Boolean)
}

const usable = market => Boolean(market && typeof market.listIndexes === 'function' && typeof market.setIndexes === 'function')

/**
 * 现在的状态（设置页显示用）
 * @returns {Promise<{available: boolean, added: boolean, url: string}>}
 */
export async function marketStatus(market) {
  if (!usable(market)) return { available: false, added: false, url: INDEX_URL }
  try {
    return { available: true, added: (await configured(market)).includes(INDEX_URL), url: INDEX_URL }
  } catch {
    return { available: false, added: false, url: INDEX_URL }
  }
}

/**
 * 把索引源加进去
 * @param {object} market DSH 的 pluginMarket 服务
 * @param {object} [opt]
 * @param {boolean} [opt.force] 用户在设置页点的：不管以前加过没有都加
 * @returns {Promise<{status: 'added'|'present'|'skipped'|'unavailable'|'failed', message?: string}>}
 */
export async function ensureMarketSource(market, { force = false, env = process.env } = {}) {
  if (!usable(market)) return { status: 'unavailable' }
  try {
    const urls = await configured(market)
    if (urls.includes(INDEX_URL)) {
      await writeState(env, { added: true, at: new Date().toISOString() })
      return { status: 'present' }
    }
    // 自动加过、现在又不在了：是用户自己删的
    if (!force && (await readState(env)).added) return { status: 'skipped' }
    await market.setIndexes([...urls, INDEX_URL])
    await writeState(env, { added: true, at: new Date().toISOString() })
    return { status: 'added' }
  } catch (e) {
    return { status: 'failed', message: e && e.message ? e.message : String(e) }
  }
}
