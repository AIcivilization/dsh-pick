// lib/overall.js — 综合榜：把几个插件市场合成一个榜，一个插件只出现一次，按综合分排
//
// 收录来源（「收录于」）：
//   dshmarket  awesome-dsh-plugin 社区目录（dshmarket、dsh-m 的社区区用的都是它）
//   dsh-m      dsh-m 的人工精选清单（不算作者自己的那个区）
//   shop       dsh-plugin-shop 的目录
//   official   DeepSeek 官方的可选 / 按需插件
// npm 本身不算市场：它只是发布渠道。
//
// 综合分 0~100，五项加权；使用、关注两项先换成百分位，免得一个几十万星的仓库压倒一切：
//   使用 40%  日常基线（去噪）；没有去噪数据的，用周下载按全目录的「基线 / 日均下载」比例折算
//   关注 20%  GitHub 星标
//   维护 20%  最近一次发版或提交：今天满分，半年以上 0 分
//   共识 10%  被几个市场收录：多个市场都收，说明不止一个人觉得它值得列出来
//   健康 10%  健康度（去噪指标里的综合分）；没有的话看有没有许可证
// 一票否决（不进榜）：仓库已归档、没声明 dsh.bundle（DSH 装不了）、终端版插件。
//
// 只在 GitHub 上、没发到 npm 的插件也收：按 gh:owner/repo 合并，没有下载数据，使用项是 0。

export const MARKETS = ['dshmarket', 'dsh-m', 'shop', 'official']
/** 市场 → buildBoards 交出来的名单的 key */
const MEMBER_KEY = { dshmarket: 'community', 'dsh-m': 'picks', shop: 'shop', official: 'official' }
export const WEIGHTS = { use: 40, stars: 20, maint: 20, consensus: 10, health: 10 }
const KEEP = 300 // 落盘的行数（面板显示前面的，AI 工具也用它）
const DAY = 86400000

const repoKey = url => {
  const m = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/.exec(String(url || ''))
  return m ? `gh:${m[1]}/${m[2].replace(/\.git$/, '')}`.toLowerCase() : null
}
const median = a => {
  if (!a.length) return null
  const s = a.slice().sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** 一组数 → 每个数的百分位（0~1）。0 和空值算 0；相同的数百分位相同 */
export function percentiles(values) {
  const pos = values.map((v, i) => [v, i]).filter(([v]) => v > 0).sort((a, b) => a[0] - b[0])
  const out = new Array(values.length).fill(0)
  let i = 0
  while (i < pos.length) {
    let j = i
    while (j + 1 < pos.length && pos[j + 1][0] === pos[i][0]) j++
    const p = pos.length === 1 ? 1 : ((i + j) / 2) / (pos.length - 1)
    for (let k = i; k <= j; k++) out[pos[k][1]] = p
    i = j + 1
  }
  return out
}

/**
 * 使用、关注两项的 0~1：百分位和「对数值 / 最大对数值」各占一半。
 * 只用百分位，头部会饱和（下载量前 1% 的都接近满分，拉不开）；只用比例，一个巨型仓库会把其余压扁。
 * 输入已经是对数值
 */
export function spread(logs) {
  const p = percentiles(logs)
  const max = Math.max(0, ...logs)
  return logs.map((v, i) => (max > 0 ? (p[i] + Math.max(0, v) / max) / 2 : 0))
}

/** 维护分：最近一次发版或提交距今多少天 → 0~1 */
export function maintScore(dates, now = Date.now()) {
  const ts = dates.map(d => Date.parse(d || '')).filter(Number.isFinite)
  if (!ts.length) return null
  const days = Math.max(0, (now - Math.max(...ts)) / DAY)
  return Math.max(0, 1 - days / 180)
}

/**
 * @param {object} opt
 * @param {Record<string, object>} opt.packages 目录里的 npm 包（会就地写上 sc 综合分、src 收录于）
 * @param {Record<string, {n: string|null, repo: string|null, name: string, s?: number, added?: string}[]|null>} opt.members
 *   各市场的完整收录名单；某个市场这次抓不到就是 null，这时沿用 previousSrc
 * @param {Record<string, string[]>} [opt.previousSrc] 上次每个 npm 包的「收录于」
 * @returns {{ total: number, excluded: Record<string, number>, weights: object, markets: string[], rows: object[] }}
 */
export function buildOverall({ packages, members, previousSrc = {}, now = Date.now() }) {
  const cands = new Map() // key → 候选
  const npmKey = n => `npm:${n}`
  for (const rec of Object.values(packages)) {
    cands.set(npmKey(rec.n), { key: npmKey(rec.n), n: rec.n, rec, src: new Set(), stars: rec.gh ? rec.gh.s : null, repo: rec.ghUrl || rec.repo || null })
  }
  // 同一个仓库对应的 npm 包：只在 GitHub 上的条目如果其实发了 npm，并到 npm 那条上
  const npmByRepo = new Map()
  for (const c of cands.values()) {
    const k = repoKey(c.rec.gh ? `https://github.com/${c.rec.gh.repo}` : c.repo)
    if (k && !npmByRepo.has(k)) npmByRepo.set(k, c)
  }

  // 官方先处理：官方插件不在 npm 目录里，先建好候选，后面的市场（比如商店也收了它）才对得上
  for (const market of ['official', ...MARKETS.filter(m => m !== 'official')]) {
    const list = members[MEMBER_KEY[market]]
    if (!list) {
      // 这次抓不到：npm 包沿用上次的「收录于」
      for (const c of cands.values()) if ((previousSrc[c.n] || []).includes(market)) c.src.add(market)
      continue
    }
    for (const m of list) {
      let c = m.n ? cands.get(npmKey(m.n)) : null
      const rk = repoKey(m.repo)
      if (!c && rk) c = npmByRepo.get(rk) || cands.get(rk)
      if (!c && !m.n && rk) {
        // 只在 GitHub 上的插件
        c = { key: rk, n: null, name: m.name || rk.slice(3), repo: `https://github.com/${rk.slice(3)}`, src: new Set(), stars: null, added: null }
        cands.set(rk, c)
      }
      if (!c && m.n && market === 'official') {
        // 官方插件不在 npm 目录里（不带 dsh-plugin 关键字）：用官方榜带来的数据建一条
        const rec = { n: m.n, v: m.v || '', d: m.d || '', w: Number.isFinite(m.w) ? m.w : 0, t: m.t || null, official: true }
        c = { key: npmKey(m.n), n: m.n, rec, src: new Set(), stars: null, repo: null, outside: true }
        cands.set(c.key, c)
      }
      if (!c) continue // npm 名字不在目录里（多半是 npm 上已经没有了）
      c.src.add(market)
      if (c.stars == null && Number.isFinite(m.s)) c.stars = m.s
      if (!c.n && m.added && (!c.added || m.added < c.added)) c.added = m.added
    }
  }

  // 一票否决
  const excluded = {}
  const out = []
  for (const c of cands.values()) {
    const rec = c.rec
    const reason = rec && rec.gh && rec.gh.a ? '仓库已归档'
      : rec && rec.inst && rec.inst.b === false ? '没声明 dsh.bundle'
        : rec && rec.inst && rec.inst.p && rec.inst.p !== 'web' ? '终端版插件'
          : null
    if (reason) { excluded[reason] = (excluded[reason] || 0) + 1; continue }
    out.push(c)
  }

  // 没有去噪数据的包：周下载按「日常基线 / 日均周下载」的中位比例折算成基线
  const ratios = Object.values(packages).filter(r => r.deep && r.w > 0 && r.deep.base > 0).map(r => r.deep.base / (r.w / 7))
  const ratio = median(ratios) ?? 0.5
  const useOf = c => (c.rec ? (c.rec.deep ? c.rec.deep.base : (c.rec.w || 0) / 7 * ratio) : 0)
  const useP = spread(out.map(c => Math.log1p(useOf(c))))
  const starP = spread(out.map(c => Math.log1p(c.stars || 0)))

  out.forEach((c, i) => {
    const rec = c.rec
    const d = rec && rec.deep
    const m = maintScore([d && d.lastRelease, rec && rec.t, rec && rec.gh && rec.gh.p], now)
    const parts = {
      use: useP[i],
      stars: starP[i],
      maint: m ?? 0.4, // 不知道就给个中间偏下的分
      consensus: c.src.size / MARKETS.length,
      health: d && Number.isFinite(d.s) ? d.s / 100 : rec && rec.gh && rec.gh.l ? 0.6 : 0.4,
    }
    c.parts = parts
    c.score = Math.round(Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + parts[k] * w, 0))
    if (rec) {
      rec.sc = c.score
      rec.src = [...c.src]
    }
  })
  out.sort((a, b) => b.score - a.score || (b.rec ? b.rec.w || 0 : 0) - (a.rec ? a.rec.w || 0 : 0))

  const pct = v => Math.round(v * 100)
  return {
    total: out.length,
    excluded,
    weights: WEIGHTS,
    markets: MARKETS,
    useRatio: Math.round(ratio * 1000) / 1000,
    rows: out.slice(0, KEEP).map(c => {
      const rec = c.rec
      const row = {
        k: c.n || c.key, // npm 包名，或 gh:owner/repo
        n: c.n,
        sc: c.score,
        p: [pct(c.parts.use), pct(c.parts.stars), pct(c.parts.maint), pct(c.parts.consensus), pct(c.parts.health)],
        src: [...c.src],
      }
      if (!c.n) {
        row.name = c.name
        row.repo = c.repo
        if (c.added) row.added = c.added
      }
      // 不在 npm 目录里的（官方插件）：面板查不到它的记录，名字、版本、下载量跟着行走
      if (c.outside) Object.assign(row, { name: rec.n, v: rec.v, d: rec.d, w: rec.w })
      if (c.stars != null) row.s = c.stars
      if (rec && rec.deep && rec.deep.lastRelease) row.last = rec.deep.lastRelease
      else if (rec && rec.t) row.last = String(rec.t).slice(0, 10)
      return row
    }),
  }
}
