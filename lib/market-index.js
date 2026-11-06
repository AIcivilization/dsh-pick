// lib/market-index.js — 把目录变成 DSH「插件 → 发现」能读的插件索引（index.json，format 1）
//
// DSH 的「发现」页读用户添加的插件索引源，格式由官方定义（deepseek-harness 仓库
// .agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md），
// 官方校验器是 @deepseek-ai/dsh-plugin-market-index。要点：
//   - 只收声明了 dsh.bundle 和顶层 engines.dsh 的插件，engines.dsh 原样照抄（官方的硬性要求）
//   - 每个版本要有发布时间（秒）、来源（这里都是 npm）；dist-tags 只能指向列出来的版本
//   - 读取方遇到任何一处不合规就拒收整份索引——所以每条先单独过校验，不合格的剔除并记下原因
//
// 每日构建时生成，和目录一起推到 catalog 分支；插件启动时把 INDEX_URL 加进「发现」（plugin/index.js）。

import { parseRepo } from './github.js'

export const INDEX_URL = 'https://cdn.jsdelivr.net/gh/AIcivilization/dsh-pick@catalog/index.json'

/** 目录的分类 → 索引里的分类 id（索引要求 id 稳定，不能用会变的中文名） */
const CATEGORY_IDS = {
  '界面与主题': ['ui', 'UI & themes'],
  '记忆与上下文': ['memory', 'Memory & context'],
  '模型与网关': ['models', 'Models & gateways'],
  '搜索与检索': ['search', 'Search & retrieval'],
  '用量与计费': ['usage', 'Usage & billing'],
  '自动化与多智能体': ['automation', 'Automation & agents'],
  '远程与部署': ['remote', 'Remote & deploy'],
  '文档与办公': ['docs', 'Docs & office'],
  '媒体与生成': ['media', 'Media & generation'],
  '集成与连接': ['integrations', 'Integrations'],
  '插件市场与工具链': ['tooling', 'Markets & tooling'],
  '安全与权限': ['security', 'Security & permissions'],
  '代码与开发': ['code', 'Code & development'],
  '其他': ['other', 'Other'],
}

const SORT_KEYS = {
  downloads: { title: { en: 'Weekly downloads', zh: '周下载' }, order: 'desc' },
  baseline: { title: { en: 'Daily baseline (denoised)', zh: '日常基线（去噪）' }, order: 'desc' },
  stars: { title: { en: 'GitHub stars', zh: 'GitHub 星标' }, order: 'desc' },
  health: { title: { en: 'Health score', zh: '健康度' }, order: 'desc' },
}

const nonBlank = v => typeof v === 'string' && /\S/.test(v)
const finite = v => (Number.isFinite(v) ? v : undefined)

/** 索引的根：标题、说明、分类与排序项的声明 */
export function indexRoot() {
  const categories = {}
  for (const [zh, [id, en]] of Object.entries(CATEGORY_IDS)) categories[id] = { title: { en, zh } }
  return {
    format: 1,
    title: { en: 'dsh-pick · DSH plugin picks', zh: 'dsh-pick 选插件' },
    description: {
      en: 'Every npm DSH plugin that declares engines.dsh and a bundle, sorted by weekly downloads, with denoised download metrics and GitHub stars. Rebuilt daily; a community index, not an official DeepSeek one.',
      zh: '所有声明了 engines.dsh 和 bundle 的 npm DSH 插件，按周下载排，带去噪后的下载指标和 GitHub 星标。每天重建；社区索引，不是 DeepSeek 官方的。',
    },
    metadata: { categories, sortKeys: SORT_KEYS },
  }
}

/**
 * 目录里的一个包 → 索引里的一个插件；不够格返回 { skip: 原因 }
 * @param {object} rec 目录记录（归一化前后都行）
 * @param {string} [publishedAt] 最新版的发布时间（ISO）；不给就用 rec.t
 */
export function indexEntry(rec, publishedAt) {
  const inst = rec.inst || {}
  if (!inst.b) return { skip: '没声明 dsh.bundle' }
  if (!nonBlank(inst.e)) return { skip: '没声明 engines.dsh' }
  if (!nonBlank(rec.v)) return { skip: '没有版本号' }
  const ms = Date.parse(publishedAt || rec.t || '')
  if (!Number.isFinite(ms)) return { skip: '没有发布时间' }

  const entry = { name: rec.n }
  if (nonBlank(rec.d)) entry.description = rec.d.trim()
  if (nonBlank(inst.a)) entry.author = inst.a.trim()
  if (/^https?:\/\/[^\s?#]+$/.test(rec.home || '')) entry.homepage = rec.home
  const repo = parseRepo(rec.repo) || parseRepo(rec.home)
  if (repo) entry.repository = { url: `https://github.com/${repo}` }

  const sortKeys = {}
  const d = rec.deep
  if (finite(rec.w) !== undefined) sortKeys.downloads = rec.w
  if (d && finite(d.base ?? d.baseline) !== undefined) sortKeys.baseline = d.base ?? d.baseline
  if (rec.gh && finite(rec.gh.s) !== undefined) sortKeys.stars = rec.gh.s
  if (d && finite(d.s ?? d.score) !== undefined) sortKeys.health = d.s ?? d.score
  entry.metadata = {
    category: (CATEGORY_IDS[rec.cat] || CATEGORY_IDS['其他'])[0],
    keywords: (rec.kw || []).filter(nonBlank),
    sortKeys,
  }
  entry['dist-tags'] = { latest: rec.v }
  entry.versions = [{
    version: rec.v,
    publishTimestamp: Math.floor(ms / 1000),
    source: { type: 'npm' },
    engines: { dsh: inst.e },
  }]
  return { entry }
}

/**
 * 生成整份索引
 * @param {object} catalog 目录
 * @param {object} opt
 * @param {(value: object, url: string) => unknown} opt.parse 官方校验器的 parseMarketIndex：不合规就抛错
 * @param {Record<string, string>} [opt.times] 包名 → 最新版发布时间（目录里没有 t 的，构建脚本另外查）
 * @returns {{ index: object, skipped: Record<string, number>, rejected: {name: string, reason: string}[] }}
 */
export function buildMarketIndex(catalog, { parse, times = {} }) {
  const root = indexRoot()
  const skipped = {}
  const rejected = []
  const plugins = []
  const recs = Object.values(catalog.packages || {}).sort((a, b) => (b.w || 0) - (a.w || 0))
  for (const rec of recs) {
    const { entry, skip } = indexEntry(rec, times[rec.n])
    if (skip) {
      skipped[skip] = (skipped[skip] || 0) + 1
      continue
    }
    // 读取方见到一处不合规就拒收整份：每条先单独校验，不合格的剔掉、记下原因
    try {
      parse({ ...root, plugins: [entry] }, INDEX_URL)
      plugins.push(entry)
    } catch (e) {
      rejected.push({ name: rec.n, reason: `${e.path || ''} ${e.reason || e.message}`.trim() })
    }
  }
  const index = { ...root, plugins }
  parse(index, INDEX_URL) // 整份再校验一次（比如重名），不过就让构建失败
  return { index, skipped, rejected }
}
