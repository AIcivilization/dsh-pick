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

/** npm 统计滞后约 5 天，先探测最后一个已汇总的完整日 */
async function resolveAnchor() {
  const probe = await jget(`${DL_API}/point/last-day/dsh-market`)
  return (probe && probe.end) || shiftDate(new Date().toISOString().slice(0, 10), -5)
}

/* ---------------------------------------------------------------- 目录构建 */

/**
 * 抓取 DSH 插件目录
 * @param {object} opt
 * @param {number} opt.deep 对周下载 Top N 抓日序列 + 发布历史，算出噪指标
 * @param {number} opt.max 最多抓多少个包（search 深分页上限约 2250）
 * @param {boolean} opt.deepOnly 只补算去噪指标，不重新抓目录（省 5 分钟）
 * @param {(msg:string)=>void} opt.onProgress 进度回调
 */
export async function buildCatalog({ deep = 200, max = 2250, pages = 9, deepOnly = false, onProgress = () => {} } = {}) {
  const today = new Date().toISOString().slice(0, 10)
  const anchor = await resolveAnchor()
  const start = shiftDate(anchor, -29)
  onProgress(`统计截止日 ${anchor}，${deepOnly ? '只补算去噪指标' : '开始抓取目录'}…`)

  const records = new Map()

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
          // search API 直接给 links，不额外花请求
          home: (pkg.links && pkg.links.homepage) || '',
          repo: (pkg.links && pkg.links.repository) || '',
        })
      }
      if (records.size >= max) break
      if (objs.length < 250) break
      await sleep(220)
    }
  }

  // 分类：**全部**目录都要有（v1 只给深挖目标分了类，导致其余全是 undefined）
  for (const rec of records.values()) {
    rec.cat = classify(rec.n, rec.kw, rec.d)
  }

  onProgress(`目录 ${records.size} 个包已分类，开始算去噪指标 Top ${deep}…`)

  // 深挖：日序列 + 发布历史 → 日常基线 / 增速 / 版本节奏 / 新鲜度
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
        const daily = ranges[pending.indexOf(rec)]
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
  const needFacts = [...records.values()].filter(r => !(deepOnly && r.inst))
  onProgress(`安装信息 ${needFacts.length} 个…`)
  const manifests = await pool(needFacts, 8, rec => jget(`${REG_API}/${enc(rec.n)}/latest`, 2))
  needFacts.forEach((rec, i) => { if (manifests[i]) rec.inst = installFacts(manifests[i]) })

  const catalog = {
    tool: 'dsh-pick',
    asOf: today,
    anchor,
    windowStart: start,
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
 * 从 npm manifest 里摘出安装相关的三件事（字段名短：2,250 个包都要存）
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
  return { b: Boolean(dsh.bundle), p: platform, r: reqs.length ? [...new Set(reqs)].join(' ∩ ') : null }
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
  cache = pick ? normalize(pick) : { asOf: null, anchor: null, packages: {}, total: 0, source: 'none' }
  return cache
}

/** 换上新目录（每日更新下载完、或测试时） */
export function reloadCatalog(cat) {
  cache = cat ? normalize(cat) : null
}

/**
 * 归一化：补上 npm 地址、GitHub 地址、总排行、分类排行
 * 排名字段不落盘，加载时算一次（2,250 个包一次排序，毫秒级），
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
    r.ghUrl = /github\.com/.test(gh) ? gh : ''
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
                : metric === 'monthly' ? r.m : r.w
  all.sort((a, b) => val(b) - val(a))
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
    const live = await fetchLive(name)
    out.push(live ? { source: 'live', ...live } : { source: 'not-found', name })
  }
  return out
}

async function fetchLive(name) {
  const today = new Date().toISOString().slice(0, 10)
  const anchor = await resolveAnchor()
  const start = shiftDate(anchor, -29)
  const [range, total, meta] = await Promise.all([
    jget(`${DL_API}/range/${start}:${anchor}/${enc(name)}`),
    jget(`${DL_API}/point/2015-01-01:${today}/${enc(name)}`),
    jget(`${REG_API}/${enc(name)}`),
  ])
  if (!range || !Array.isArray(range.downloads) || !range.downloads.length) return null

  const daily = range.downloads.map(x => x.downloads)
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


export default { buildCatalog, loadCatalog, reloadCatalog, searchByNeed, rank, stats, CATALOG_PATH, resolveAnchor }
