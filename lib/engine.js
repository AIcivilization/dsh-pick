// lib/engine.js — dsh-pick 数据引擎
//
// 一个引擎，三个入口（设置页面板 / `/pick-` 命令 / AI 工具）都走这里。
//
// 目录构建在宿主端（Node）跑，没有 CORS、可以并发，所以能全量抓；
// 页面只读 catalog.json，秒开。

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { classify } from './classify.js'
import { expandWords } from './words.js'
import { baselineWithStart, growth, cadence, ageDays, score, sum } from './metrics.js'
import { parseRepo, fetchRepos, fetchRepoLive, countsForPlugin } from './github.js'
import { buildBoards, communityPackages, loadCommunity, repoUrl } from './boards.js'
import { buildOverall } from './overall.js'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
/** 随包自带的目录（发版时的快照；dsh-pick build 也写这里） */
export const CATALOG_PATH = join(PKG_ROOT, 'data', 'catalog.json')

/** DSH 的数据目录：DSH_HOME 或 ~/.dsh */
export function dshHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME || '').trim()
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/** 每日更新下来的目录（lib/remote.js 写入）：放在 DSH 数据目录里，插件升级、重装都不丢 */
export function cachePath(env = process.env) {
  return join(dshHome(env), 'dsh-pick', 'catalog.json')
}

const SEARCH_API = 'https://registry.npmjs.org/-/v1/search'
const DL_API = 'https://api.npmjs.org/downloads'
const REG_API = 'https://registry.npmjs.org'

/* ---------------------------------------------------------------- 网络 */

/**
 * 和 jget 一样，但分得清「没有这个包」（404/410）和「这次没拿到」（限流、5xx、网络）。
 * 在 GitHub Actions 上读几千个 manifest 会被 npm 限流，把两者混为一谈就会把一大批好好的包当成不存在丢掉
 * @returns {Promise<{status: 'ok', data: any} | {status: 'gone'} | {status: 'failed'}>}
 */
async function jgetStatus(url, { tries = 4, wait = 800 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } })
      if (r.status === 404 || r.status === 410) return { status: 'gone' }
      if (r.ok) return { status: 'ok', data: await r.json() }
    } catch { /* 网络错误：等一下再试 */ }
    await sleep(wait * (i + 1))
  }
  return { status: 'failed' }
}

/**
 * 读一批 npm manifest（/latest），分轮降速：第一轮并发 8，没拿到的第二轮并发 2，再没拿到的第三轮逐个慢慢来
 * @returns {Promise<Map<string, {status: string, data?: any}>>}
 */
export async function fetchManifests(names, { wait = 800, onProgress = () => {} } = {}) {
  const out = new Map()
  let pending = names.slice()
  const rounds = [{ conc: 8, pause: 0 }, { conc: 2, pause: 200 }, { conc: 1, pause: 600 }]
  for (let round = 0; round < rounds.length && pending.length; round++) {
    const { conc, pause } = rounds[round]
    if (round > 0) onProgress(`  manifest 第 ${round + 1} 轮（并发 ${conc}），${pending.length} 个上一轮没拿到…`)
    await pool(pending, conc, async n => {
      out.set(n, await jgetStatus(`${REG_API}/${enc(n)}/latest`, { wait }))
      if (pause) await sleep(pause * wait / 800)
    })
    pending = pending.filter(n => out.get(n).status === 'failed')
  }
  return out
}

async function jget(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } })
      if (r.status === 429 || r.status === 503) {
        await sleep(800 * (i + 1))
        continue
      }
      if (!r.ok) return null
      return await r.json()
    } catch {
      await sleep(400 * (i + 1))
    }
  }
  return null
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

const enc = s => String(s).replace(/\//g, '%2f')

async function pool(items, limit, fn) {
  const out = new Array(items.length)
  let idx = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++
      out[i] = await fn(items[i], i)
    }
  }))
  return out
}

const shiftDate = (iso, d) => {
  const t = new Date(iso + 'T00:00:00Z')
  t.setUTCDate(t.getUTCDate() + d)
  return t.toISOString().slice(0, 10)
}

/**
 * npm 下载统计最后一个已汇总的完整日。拿 react 探：全 npm 下载最多的包之一，哪天有数据它一定有。
 * （以前探的是 dsh-market——这个包根本不存在，每次都退回「今天减 5 天」的估算）
 */
export async function resolveAnchor() {
  for (const probe of ['react', 'dshmarket']) {
    const d = await jget(`${DL_API}/point/last-day/${probe}`, 2)
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(String(d.end || '')) && d.downloads > 0) return d.end
  }
  return shiftDate(new Date().toISOString().slice(0, 10), -5)
}

/**
 * npm 自己缺数据的日子：react 那天下载量是 0，就说明 npm 那天的统计没出来（2026-10 实测连着缺过 3 天），
 * 不是真的没人下载。返回窗口内的下标集合；这些天在日序列里记成 null，不参与基线、环比的计算。
 * 探测失败就当没有缺口（宁可少剔，不乱剔）
 */
const gapCache = new Map()
export async function gapDays(start, anchor) {
  const key = `${start}:${anchor}`
  if (gapCache.has(key)) return gapCache.get(key)
  const r = await jget(`${DL_API}/range/${start}:${anchor}/react`, 3)
  const gaps = new Set()
  if (r && Array.isArray(r.downloads)) r.downloads.forEach((x, i) => { if (!x.downloads) gaps.add(i) })
  gapCache.set(key, gaps)
  return gaps
}

/** 日序列里把 npm 缺数据的日子换成 null */
export const maskGaps = (daily, gaps) => daily.map((v, i) => (gaps.has(i) ? null : v))

/* ---------------------------------------------------------------- 目录构建 */

/**
 * 抓取 DSH 插件目录
 * @param {object} opt
 * @param {number} opt.deep 对周下载 Top N 抓日序列 + 发布历史，算出噪指标
 * @param {number} opt.max 搜索接口最多抓多少个包（深分页上限约 2250；社区目录补进来的不算）
 * @param {boolean} opt.deepOnly 只补算去噪指标，不重新抓目录（省 5 分钟）
 * @param {(msg:string)=>void} opt.onProgress 进度回调
 */
export async function buildCatalog({ deep = 200, max = 2250, pages = 9, deepOnly = false, githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN, onProgress = () => {} } = {}) {
  const today = new Date().toISOString().slice(0, 10)
  const anchor = await resolveAnchor()
  const start = shiftDate(anchor, -29)
  const gaps = await gapDays(start, anchor)
  const gapDates = [...gaps].sort((a, b) => a - b).map(i => shiftDate(start, i))
  onProgress(`统计截止日 ${anchor}${gapDates.length ? `；npm 缺 ${gapDates.join('、')} 的数据，这几天不参与计算` : ''}，${deepOnly ? '只补算去噪指标' : '开始抓取目录'}…`)

  const records = new Map()
  const previous = await readJson(CATALOG_PATH)
  let communityDoc = null

  if (deepOnly) {
    const prev = await loadCatalog()
    if (!prev.total) throw new Error('还没有目录，先跑一次不带 --deep-only 的 build')
    for (const rec of Object.values(prev.packages)) records.set(rec.n, rec)
    onProgress(`沿用已有目录 ${records.size} 个包`)
  } else {
    for (let p = 0; p < pages; p++) {
      const from = p * 250
      onProgress(`抓取目录 ${from + 1}–${from + 250} / ${max}…`)
      const d = await jget(`${SEARCH_API}?text=${encodeURIComponent('keywords:dsh-plugin')}&size=250&from=${from}`)
      const objs = (d && d.objects) || []
      for (const o of objs) {
        const pkg = o.package
        if (records.has(pkg.name)) continue
        records.set(pkg.name, {
          n: pkg.name,
          v: pkg.version,
          d: (pkg.description || '').slice(0, 160),
          kw: pkg.keywords || [],
          w: (o.downloads && o.downloads.weekly) || 0,
          m: (o.downloads && o.downloads.monthly) || 0,
          pub: (pkg.date || '').slice(0, 10),
          // 最新版的发布时间（完整的 ISO 时间）：插件索引的 publishTimestamp 要它
          t: /^\d{4}-\d{2}-\d{2}T/.test(pkg.date || '') ? pkg.date : undefined,
          // search API 直接给 links，不额外花请求
          home: (pkg.links && pkg.links.homepage) || '',
          repo: (pkg.links && pkg.links.repository) || '',
        })
      }
      if (records.size >= max) break
      if (objs.length < 250) break
      await sleep(220)
    }

    // 搜索接口翻不到的，用社区目录补。社区目录抓不到就沿用上次目录里的包，不让总数一天掉一半
    try {
      communityDoc = await loadCommunity()
    } catch (e) {
      onProgress(`社区目录抓不到（${e.message}），沿用上次目录里的包`)
    }
    const rows = communityDoc
      ? communityPackages(communityDoc)
      : Object.values((previous && previous.packages) || {}).map(r => ({ n: r.n, m: r.m, repo: repoUrl(r.repo) }))
    await addCommunity(records, rows, { previous: previous && previous.packages, onProgress })
  }

  // 分类：**全部**目录都要有（v1 只给深挖目标分了类，导致其余全是 undefined）
  for (const rec of records.values()) {
    rec.cat = classify(rec.n, rec.kw, rec.d)
  }

  onProgress(`目录 ${records.size} 个包已分类，开始算去噪指标 Top ${deep}…`)

  // 深挖：日序列 + 发布历史 → 日常基线 / 增速 / 版本节奏 / 新鲜度
  // 范围不随目录变大：多出来的包大多下载量很小，而且下载量接口经不起更多请求
  // 注意：api.npmjs.org 并发稍高就开始 429，所以下载量请求必须低并发；
  //      registry.npmjs.org 宽松得多，可以并发。两段分开抓。
  // deepOnly 时只补缺失的；全量时按周下载取 Top N
  const targets = [...records.values()]
    .filter(r => (deepOnly ? !r.deep : true))
    .sort((a, b) => b.w - a.w)
    .slice(0, deep)

  let deepOk = 0
  let pending = targets.slice()

  // 最多 3 轮：最后一轮降到并发 1，专治偶发 429
  for (let round = 1; round <= 3 && pending.length; round++) {
    const conc = round >= 3 ? 1 : 2
    onProgress(`  日序列 第 ${round} 轮，${pending.length} 个（并发 ${conc}）…`)

    const ranges = await pool(pending, conc, async rec => {
      const r = await jget(`${DL_API}/range/${start}:${anchor}/${enc(rec.n)}`)
      await sleep(round >= 3 ? 420 : 180)
      return (r && Array.isArray(r.downloads)) ? r.downloads.map(x => x.downloads) : null
    })

    const ok = pending.filter((_, i) => ranges[i])

    if (ok.length) {
      onProgress(`  发布历史 ${ok.length} 个…`)
      const metas = await pool(ok, 8, async rec => jget(`${REG_API}/${enc(rec.n)}`))
      ok.forEach((rec, i) => {
        const daily = maskGaps(ranges[pending.indexOf(rec)], gaps)
        const meta = metas[i]
        const releaseDates = (meta && meta.time)
          ? Object.entries(meta.time)
              .filter(([k]) => k !== 'created' && k !== 'modified')
              .map(([, v]) => String(v).slice(0, 10))
          : []

        const b = baselineWithStart(daily, releaseDates, start)
        const g = growth(daily)
        const vd = releaseDates.slice().sort()
        const lastRelease = vd.length ? vd[vd.length - 1] : rec.pub
        const age = ageDays(lastRelease, today)
        const c = cadence(releaseDates)

        rec.deep = {
          daily,
          base: b,
          growth: g,
          cadence: c,
          age,
          lastRelease,
          versions: releaseDates.length,
          s: score({ baseline: b, growth: g, age, cadence: c }),
        }
        rec.rel = releaseDates
        deepOk++
      })
    }

    pending = pending.filter((_, i) => !ranges[i])
  }

  // 安装相关的硬信息（全部包都要）：npm 上 latest 版本的 manifest 里
  //   dsh.bundle 有没有声明（没有的话 dsh plugin add 直接拒绝安装）、
  //   客户端平台（web / tui）、声明的 DSH 版本要求（engines.dsh 与 @deepseek-ai/dsh* 的 peer）
  // registry 的单版本 manifest 很宽松，可以并发
  // 已经有的不再抓：deepOnly 沿用的，和社区目录补进来时读过 manifest 的
  const needFacts = [...records.values()].filter(r => !r.inst)
  onProgress(`安装信息 ${needFacts.length} 个…`)
  const facts = await fetchManifests(needFacts.map(r => r.n), { onProgress })
  let factsReused = 0
  for (const rec of needFacts) {
    const res = facts.get(rec.n)
    if (res.status === 'ok') rec.inst = installFacts(res.data)
    else if (res.status === 'failed' && previous && previous.packages && previous.packages[rec.n] && previous.packages[rec.n].inst) {
      rec.inst = previous.packages[rec.n].inst // 被限流没读到：沿用上次的
      factsReused++
    }
  }
  if (factsReused) onProgress(`  ${factsReused} 个安装信息这次没读到，沿用上次的`)

  // GitHub：星标、Fork、未关闭 issue / PR、最近提交、归档。要令牌（Actions 自带的就够），没有就跳过
  if (githubToken) {
    // 指向 DSH 本体的仓库不算（见 countsForPlugin）
    const repoOf = rec => {
      const repo = parseRepo(rec.repo) || parseRepo(rec.home)
      return countsForPlugin(rec.n, repo) ? repo : null
    }
    const repos = [...records.values()].map(repoOf).filter(Boolean)
    onProgress(`GitHub 仓库数据 ${new Set(repos.map(r => r.toLowerCase())).size} 个…`)
    const found = await fetchRepos(repos, { token: githubToken, onProgress })
    for (const rec of records.values()) {
      const repo = repoOf(rec)
      const g = repo && found.get(repo.toLowerCase())
      if (g) rec.gh = g
      else if (!deepOnly) delete rec.gh
    }
    onProgress(`  GitHub 查到 ${found.size} 个仓库`)
  } else {
    onProgress('没设 GITHUB_TOKEN，跳过 GitHub 数据（GitHub Actions 里会自动带上）')
  }

  // npm、GitHub 之外的榜单：官方、社区、插件商店（抓不到的沿用上次）
  onProgress('其他榜单…')
  const members = {}
  const boards = await buildBoards({ previous: previous && previous.boards, communityDoc, members, onProgress })

  // 综合榜：几个市场合成一个榜，一个插件一行；顺带给每个 npm 包写上综合分 sc 和「收录于」src
  const previousSrc = {}
  for (const r of Object.values((previous && previous.packages) || {})) if (r && r.src) previousSrc[r.n] = r.src
  boards.overall = buildOverall({ packages: Object.fromEntries(records), members, previousSrc })
  onProgress(`  综合榜：${boards.overall.total} 个插件参与排名（${Object.entries(boards.overall.excluded).map(([k, v]) => `${k} ${v}`).join('、') || '无'}不进榜）`)

  for (const rec of records.values()) slimRecord(rec)

  const catalog = {
    tool: 'dsh-pick',
    asOf: today,
    anchor,
    windowStart: start,
    gaps: gapDates,
    githubCount: [...records.values()].filter(r => r.gh).length,
    boards,
    total: records.size,
    deepCount: [...records.values()].filter(r => r.deep).length,
    packages: Object.fromEntries([...records.entries()]),
  }

  await mkdir(dirname(CATALOG_PATH), { recursive: true })
  await writeFile(CATALOG_PATH, JSON.stringify(catalog), 'utf8')
  onProgress(`完成：${records.size} 个包，其中 ${deepOk} 个算出去噪指标 → ${CATALOG_PATH}`)
  return catalog
}

/**
 * 把社区目录里有、搜索接口翻不到的包补进 records。
 * 每个包都读一次 npm 上的 manifest：社区目录可能过时或写错，npm 上查不到（或名字对不上）的不收。
 * @param {Map<string, object>} records 会就地补充
 * @param {{n: string, m?: number|null, repo?: string|null}[]} rows 包名已校验（communityPackages）
 * @param {object} [opt]
 * @param {Record<string, object>} [opt.previous] 上次目录的 packages：没轮到或查不到周下载时沿用
 * @param {string} [opt.today] YYYY-MM-DD，决定今天轮到哪些带 scope 的包（见 weeklyDue）
 * @returns {Promise<number>} 补进去几个
 */
export async function addCommunity(records, rows, { previous = {}, today = new Date().toISOString().slice(0, 10), wait = 800, onProgress = () => {} } = {}) {
  const missing = rows.filter(r => !records.has(r.n))
  onProgress(`社区目录 ${rows.length} 个 npm 包，其中 ${missing.length} 个搜索接口没翻到，逐个读 manifest…`)
  const got = await fetchManifests(missing.map(r => r.n), { wait, onProgress })
  const added = []
  let gone = 0, reused = 0, lost = 0
  for (const row of missing) {
    const res = got.get(row.n)
    if (res.status === 'ok') {
      const rec = communityRecord(row, res.data)
      if (rec) added.push(rec)
      else gone++ // 名字对不上，当不存在
    } else if (res.status === 'gone') {
      gone++
    } else if (previous && previous[row.n]) {
      // 三轮都没拿到（多半被限流）：沿用上次目录里的，别因为一次网络问题就把包丢了
      added.push({ ...previous[row.n] })
      reused++
    } else {
      lost++
    }
  }
  if (gone) onProgress(`  ${gone} 个在 npm 上不存在，不收`)
  if (reused) onProgress(`  ${reused} 个这次没读到 manifest，沿用上次目录里的`)
  if (lost) onProgress(`  ${lost} 个这次没读到、上次目录里也没有，先不收`)

  // 不带 scope 的批量查，每天全查；带 scope 的只能逐个查，下载量接口经不起（几百个包在 Actions 上要排队二十多分钟），
  // 所以每天只查轮到的那组和上次没有数的，其余沿用上次的
  const prevW = n => previous?.[n]?.w
  const due = added.filter(r => !r.n.startsWith('@') || prevW(r.n) == null || weeklyDue(r.n, today))
  onProgress(`  周下载 ${due.length} 个（带 scope 的 ${added.length - due.length} 个今天没轮到，沿用上次的）…`)
  const weekly = await fetchWeekly(due.map(r => r.n), onProgress)
  let stale = 0
  for (const rec of added) {
    const known = weekly.get(rec.n)
    if (known == null && due.includes(rec)) stale++
    rec.w = known ?? prevW(rec.n) ?? 0
    // 两个数据来源的统计窗口差几天，别出现月下载比周下载还少
    rec.m = Math.max(rec.m, rec.w)
    records.set(rec.n, rec)
  }
  if (stale) onProgress(`  ${stale} 个查不到周下载，沿用上次的数（没有就记 0）`)
  return added.length
}

/** 社区目录的一行 + npm manifest → 目录记录（周下载另外填）。manifest 不对劲返回 null */
export function communityRecord(row, manifest) {
  if (!manifest || manifest.name !== row.n) return null
  const repository = manifest.repository
  const repoText = typeof repository === 'string' ? repository : (repository && repository.url) || ''
  return {
    n: row.n,
    v: str(manifest.version),
    d: str(manifest.description).slice(0, 160),
    kw: Array.isArray(manifest.keywords) ? manifest.keywords.filter(k => typeof k === 'string') : [],
    w: 0,
    m: row.m || 0,
    home: /^https?:\/\//.test(str(manifest.homepage)) ? manifest.homepage : '',
    // 社区目录的地址校验过（https、代码托管站），优先用它；monorepo 子目录也已截到仓库根
    repo: row.repo || str(repoText),
    inst: installFacts(manifest),
  }
}

const str = v => (typeof v === 'string' ? v : '')

/**
 * 查一批包的周下载。不带 scope 的走批量接口（一次最多 128 个，几十次请求就完）；带 scope 的 npm 不支持批量，
 * 只能一个个查，所以低并发（同去噪指标，稍高就 429），最后一轮降到并发 1。
 * 这个接口的数和搜索接口的周下载基本一致（实测中位数差 4%）。
 * （试过用搜索接口按包名查带 scope 的：连查一百来个也开始限流，并不更宽松）
 * @returns {Promise<Map<string, number>>} 查不到的不在里面
 */
async function fetchWeekly(names, onProgress = () => {}) {
  const out = new Map()
  const url = name => `${DL_API}/point/last-week/${name}`
  const bare = names.filter(n => !n.startsWith('@'))
  for (let i = 0; i < bare.length; i += 128) {
    const batch = bare.slice(i, i + 128)
    if (batch.length < 2) break // 只查一个时返回的形状不一样，交给下面逐个查
    const d = await jget(url(batch.join(',')))
    for (const n of batch) {
      const v = d && d[n] && d[n].downloads
      if (Number.isFinite(v)) out.set(n, v)
    }
    await sleep(180)
  }
  let pending = names.filter(n => !out.has(n))
  for (let round = 1; round <= 2 && pending.length; round++) {
    onProgress(`  逐个查周下载 第 ${round} 轮，${pending.length} 个…`)
    await pool(pending, round === 1 ? 2 : 1, async n => {
      const d = await jget(url(enc(n)))
      if (d && Number.isFinite(d.downloads)) out.set(n, d.downloads)
      await sleep(round === 1 ? 180 : 420)
    })
    pending = pending.filter(n => !out.has(n))
  }
  return out
}

/** 带 scope 的包分几天轮着查周下载 */
export const WEEKLY_ROTATION = 3

/**
 * 这个带 scope 的包今天轮不轮到查周下载：按包名分进 WEEKLY_ROTATION 组，一天查一组。
 * 不记状态，每个包固定每隔 WEEKLY_ROTATION 天刷新一次
 */
export function weeklyDue(name, today) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0
  const day = Math.floor(Date.parse(today + 'T00:00:00Z') / 86400000)
  return h % WEEKLY_ROTATION === day % WEEKLY_ROTATION
}

/** 几乎每个包都有的关键字：搜索时没有区分度，存着还白占地方 */
const GENERIC_KW = new Set(['dsh-plugin', 'dsh-plugins', 'dsh', 'deepseek-harness'])

/**
 * 落盘前瘦身（五千多个包，每个省几十字节就是几百 KB）。只去掉读的一方用不上的：
 *   pub / rel 发布日期（算完去噪指标就没用了）· home 已有 GitHub 仓库地址时的主页（只用来找仓库）
 *   repo 的 git+ 和 .git · 没有区分度的关键字，关键字最多留 12 个 · inst、gh 里的空值（读的时候都只判真假）
 */
export function slimRecord(rec) {
  delete rec.pub
  delete rec.rel
  if (rec.repo) rec.repo = rec.repo.replace(/^git\+/, '').replace(/\.git$/, '')
  if (!rec.home || (/^https?:\/\//.test(rec.repo || '') && parseRepo(rec.repo))) delete rec.home
  if (!rec.repo) delete rec.repo
  rec.kw = (rec.kw || []).filter(k => !GENERIC_KW.has(String(k).toLowerCase())).slice(0, 12)
  if (rec.inst) {
    if (rec.inst.p == null) delete rec.inst.p
    if (rec.inst.r == null) delete rec.inst.r
    if (rec.inst.e == null) delete rec.inst.e
    if (rec.inst.a == null) delete rec.inst.a
  }
  if (rec.gh) {
    if (!rec.gh.a) delete rec.gh.a
    if (rec.gh.l == null) delete rec.gh.l
  }
  return rec
}

/**
 * 从 npm manifest 里摘出安装相关的三件事（字段名短：几千个包都要存）
 *   b 有没有 dsh.bundle 声明 · p 客户端平台 · r 声明的 DSH 版本要求（可能为 null）
 * 版本要求的读法照 dshmarket：engines.dsh 与 dsh.engines.dsh 都认，peer 只看 @deepseek-ai/dsh*
 * （cordis、schemastery 不跟 DSH 版本走）
 */
export function installFacts(manifest = {}) {
  const dsh = (manifest && manifest.dsh) || {}
  const reqs = []
  const engine = (manifest.engines && manifest.engines.dsh) || (dsh.engines && dsh.engines.dsh)
  if (typeof engine === 'string' && engine.trim()) reqs.push(engine.trim())
  for (const [name, range] of Object.entries(manifest.peerDependencies || {})) {
    if (/^@deepseek-ai\/dsh(-|$)/.test(name) && typeof range === 'string' && range.trim()) reqs.push(range.trim())
  }
  const platform = dsh.client && typeof dsh.client.platform === 'string' ? dsh.client.platform : null
  // e：只认顶层 engines.dsh，原样保留——DSH 插件索引（index.json）只收声明了它的版本，而且要求一字不改
  const e = manifest.engines && typeof manifest.engines.dsh === 'string' && manifest.engines.dsh.trim() ? manifest.engines.dsh : null
  // a：作者名（npm 的 author 可以是对象，也可以是 "名字 <邮箱> (网址)" 这种简写），只留名字
  const author = manifest.author
  const name = typeof author === 'string' ? author.replace(/\s*[<(].*$/, '') : author && typeof author.name === 'string' ? author.name : ''
  return {
    b: Boolean(dsh.bundle), p: platform, r: reqs.length ? [...new Set(reqs)].join(' ∩ ') : null,
    e, a: name.trim() || null,
  }
}

/* ---------------------------------------------------------------- 查询 */

let cache = null

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** a 比 b 新：先比统计截止日，再比构建日 */
export function newerCatalog(a, b) {
  if (!a || !a.packages) return false
  if (!b || !b.packages) return true
  const ka = `${a.anchor || ''}|${a.asOf || ''}`
  const kb = `${b.anchor || ''}|${b.asOf || ''}`
  return ka > kb
}

/**
 * 目录：随包自带的和每日更新的，用新的那份。
 * source 标出用的是哪份（'remote' 每日更新 / 'bundled' 随包自带），设置页显示用
 */
export async function loadCatalog({ env = process.env } = {}) {
  if (cache) return cache
  const [bundled, cached] = await Promise.all([readJson(CATALOG_PATH), readJson(cachePath(env))])
  const pick = newerCatalog(cached, bundled) ? { ...cached, source: 'remote' } : bundled ? { ...bundled, source: 'bundled' } : null
  // 每日目录是旧代码构建的、还没有某个榜（比如刚加的综合榜）：先用随包自带的那份顶上，下次每日构建后就齐了
  if (pick && pick.source === 'remote' && bundled && bundled.boards) {
    pick.boards = { ...bundled.boards, ...(pick.boards || {}) }
  }
  cache = pick ? normalize(pick) : { asOf: null, anchor: null, packages: {}, total: 0, source: 'none' }
  return cache
}

/** 换上新目录（每日更新下载完、或测试时） */
export function reloadCatalog(cat) {
  cache = cat ? normalize(cat) : null
}

/**
 * 归一化：补上 npm 地址、GitHub 地址、总排行、分类排行
 * 排名字段不落盘，加载时算一次（几千个包一次排序，毫秒级），
 * 这样 catalog.json 重建与否都不影响排名显示。
 */
export function normalize(cat) {
  if (!cat || !cat.packages) return cat
  const all = Object.values(cat.packages).filter(r => r && r.n)
  const byName = new Map(all.map(r => [r.n, r]))

  // 总排行：按周下载
  const byWeekly = all.slice().sort((a, b) => (b.w || 0) - (a.w || 0))
  byWeekly.forEach((r, i) => { r.rank = i + 1 })

  // 分类排行：同类内按周下载
  const byCat = new Map()
  byWeekly.forEach(r => {
    if (!r.cat) return
    const n = (byCat.get(r.cat) || 0) + 1
    byCat.set(r.cat, n)
    r.crank = n
  })

  // 规范化 links（scoped 包名要编码）
  for (const r of all) {
    r.npmUrl = 'https://www.npmjs.com/package/' + r.n.replace('/', '%2F')
    let repo = (r.repo || '').replace(/^git\+/, '').replace(/\.git$/, '')
    if (repo && !/^https?:\/\//.test(repo)) repo = ''
    r.repoUrl = repo
    // GitHub 地址优先取 repo，其次 homepage（很多包装配的是 github.io）
    const gh = (repo || r.home || '')
    // 链接要放进页面：只认 https?:// 开头的 GitHub 地址
    r.ghUrl = /^https?:\/\/([^/]*\.)?github\.com\//.test(gh) ? gh : ''
  }

  return cat
}

/* 同义词词典与中文二元切分见 lib/words.js（引擎与面板共用同一份） */

/**
 * 选型主流程第 2 步：按需求描述找候选
 * 三层词法匹配 + 下载量微弱加权，返回带相关性与下载量的候选
 */
export function searchByNeed(catalog, need, { limit = 12, category = null } = {}) {
  const terms = expandWords(need)
  if (!terms.length) return []

  const maxWeight = terms.reduce((s, t) => s + t.weight, 0)
  const scored = []
  for (const rec of Object.values(catalog.packages || {})) {
    if (category && rec.cat !== category) continue
    const hay = [(rec.n || ''), ...(rec.kw || []), rec.d || ''].join(' ').toLowerCase()
    let hit = 0
    let any = false
    for (const t of terms) {
      if (hay.includes(t.w)) { hit += t.weight; any = true }
    }
    if (!any) continue
    const relevance = hit / maxWeight
    // 下载量只做微弱加权，避免「发版本最勤」挤掉真正相关的
    const pop = Math.log10(Math.max(rec.w, 1)) / 6
    scored.push({ rec, relevance, score: relevance * 0.85 + pop * 0.15 })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(x => ({
    name: x.rec.n,
    version: x.rec.v,
    category: x.rec.cat,
    description: x.rec.d,
    weekly: x.rec.w,
    monthly: x.rec.m,
    deep: x.rec.deep
      ? {
          baseline: x.rec.deep.base,
          growth: x.rec.deep.growth,
          cadence: x.rec.deep.cadence,
          ageDays: x.rec.deep.age,
          lastRelease: x.rec.deep.lastRelease,
          versions: x.rec.deep.versions,
          score: x.rec.deep.s,
        }
      : null,
    relevance: Math.round(x.relevance * 100),
  }))
}

/** 排行 */
export function rank(catalog, { metric = 'weekly', category = null, limit = 50, from = 0 } = {}) {
  const all = Object.values(catalog.packages || {}).filter(r => !category || r.cat === category)
  const val = r => metric === 'score' ? (r.deep ? r.deep.s : -1)
                : metric === 'baseline' ? (r.deep ? r.deep.base : -1)
                : metric === 'growth' ? (r.deep && r.deep.growth !== null ? r.deep.growth : -Infinity)
                : metric === 'monthly' ? r.m
                : metric === 'stars' ? (r.gh ? r.gh.s : -1)
                : metric === 'pushed' ? (r.gh && r.gh.p ? Date.parse(r.gh.p) : -Infinity)
                : r.w
  all.sort((a, b) => val(b) - val(a))
  // 按 GitHub 排时一个仓库只留一行（周下载最多的那个插件），不然同仓库的一串插件数据一模一样、刷屏
  if (metric === 'stars' || metric === 'pushed') {
    const best = new Map()
    for (const r of all) {
      if (!r.gh) continue
      const k = r.gh.repo.toLowerCase()
      if (!best.has(k) || r.w > best.get(k).w) best.set(k, r)
    }
    const keep = new Set(best.values())
    return all.filter(r => keep.has(r)).slice(from, from + limit)
  }
  return all.slice(from, from + limit)
}

/** 获取单个/多个包的完整数据（含目录里没有时实时查） */
export async function stats(catalog, names) {
  const out = []
  for (const name of names) {
    const rec = catalog.packages[name]
    if (rec && rec.deep) {
      out.push({ source: 'catalog', ...serialize(rec) })
      continue
    }
    const [live, dl] = await Promise.all([fetchLive(name), searchDownloads(name)])
    // 周 / 月下载和目录同一口径（见 liveStats）
    out.push(live ? { source: 'live', ...live, ...(dl ? { weekly: dl.weekly, monthly: dl.monthly } : {}) } : { source: 'not-found', name })
  }
  return out
}

/**
 * 实时查几个包（「我的监控」的刷新）：统计截止日只探测一次，下载量接口低并发（稍高就 429）。
 * 不带 30 天日序列（太长，界面用不上）
 * @returns {Promise<{at: string, anchor: string, rows: object[]}>}
 */
/**
 * 监控列表里的名字：npm 包名，或只在 GitHub 上的插件 gh:owner/repo。
 * 从查询串里取出合法的、去重，最多 30 个
 */
export function parseWatchNames(url) {
  const raw = new URL(url || '/', 'http://x').searchParams.get('names') || ''
  const ok = s => /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(s) || /^gh:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)
  return [...new Set(raw.split(',').map(s => s.trim()).filter(ok))].slice(0, 30)
}

export async function liveStats(allNames, { fetchImpl } = {}) {
  const repoOnly = allNames.filter(n => n.startsWith('gh:'))
  const names = allNames.filter(n => !n.startsWith('gh:'))
  const anchor = await resolveAnchor()
  const cat = await loadCatalog()
  // GitHub：按目录里登记的仓库实时查（同一个仓库只查一次）；被限流就整批放弃，说清楚原因
  const repoOf = n => {
    const rec = cat.packages[n]
    const repo = rec ? parseRepo(rec.ghUrl || rec.repo || rec.home) : null
    return countsForPlugin(n, repo) ? repo : null
  }
  const repos = [...new Set([...names.map(repoOf).filter(Boolean), ...repoOnly.map(n => n.slice(3))])]
  const ghLive = new Map()
  let githubError = null
  await pool(repos, 4, async repo => {
    if (githubError) return
    try {
      const g = await fetchRepoLive(repo, fetchImpl ? { fetchImpl } : {})
      if (g) ghLive.set(repo, g)
    } catch (e) {
      githubError = e.code === 'rate-limited' ? e.message : `GitHub 查不到：${e.message}`
    }
  })
  const rows = await pool(names, 2, async name => {
    const [r, dl] = await Promise.all([fetchLive(name, anchor), searchDownloads(name)])
    if (!r && !dl) return { name, found: false }
    const { daily, keywords, ...rest } = r || { name, deep: null }
    // 周下载 / 月下载用搜索接口的：和目录同一口径（目录就是从它抓的），而且比下载统计接口新——
    // 下载统计接口常常只到几天前，拿它和目录比会凭空「跌」一截
    const gh = ghLive.get(repoOf(name)) || null
    return dl
      ? { found: true, ...rest, weekly: dl.weekly, monthly: dl.monthly, latest: rest.latest || dl.version, gh }
      : { found: true, ...rest, gh }
  })
  // 只在 GitHub 上的插件：没有 npm 数据，只有仓库数据
  for (const name of repoOnly) {
    const gh = ghLive.get(name.slice(3))
    rows.push(gh ? { found: true, name, gh, deep: null } : { found: false, name })
  }
  return { at: new Date().toISOString(), anchor, rows, githubError }
}

/** npm 搜索接口里这个包的周 / 月下载（按包名精确匹配；查不到返回 null） */
async function searchDownloads(name) {
  const d = await jget(`${SEARCH_API}?text=${encodeURIComponent(name)}&size=5`, 2)
  const o = d && Array.isArray(d.objects) && d.objects.find(x => x.package && x.package.name === name)
  return o && o.downloads ? { weekly: o.downloads.weekly || 0, monthly: o.downloads.monthly || 0, version: o.package.version } : null
}

async function fetchLive(name, knownAnchor) {
  const today = new Date().toISOString().slice(0, 10)
  const anchor = knownAnchor || await resolveAnchor()
  const start = shiftDate(anchor, -29)
  const [range, total, meta] = await Promise.all([
    jget(`${DL_API}/range/${start}:${anchor}/${enc(name)}`),
    jget(`${DL_API}/point/2015-01-01:${today}/${enc(name)}`),
    jget(`${REG_API}/${enc(name)}`),
  ])
  if (!range || !Array.isArray(range.downloads) || !range.downloads.length) return null

  const daily = maskGaps(range.downloads.map(x => x.downloads), await gapDays(start, anchor))
  let releaseDates = []
  if (meta && meta.time) {
    releaseDates = Object.entries(meta.time)
      .filter(([k]) => k !== 'created' && k !== 'modified')
      .map(([, v]) => String(v).slice(0, 10))
  }
  const b = baselineWithStart(daily, releaseDates, start)
  const g = growth(daily)
  const last = releaseDates.slice().sort().pop() || ''
  const age = ageDays(last, today)

  return {
    name,
    description: (meta && meta.description) || '',
    keywords: (meta && meta.keywords) || [],
    latest: meta && meta['dist-tags'] ? meta['dist-tags'].latest : null,
    weekly: sum(daily.slice(-7)),
    monthly: sum(daily),
    total: total && typeof total.downloads === 'number' ? total.downloads : null,
    daily,
    deep: {
      baseline: b,
      growth: g,
      cadence: cadence(releaseDates),
      ageDays: age,
      lastRelease: last,
      versions: releaseDates.length,
      score: score({ baseline: b, growth: g, age, cadence: cadence(releaseDates) }),
    },
  }
}

function serialize(rec) {
  return {
    name: rec.n,
    version: rec.v,
    description: rec.d,
    keywords: rec.kw,
    category: rec.cat,
    weekly: rec.w,
    monthly: rec.m,
    rank: rec.rank || null,
    crank: rec.crank || null,
    npmUrl: rec.npmUrl || null,
    ghUrl: rec.ghUrl || null,
    repoUrl: rec.repoUrl || null,
    deep: rec.deep
      ? {
          baseline: rec.deep.base,
          growth: rec.deep.growth,
          cadence: rec.deep.cadence,
          ageDays: rec.deep.age,
          lastRelease: rec.deep.lastRelease,
          versions: rec.deep.versions,
          score: rec.deep.s,
        }
      : null,
  }
}


export default { buildCatalog, loadCatalog, reloadCatalog, searchByNeed, rank, stats, liveStats, CATALOG_PATH, resolveAnchor }
