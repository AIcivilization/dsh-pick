// lib/boards.js — npm、GitHub 之外的榜单数据
//
//   official   DeepSeek 官方包 @deepseek-ai/dsh-official-bundles 列出的可选 / 按需插件
//   community  awesome-dsh-plugin 社区目录（dshmarket 用的也是它）：有星标、30 天下载、收录日期
//   shop       dsh-plugin-shop 的目录（第三方，不是 DeepSeek 官方）：有星标、收录日期，没有下载量
//
// 每日构建时抓一次，只存每个榜的头部（整份目录十几 MB，界面用不上）；社区目录里的 npm 包名另外补进
// npm 目录（见 engine.js 的 addCommunity），让搜索和 npm 榜也能找到。这些都是别人维护的外部数据，
// 所以只摘需要的字段、校验类型和链接；官方包只按文本解析，绝不执行从网上下载的代码。

const OFFICIAL_JS = 'https://cdn.jsdelivr.net/npm/@deepseek-ai/dsh-official-bundles@latest/lib/index.js'
const COMMUNITY_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const SHOP_BASE = 'https://LivXue.github.io/dsh-plugin-shop/v1/'
// dsh-m 的精选清单（人工挑的，分「装机必备」等几个区）；jsDelivr 比 raw.githubusercontent.com 稳
const PICKS_URL = 'https://cdn.jsdelivr.net/gh/iasiv5/dsh-m@main/registry.json'
// 精选清单里这个区是 dsh-m 作者自己的插件，不算「推荐」
const SELF_PROMO = new Set(['self-dev'])
const REGISTRY = 'https://registry.npmjs.org/'
const DOWNLOADS = 'https://api.npmjs.org/downloads/point/last-week/'
const TOP = 100

const text = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const count = v => (Number.isFinite(v) && v >= 0 ? v : null)
const date = v => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null)
export const npmName = v => (typeof v === 'string' && /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(v) ? v : null)
/** 只留 https 的代码托管地址：链接要放进页面，别的协议和站点一律不要 */
export const repoUrl = v => {
  const m = /^https:\/\/(github\.com|gitlab\.com)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.exec(String(v || ''))
  return m ? m[0].replace(/\.git$/, '') : null
}
const zh = v => (v && typeof v === 'object' ? text(v.zh) || text(v.en) : text(v))

/** 仓库填成 DSH 本体的，星标不算在插件头上（同 github.js 的 countsForPlugin） */
const ownStars = (stars, repo) => (/github\.com\/deepseek-ai\//i.test(String(repo || '')) ? null : stars)

/** 每个指标各取头部，合并去重：换个排序也有足够的数据 */
function topRows(rows, metrics) {
  const keep = new Set()
  for (const by of metrics) {
    rows.filter(r => r[by] != null).sort((a, b) => (b[by] > a[by] ? 1 : b[by] < a[by] ? -1 : 0)).slice(0, TOP).forEach(r => keep.add(r))
  }
  return [...keep]
}

/** 从官方包的 JS 文本里摘出插件列表（只解析，不执行） */
export function parseOfficial(source) {
  const src = String(source || '')
  const out = new Map()
  const optional = /OPTIONAL_BUNDLES\s*=\s*\[([\s\S]*?)\]/.exec(src)
  if (optional) {
    for (const m of optional[1].matchAll(/"([^"]+)"/g)) {
      if (npmName(m[1])) out.set(m[1], { n: m[1], kind: 'optional', t: '', d: '' })
    }
  }
  const start = src.search(/OFFICIAL_ON_DEMAND_CATALOG\s*=\s*\[/)
  if (start >= 0) {
    const parts = src.slice(start).split(/packageName:\s*/).slice(1)
    for (const part of parts) {
      const name = /^"([^"]+)"/.exec(part)
      if (!name || !npmName(name[1])) continue
      const zhOf = key => {
        const block = new RegExp(`${key}:\\s*\\{([\\s\\S]*?)\\}`).exec(part)
        const m = block && /"zh":\s*"((?:[^"\\]|\\.)*)"/.exec(block[1])
        return m ? text(m[1]) : ''
      }
      out.set(name[1], { n: name[1], kind: 'ondemand', t: zhOf('title'), d: zhOf('description') })
    }
  }
  return [...out.values()]
}

/** 社区目录 → 榜单 */
export function communityBoard(doc) {
  const list = doc && Array.isArray(doc.plugins) ? doc.plugins : []
  const rows = list.map(p => ({
    n: npmName(p && p.npm),
    name: text(p && p.name, 80),
    repo: repoUrl(p && p.url),
    s: ownStars(count(p && p.stars), repoUrl(p && p.url)),
    dl: count(p && p.downloads),
    added: date(p && p.added),
    d: zh(p && p.description),
  })).filter(r => r.name && (r.n || r.repo))
  return { total: rows.length, updated: date(doc && doc.updated), rows: topRows(rows, ['s', 'dl', 'added']), all: rows }
}

/**
 * 社区目录 → 补进 npm 目录的包：校验包名、去重，只摘补记录要用的字段
 * @returns {{n: string, m: number|null, repo: string|null}[]} n 包名 · m 30 天下载（和搜索接口的月下载基本一致）· repo 仓库
 */
export function communityPackages(doc) {
  const list = doc && Array.isArray(doc.plugins) ? doc.plugins : []
  const out = new Map()
  for (const p of list) {
    const n = npmName(p && p.npm)
    if (n && !out.has(n)) out.set(n, { n, m: count(p.downloads), repo: repoUrl(p.url) })
  }
  return [...out.values()]
}

/** 下载社区目录（约 12 MB）。构建时只下一次，补目录和社区榜共用 */
export const loadCommunity = (fetchImpl = globalThis.fetch) => getJson(fetchImpl, COMMUNITY_URL, 180000)

/** 插件商店的目录 + 星标表 → 榜单。星标表按 owner/repo 或包名记 */
export function shopBoard(plugins, stars) {
  const list = Array.isArray(plugins) ? plugins : (plugins && plugins.plugins) || []
  const table = (stars && stars.stars) || stars || {}
  const rows = list.map(p => {
    const repo = repoUrl(p && p.repository)
    const key = repo ? repo.replace(/^https:\/\/[^/]+\//, '') : ''
    return {
      n: p && p.source === 'npm' ? npmName(p.name) : null,
      name: text(p && p.name, 80),
      repo,
      s: ownStars(count(table[key] ?? table[p && p.name]), repo),
      added: date(p && p.added),
      d: zh(p && p.catalog && p.catalog.summary),
    }
  }).filter(r => r.name && (r.n || r.repo))
  return { total: rows.length, rows: topRows(rows, ['s', 'added']), all: rows }
}

async function getJson(fetchImpl, url, ms) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

async function loadOfficial(fetchImpl) {
  const r = await fetchImpl(OFFICIAL_JS, { signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const rows = parseOfficial(await r.text())
  if (!rows.length) throw new Error('官方包里没解析出插件')
  await Promise.all(rows.map(async row => {
    const enc = row.n.replace('/', '%2f')
    const [meta, dl] = await Promise.all([
      getJson(fetchImpl, `${REGISTRY}${enc}/latest`, 15000).catch(() => null),
      getJson(fetchImpl, `${DOWNLOADS}${enc}`, 15000).catch(() => null),
    ])
    row.v = meta ? text(meta.version, 40) : ''
    // 最近一次发布的时间：精简版 packument 的 modified（综合榜的维护分要用）
    const brief = await fetchImpl(`${REGISTRY}${enc}`, { headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(15000) })
      .then(r => (r.ok ? r.json() : null)).catch(() => null)
    row.t = brief && date(brief.modified) ? brief.modified : null
    if (!row.d && meta) row.d = text(meta.description)
    row.w = dl ? count(dl.downloads) : null
  }))
  return { total: rows.length, rows }
}

async function loadShop(fetchImpl, members) {
  const index = await getJson(fetchImpl, `${SHOP_BASE}index.json`, 30000)
  const [plugins, stars] = await Promise.all([
    getJson(fetchImpl, SHOP_BASE + index.plugins.url, 180000),
    getJson(fetchImpl, SHOP_BASE + index.stars.url, 60000),
  ])
  const board = shopBoard(plugins, stars)
  members.shop = board.all
  delete board.all
  return board
}

/**
 * dsh-m 精选清单 → 收录名单（不算作者自己那个区）
 * @returns {{n: string|null, repo: string|null, name: string}[]}
 */
export function picksMembers(doc) {
  const list = doc && Array.isArray(doc.plugins) ? doc.plugins : []
  return list
    .filter(p => p && !(SELF_PROMO.has(p.category) && !(p.alsoCategories || []).some(c => !SELF_PROMO.has(c))))
    .map(p => ({
      n: npmName(p.npm),
      repo: typeof p.github === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.github) ? `https://github.com/${p.github}` : null,
      name: text(p.name || p.id, 80),
    }))
    .filter(r => r.n || r.repo)
}

/**
 * 抓全部榜单。某个来源这次抓不到，就沿用上次的那份，不让一个榜拖垮整个构建
 * @param {object} [opt]
 * @param {object} [opt.previous] 上一次的 boards
 * @param {object} [opt.communityDoc] 已经下载好的社区目录，有就不再下一次
 */
export async function buildBoards({ fetchImpl = globalThis.fetch, previous = {}, communityDoc = null, members = {}, onProgress = () => {} } = {}) {
  // members：各市场的完整收录名单（综合榜算「收录于」要用），不落盘；抓不到的那个市场留 null
  members.community = null
  members.shop = null
  members.official = null
  members.picks = null
  const sources = {
    official: async () => {
      const board = await loadOfficial(fetchImpl)
      // 官方包大多不带 dsh-plugin 关键字，不在 npm 目录里：把周下载、版本、说明带上，综合榜直接用
      members.official = board.rows.map(r => ({ n: r.n, repo: null, name: r.n, w: r.w, v: r.v, d: r.d, t: r.t }))
      return board
    },
    community: async () => {
      const board = communityBoard(communityDoc || await loadCommunity(fetchImpl))
      members.community = board.all
      delete board.all
      return board
    },
    shop: () => loadShop(fetchImpl, members),
  }
  try {
    members.picks = picksMembers(await getJson(fetchImpl, PICKS_URL, 30000))
    onProgress(`  dsh-m 精选：${members.picks.length} 个（不含作者自己的）`)
  } catch (e) {
    onProgress(`  dsh-m 精选抓不到（${e.message}）`)
  }
  const boards = {}
  for (const [key, load] of Object.entries(sources)) {
    try {
      boards[key] = await load()
      onProgress(`  榜单 ${key}：共 ${boards[key].total} 个，保留 ${boards[key].rows.length} 行`)
    } catch (e) {
      onProgress(`  榜单 ${key} 抓不到（${e.message}），沿用上次的`)
      if (previous && previous[key]) boards[key] = previous[key]
    }
  }
  return boards
}
