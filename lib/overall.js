// lib/overall.js — 综合榜：把几个插件市场合成一个榜，一个插件只出现一次，按综合分排
//
// 收录来源（「收录于」）：
//   dshmarket  awesome-dsh-plugin 社区目录（dshmarket、dsh-m 的社区区用的都是它）
//   dsh-m      dsh-m 的人工精选清单（不算作者自己的那个区）
//   shop       dsh-plugin-shop 的目录
//   official   DeepSeek 官方的可选 / 按需插件
// npm 本身不算市场：它只是发布渠道。
//
// 排名有六个角度（面板里切换；同一份数据，权重不同，每个角度的算法写在页面上）：
//   rec     综合推荐  使用 30 + 关注 15 + 维护 15 + 精选 15 + 稳定 15 + 覆盖 10
//   use     最多人用  只看日常基线（去噪），没有去噪数据的不参与
//   rep     口碑      GitHub 星标 65% + 被精选或官方收录 35%
//   stable  稳定可靠  上架满 60 天；版本节奏平稳、有许可证、未关闭问题少、还在维护，再加一点使用量
//   rise    上升最快  有一定使用量（日常基线 ≥ 20/天）的前提下看近 7 日增速
//   new     新上架    最近 30 天才被市场收录的
// 和第一版（使用 40% 起步）相比改了三处，都是为了少奖励「刷出来的数字」：
//   - 下载量从 40% 降到 30%：npm 下载里有 CI、镜像、自动更新的拉取，发版越勤数字越高
//   - 维护只看「还在不在维护」（60 天内有发版或提交就满分），不再按发版频率加分，免得和下载量重复奖励频繁发版
//   - 「共识」拆成两项：精选（dsh-m 精选、DeepSeek 官方，有人挑过）15%；覆盖（被几个市场收录，多是按关键字自动收录）10%
// 使用、关注两项取「百分位」和「对数比例」的平均，不让一个几十万星的仓库压倒一切。
// 一票否决（不进榜）：仓库已归档、没声明 dsh.bundle（DSH 装不了）、终端版插件。
//
// 只在 GitHub 上、没发到 npm 的插件也收：按 gh:owner/repo 合并，没有下载数据，使用项是 0。

export const MARKETS = ['dshmarket', 'dsh-m', 'shop', 'official']
/** 市场 → buildBoards 交出来的名单的 key */
const MEMBER_KEY = { dshmarket: 'community', 'dsh-m': 'picks', shop: 'shop', official: 'official' }
export const WEIGHTS = { use: 30, stars: 15, maint: 15, curated: 15, stable: 15, reach: 10 }
export const ANGLES = ['rec', 'use', 'rep', 'stable', 'rise', 'new']
const KEEP_PER_ANGLE = 120 // 每个角度落盘前多少名（合并去重后一起存）
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

/** 维护分：最近一次发版或提交距今多少天 → 0~1。60 天内都算「还在维护」给满分，之后到 180 天线性降到 0 */
export function maintScore(dates, now = Date.now()) {
  const ts = dates.map(d => Date.parse(d || '')).filter(Number.isFinite)
  if (!ts.length) return null
  const days = Math.max(0, (now - Math.max(...ts)) / DAY)
  return days <= 60 ? 1 : Math.max(0, 1 - (days - 60) / 120)
}

const clamp01 = x => Math.max(0, Math.min(1, x))

/**
 * 稳定分 0~1：上架时间、版本节奏是否平稳、有没有许可证、未关闭问题多不多
 * @param {{firstDays: number|null, cadence: number|null, license: boolean|null, issues: number|null, stars: number|null}} f
 */
export function stableScore({ firstDays, cadence, license, issues, stars }) {
  const age = firstDays == null ? 0.5 : clamp01(firstDays / 60)
  // 0.5 天一个版本以下算「发得太勤」（0 分），3 天以上算平稳（满分）
  const calm = cadence == null ? 0.5 : clamp01((cadence - 0.5) / 2.5)
  const lic = license == null ? 0.3 : license ? 1 : 0
  // 每 10 个星标里有几个没关的 issue/PR：越少越好
  const iss = issues == null ? 0.5 : 1 - clamp01(issues / ((stars || 0) + 10) * 2)
  return 0.35 * age + 0.25 * calm + 0.2 * lic + 0.2 * iss
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
      // 第一次被市场收录的日期（「新上架」「稳定可靠」要用）
      if (m.added && (!c.added || m.added < c.added)) c.added = m.added
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
  // 「最多人用」只认真实的去噪基线
  const deepIdx = out.map((c, i) => (c.rec && c.rec.deep ? i : -1)).filter(i => i >= 0)
  const deepP = spread(deepIdx.map(i => Math.log1p(out[i].rec.deep.base)))
  const deepUse = new Map(deepIdx.map((i, k) => [i, deepP[k]]))
  // 「上升最快」：日常基线 ≥ 20/天、有增速的，按增速排百分位
  const riseIdx = out.map((c, i) => (c.rec && c.rec.deep && c.rec.deep.base >= 20 && Number.isFinite(c.rec.deep.growth) ? i : -1)).filter(i => i >= 0)
  const riseP = percentiles(riseIdx.map(i => out[i].rec.deep.growth + 1)) // +1：增速可能是负数，百分位只认正数
  const riseOf = new Map(riseIdx.map((i, k) => [i, riseP[k]]))

  const curatedSet = new Set(['dsh-m', 'official'])
  out.forEach((c, i) => {
    const rec = c.rec
    const d = rec && rec.deep
    const gh = rec && rec.gh
    const firstDays = c.added ? Math.max(0, Math.floor((now - Date.parse(c.added)) / DAY)) : null
    const maint = maintScore([d && d.lastRelease, rec && rec.t, gh && gh.p], now)
    const stable = stableScore({ firstDays, cadence: d ? d.cadence : null, license: gh ? Boolean(gh.l) : null, issues: gh ? gh.i : null, stars: c.stars })
    const curated = [...c.src].some(m => curatedSet.has(m)) ? 1 : 0
    const parts = {
      use: useP[i],
      stars: starP[i],
      maint: maint ?? 0.4, // 不知道就给个中间偏下的分
      curated,
      stable,
      reach: c.src.size / MARKETS.length,
    }
    c.parts = parts
    c.firstDays = firstDays
    const rec100 = Math.round(Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + parts[k] * w, 0))
    c.a = {
      rec: rec100,
      use: deepUse.has(i) ? Math.round(deepUse.get(i) * 100) : null,
      rep: c.stars || curated ? Math.round((0.65 * starP[i] + 0.35 * curated) * 100) : null,
      stable: firstDays != null && firstDays >= 60 && (maint ?? 0) > 0 ? Math.round((0.7 * stable + 0.3 * useP[i]) * 100) : null,
      rise: riseOf.has(i) ? Math.round(riseOf.get(i) * 100) : null,
      new: firstDays != null && firstDays <= 30 ? Math.round((1 - firstDays / 30) * 60 + useP[i] * 40) : null,
    }
    c.score = rec100
    if (rec && !c.outside) {
      rec.sc = rec100
      rec.src = [...c.src]
      // 每个 npm 包都存一份六个角度的分数（顺序同 ANGLES，不参与的为 null）和第一次被收录的日期：
      // 面板按分类筛选、给「我的监控」里的插件算名次，都要在全部插件里排，不能只看存下来的头部
      rec.oa = ANGLES.map(k => c.a[k])
      if (c.added) rec.ad = c.added
    }
  })

  // 每个角度取前 KEEP_PER_ANGLE 名，合并去重；按综合推荐排
  const keep = new Set()
  for (const angle of ANGLES) {
    out.filter(c => c.a[angle] != null)
      .sort((x, y) => y.a[angle] - x.a[angle] || (y.rec ? y.rec.w || 0 : 0) - (x.rec ? x.rec.w || 0 : 0))
      .slice(0, KEEP_PER_ANGLE)
      .forEach(c => keep.add(c))
  }
  const rows = [...keep].sort((x, y) => y.score - x.score || (y.rec ? y.rec.w || 0 : 0) - (x.rec ? x.rec.w || 0 : 0))

  const pct = v => Math.round(v * 100)
  return {
    total: out.length,
    excluded,
    weights: WEIGHTS,
    angles: ANGLES,
    markets: MARKETS,
    useRatio: Math.round(ratio * 1000) / 1000,
    rows: rows.map(c => {
      const rec = c.rec
      const d = rec && rec.deep
      const row = {
        k: c.n || c.key, // npm 包名，或 gh:owner/repo
        n: c.n,
        sc: c.score,
        a: c.a, // 六个角度各自的分数（不参与的为 null）
        p: [pct(c.parts.use), pct(c.parts.stars), pct(c.parts.maint), pct(c.parts.curated), pct(c.parts.stable), pct(c.parts.reach)],
        src: [...c.src],
      }
      if (!c.n) {
        row.name = c.name
        row.repo = c.repo
      }
      if (c.added) row.added = c.added
      // 不在 npm 目录里的（官方插件）：面板查不到它的记录，名字、版本、下载量跟着行走
      if (c.outside) Object.assign(row, { name: rec.n, v: rec.v, d: rec.d, w: rec.w })
      if (c.stars != null) row.s = c.stars
      if (d && Number.isFinite(d.growth)) row.g = Math.round(d.growth * 100) / 100
      if (d && d.lastRelease) row.last = d.lastRelease
      else if (rec && rec.t) row.last = String(rec.t).slice(0, 10)
      return row
    }),
  }
}
