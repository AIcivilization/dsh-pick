// plugin/tools.js — 给 DSH 对话里的 AI 用的 4 个工具
//
// 让用户不打开面板、直接在对话里问「我想装个数据库插件，哪个靠谱」，AI 自己查目录、拿去噪指标、做比较。
// 数据全部来自本包的 data/catalog.json（pick_stats 遇到目录外的包会实时查 npm）。
//
// 工具描述保持短；口径写在 NOTE 里，每个工具的结果都带上，免得 AI 把下载量当用户数、或者自己编数字。
// 写法照 dsh-vps-manager 的 lib/tools.js：defineTool 来自 DSH 的 @deepseek-ai/dsh-tools，拿不到就原样定义。

import { loadCatalog, searchByNeed, rank, stats } from '../lib/engine.js'
import { allCategories } from '../lib/classify.js'

async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    return mod.defineTool || (d => d)
  } catch {
    return d => d
  }
}

// 返回值的字段随包变化很大，声明成任意 JSON（模型只看 render 出来的文字）
const ANY_JSON = { type: 'json' }
const plain = v => JSON.parse(JSON.stringify(v == null ? null : v))

const NOTE =
  '口径：周下载/月下载含 CI、镜像、爬虫流量，不等于用户数；日常基线 = 扣掉发布日与次日后的每日中位数，最接近真实使用量；' +
  '环比 = 近 7 日比前 7 日；健康度 0~100 = 基线 40% + 增速 25% + 新鲜度 20% + 版本节奏 15%。' +
  '只有周下载 Top 约 330 的包有去噪指标，其余为「—」。回答里的数字只能引用这些结果，不要自己推算。' +
  '推荐前留意每个包下面的 ⚠ 提醒（装不了、终端版、和已装插件重叠），装不了的不要推荐用户装。'

const num = n => (n == null ? '—' : Number(n).toLocaleString('en-US'))
const pct = n => (n == null ? '—' : (n >= 0 ? '+' : '') + Math.round(n * 100) + '%')

/** 一个包的一行摘要（给模型看）；r.installed / r.notes 由 annotate() 补上 */
function line(r) {
  const d = r.deep
  const parts = [
    `${r.name}${r.version ? ' v' + r.version : ''}`,
    r.category ? `[${r.category}]` : '',
    r.installed ? '（已安装）' : '',
  ].filter(Boolean).join(' ')
  const nums = [
    `周下载 ${num(r.weekly)}`,
    d ? `日常基线 ${num(d.baseline)}` : '无去噪指标',
    d ? `环比 ${pct(d.growth)}` : '',
    d && d.cadence != null ? `${d.cadence} 天/版` : '',
    d && d.ageDays != null ? `${d.ageDays} 天前更新` : '',
    d && d.score != null ? `健康度 ${d.score}` : '',
    r.relevance != null ? `相关度 ${r.relevance}%` : '',
  ].filter(Boolean).join(' · ')
  const desc = r.description ? `\n  ${String(r.description).slice(0, 160)}` : ''
  const notes = r.notes && r.notes.length ? `\n  ⚠ ${r.notes.join('；')}` : ''
  return `- ${parts}\n  ${nums}${desc}${notes}`
}

/**
 * 给每一行补上「已安装」和安装相关的提醒：
 * 能不能装（dsh.bundle）、是不是终端版插件、声明的 DSH 版本要求、和已装的同类插件重叠
 */
export function annotate(rows, cat, have) {
  const installedByCat = new Map()
  for (const n of have) {
    const rec = cat.packages && cat.packages[n]
    if (!rec || !rec.cat || rec.cat === '其他' || n === 'dsh-pick') continue
    if (!installedByCat.has(rec.cat)) installedByCat.set(rec.cat, [])
    installedByCat.get(rec.cat).push(n)
  }
  return rows.map(r => {
    const rec = (cat.packages && cat.packages[r.name]) || {}
    const inst = rec.inst
    const notes = []
    if (inst && !inst.b) notes.push('没声明 dsh.bundle，DSH 不能把它当插件安装')
    if (inst && inst.p && inst.p !== 'web') notes.push(`这是 ${inst.p} 客户端插件，装进桌面版 / 网页版可能让 DSH 起不来`)
    if (inst && inst.r) notes.push(`声明需要 DSH ${inst.r}`)
    const same = (installedByCat.get(rec.cat || r.category) || []).filter(n => n !== r.name)
    if (same.length && !have.has(r.name)) notes.push(`你已装了同类插件：${same.join('、')}，功能可能重叠`)
    return { ...r, installed: have.has(r.name), notes }
  })
}

/** 排行榜返回的是目录原始记录（字段名短），转成和搜索一样的形状 */
function fromRec(rec) {
  return {
    name: rec.n,
    version: rec.v,
    category: rec.cat,
    description: rec.d,
    weekly: rec.w,
    monthly: rec.m,
    rank: rec.rank,
    deep: rec.deep
      ? { baseline: rec.deep.base, growth: rec.deep.growth, cadence: rec.deep.cadence, ageDays: rec.deep.age, lastRelease: rec.deep.lastRelease, versions: rec.deep.versions, score: rec.deep.s }
      : null,
  }
}

/**
 * stats() 实时查到的结果（目录里没有去噪指标的包）没带版本、分类、链接：目录里有就补上；
 * 顺手去掉 30 天日序列（太长，模型用不上）
 */
const withCatalogFields = cat => ({ daily, ...r }) => {
  if (r.source !== 'live') return r
  const rec = cat.packages && cat.packages[r.name]
  return {
    ...r,
    version: r.latest || (rec && rec.v) || null,
    category: rec ? rec.cat : null,
    rank: rec ? rec.rank : null,
    npmUrl: (rec && rec.npmUrl) || `https://www.npmjs.com/package/${r.name.replace('/', '%2F')}`,
  }
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

const cleanNames = (names, max) =>
  [...new Set((Array.isArray(names) ? names : [names]).map(s => String(s || '').trim()).filter(s => /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(s)))].slice(0, max)

/**
 * @param {object} deps
 * @param {() => Set<string>} [deps.installed] 当前 DSH 已装的插件名（拿不到就空集合）
 */
export async function buildToolDefinitions(deps = {}) {
  const defineTool = await loadDefineTool()
  const installed = () => {
    try { return deps.installed ? deps.installed() : new Set() } catch { return new Set() }
  }
  const header = cat => `目录数据截止 ${cat.anchor || '未知'}（npm 统计约滞后 5 天），共 ${num(cat.total)} 个插件。`
  const CATS = allCategories()

  return [
    defineTool({
      name: 'pick_search',
      description:
        '按需求在 DSH 插件目录里找候选插件，返回相关度、下载量和去噪指标。用户想找「能做某件事的插件」时先用它。',
      parameters: {
        need: { type: 'string', required: true, description: '要找的东西，用短词效果最好，例如「数据库」「微信 通知」「记忆」；整句也行' },
        category: { type: 'string', enum: CATS, description: '只在某一类里找（可省略）' },
        limit: { type: 'integer', description: '最多返回几个，默认 8，最多 20' },
      },
      output: {
        schema: ANY_JSON,
        render: (_a, v) => [{
          type: 'text',
          text: v.candidates.length
            ? `${v.header}\n需求「${v.need}」的候选（按相关度与下载量综合排序）：\n${v.candidates.map(r => line(r)).join('\n')}\n\n${NOTE}`
            : `${v.header}\n没找到和「${v.need}」相关的插件。可以换个说法，或用 pick_rank 看某一类的排行。`,
        }],
      },
      async execute(args) {
        const cat = await loadCatalog()
        const need = String(args.need || '').trim()
        const candidates = searchByNeed(cat, need, {
          limit: clampInt(args.limit, 1, 20, 8),
          category: CATS.includes(args.category) ? args.category : null,
        })
        return plain({ header: header(cat), need, candidates: annotate(candidates, cat, installed()) })
      },
    }),

    defineTool({
      name: 'pick_stats',
      description:
        '查一个或几个插件的详细数据：简介、版本、下载量、日常基线、环比、版本节奏、最近更新、健康度。目录里没有的包会实时查 npm。',
      parameters: {
        names: { type: 'array', required: true, items: { type: 'string' }, description: 'npm 包名，最多 8 个' },
      },
      output: {
        schema: ANY_JSON,
        render: (_a, v) => [{
          type: 'text',
          text: `${v.header}\n${v.rows.map(r => r.source === 'not-found'
            ? `- ${r.name}：npm 上找不到，或没有下载数据`
            : line(r) + (r.source === 'live' ? '\n  （去噪指标是刚从 npm 实时算的）' : '') + (r.npmUrl ? `\n  ${r.npmUrl}` : '')).join('\n')}\n\n${NOTE}`,
        }],
      },
      async execute(args) {
        const cat = await loadCatalog()
        const names = cleanNames(args.names, 8)
        if (!names.length) throw new Error('names 里没有合法的 npm 包名')
        const rows = (await stats(cat, names)).map(withCatalogFields(cat))
        return plain({ header: header(cat), rows: annotate(rows, cat, installed()) })
      },
    }),

    defineTool({
      name: 'pick_compare',
      description:
        '把 2~6 个插件放在一起比：逐项指标列出数值并标出每项最好的那个，再按健康度排序。用户在几个候选里拿不定主意时用它。',
      parameters: {
        names: { type: 'array', required: true, items: { type: 'string' }, description: '要比较的 npm 包名，2~6 个' },
      },
      output: {
        schema: ANY_JSON,
        render: (_a, v) => [{
          type: 'text',
          text: [
            v.header,
            '逐项最好：',
            ...v.best.map(b => `- ${b.label}：${b.winner ? `${b.winner}（${b.value}）` : '都没有数据'}`),
            '',
            '按健康度排序（没有去噪指标的排在最后）：',
            ...v.rows.map(r => line(r)),
            ...(v.missing.length ? ['', `查不到：${v.missing.join('、')}`] : []),
            '',
            NOTE,
          ].join('\n'),
        }],
      },
      async execute(args) {
        const cat = await loadCatalog()
        const names = cleanNames(args.names, 6)
        if (names.length < 2) throw new Error('至少要两个合法的 npm 包名')
        const all = (await stats(cat, names)).map(withCatalogFields(cat))
        const rows = all.filter(r => r.source !== 'not-found')
        const missing = all.filter(r => r.source === 'not-found').map(r => r.name)
        const METRICS = [
          { label: '日常基线（越高越好）', get: r => r.deep && r.deep.baseline, better: 'max', fmt: num },
          { label: '近 7 日环比（越高越好）', get: r => r.deep && r.deep.growth, better: 'max', fmt: pct },
          { label: '最近更新（越近越好）', get: r => r.deep && r.deep.ageDays, better: 'min', fmt: n => `${n} 天前` },
          { label: '版本节奏（越短越活跃）', get: r => r.deep && r.deep.cadence, better: 'min', fmt: n => `${n} 天/版` },
          { label: '健康度（越高越好）', get: r => r.deep && r.deep.score, better: 'max', fmt: n => String(n) },
          { label: '周下载（含非人类流量）', get: r => r.weekly, better: 'max', fmt: num },
        ]
        const best = METRICS.map(m => {
          const vals = rows.map(r => [r.name, m.get(r)]).filter(([, x]) => x != null && !Number.isNaN(x))
          if (!vals.length) return { label: m.label, winner: null }
          vals.sort((a, b) => (m.better === 'max' ? b[1] - a[1] : a[1] - b[1]))
          return { label: m.label, winner: vals[0][0], value: m.fmt(vals[0][1]) }
        })
        rows.sort((a, b) => ((b.deep && b.deep.score) ?? -1) - ((a.deep && a.deep.score) ?? -1))
        return plain({ header: header(cat), best, rows: annotate(rows, cat, installed()), missing })
      },
    }),

    defineTool({
      name: 'pick_rank',
      description:
        '插件排行榜：全部或某一类，可按周下载、日常基线、环比增速、健康度排。用户问「哪些插件最火 / 某类里谁最好」时用它。',
      parameters: {
        metric: { type: 'string', enum: ['weekly', 'baseline', 'growth', 'score'], description: '排序指标，默认 baseline（日常基线，最接近真实使用量）' },
        category: { type: 'string', enum: CATS, description: '只看某一类（可省略）' },
        limit: { type: 'integer', description: '前几名，默认 10，最多 30' },
      },
      output: {
        schema: ANY_JSON,
        render: (_a, v) => [{
          type: 'text',
          text: `${v.header}\n排行：${v.category || '全部'} · 按${v.metricLabel}\n${v.rows.map((r, i) => `${i + 1}.${line(r).slice(1)}`).join('\n')}\n\n${NOTE}`,
        }],
      },
      async execute(args) {
        const cat = await loadCatalog()
        const LABELS = { weekly: '周下载', baseline: '日常基线', growth: '环比增速', score: '健康度' }
        const metric = LABELS[args.metric] ? args.metric : 'baseline'
        const category = CATS.includes(args.category) ? args.category : null
        const rows = rank(cat, { metric, category, limit: clampInt(args.limit, 1, 30, 10) }).map(fromRec)
        return plain({ header: header(cat), metric, metricLabel: LABELS[metric], category, rows: annotate(rows, cat, installed()) })
      },
    }),
  ]
}

/** 注册工具；返回反注册函数数组 */
export async function registerTools(ctx, deps = {}) {
  const defs = await buildToolDefinitions(deps)
  return defs.map(def => ctx.tools.register(def))
}
