// lib/badges.js — 插件作者贴进 README 的排名徽章
//
// 每日构建时给综合榜（综合推荐角度）里的每个插件写一个 shields.io endpoint 文件，
// 和目录一起推到 catalog 分支的 badge/ 目录下：
//   npm 包      badge/<包名>.json        （带 scope 的就是 badge/@scope/name.json）
//   只在 GitHub badge/gh/<owner>/<repo>.json
// 徽章图片由 shields.io 读这个文件画出来（BADGE_IMG），点徽章进 dsh-pick 的 GitHub。
// 名次的算法和面板一致（web/panel.js 的 overallPool + angleRank）：存下来的头部行加上每个 npm 包自带的 oa 分数。

import { ANGLES } from './overall.js'

export const REPO = 'AIcivilization/dsh-pick'
export const BADGE_BASE = `https://raw.githubusercontent.com/${REPO}/catalog/badge/`
export const BADGE_LINK = `https://github.com/${REPO}`

// 徽章左边的小图标：和 DSH 里 dsh-pick 页签的图标同一条折线，白色
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M6 22l6-7 5 5 9-11" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** 一个插件的徽章文件在 catalog 分支里的相对路径（badge/ 之后的部分） */
export function badgePath(key) {
  const k = String(key)
  return (k.startsWith('gh:') ? 'gh/' + k.slice(3) : k) + '.json'
}

/** 徽章图片地址（shields.io 读 endpoint 文件） */
export function badgeImage(key) {
  return 'https://img.shields.io/endpoint?url=' + encodeURIComponent(BADGE_BASE + badgePath(key))
}

/** 贴进 README 的 Markdown */
export function badgeMarkdown(key) {
  return `[![dsh-pick](${badgeImage(key)})](${BADGE_LINK})`
}

/**
 * 综合推荐角度下每个插件的名次。
 * @returns {{ ranks: Map<string, number>, total: number }}
 */
export function overallRanks(catalog) {
  const o = catalog && catalog.boards && catalog.boards.overall
  if (!o || !Array.isArray(o.rows)) return { ranks: new Map(), total: 0 }
  const angles = o.angles || ANGLES
  const ai = angles.indexOf('rec')
  const seen = new Set(o.rows.map(r => r.k))
  const pool = o.rows.filter(r => r.a && r.a.rec != null).map(r => ({ k: r.k, v: r.a.rec, w: wOf(catalog, r) }))
  for (const rec of Object.values(catalog.packages || {})) {
    if (!rec.oa || seen.has(rec.n) || rec.oa[ai] == null) continue
    pool.push({ k: rec.n, v: rec.oa[ai], w: rec.w || 0 })
  }
  pool.sort((x, y) => y.v - x.v || y.w - x.w)
  return { ranks: new Map(pool.map((r, i) => [r.k, i + 1])), total: Math.max(o.total || 0, pool.length) }
}

function wOf(catalog, row) {
  const rec = row.n && catalog.packages && catalog.packages[row.n]
  return rec ? rec.w || 0 : row.w || 0
}

/** shields.io endpoint 的内容。名次靠前写「#12 of 14,074」，往后写「top 23%」，没上榜写「listed」 */
export function badgeJson(rank, total) {
  const base = { schemaVersion: 1, label: 'dsh-pick', logoSvg: LOGO, cacheSeconds: 21600 }
  if (!rank || !total) return { ...base, message: 'listed', color: 'lightgrey' }
  const share = rank / total
  const message = rank <= 100
    ? `#${rank} of ${total.toLocaleString('en-US')}`
    : `top ${Math.max(1, Math.ceil(share * 100))}%`
  const color = rank <= 10 ? 'brightgreen' : rank <= 100 ? 'green' : share <= 0.1 ? 'yellowgreen' : 'blue'
  return { ...base, message, color }
}

/**
 * 整个目录的徽章文件：已排名的插件给名次，目录里收录了但没排名的 npm 包给「listed」。
 * @returns {Array<[string, object]>} [相对路径, 内容]
 */
export function buildBadges(catalog) {
  const { ranks, total } = overallRanks(catalog)
  const out = []
  for (const [k, rank] of ranks) out.push([badgePath(k), badgeJson(rank, total)])
  for (const name of Object.keys(catalog.packages || {})) {
    if (!ranks.has(name)) out.push([badgePath(name), badgeJson(0, total)])
  }
  return out
}
