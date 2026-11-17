// lib/ai-pick.js — 面板里的「AI 精选」：用 DSH 当前的大模型（和对话里同一个）挑插件
//
// 关键字搜索只会字面匹配，不懂需求；对话里的大模型会读懂意思、看简介再判断，所以推荐得更准。
// 这里把同样的能力搬进面板，分两步：
//   1. 查全：让模型把需求展开成一组关键字（中英文、同义说法），每个关键字在全目录里召回候选，合并成 ≤40 个
//   2. 挑准：把候选的简介和数据交给模型，让它按「是不是真能解决这个需求」挑出 ≤8 个，每个写一句理由
// 模型给的包名逐个核对：不在候选里的丢掉（防止编造）；数字只用我们给的，不让模型自己推算。
// 点了按钮才调用（花用户的 token），打开面板不花。
//
// 调模型的写法照 dsh-vps-manager：DSH 的 llm 服务 + agentDefaultModel（默认模型选择）。

import { randomUUID } from 'node:crypto'
import { searchByNeed } from './engine.js'

const MAX_CANDIDATES = 40
const MAX_PICKS = 8

/** 调一次模型，返回整段文字 */
export async function callModel({ llm, defaultModel, system, user, maxTokens = 1500, signal, purpose = 'dsh-pick' }) {
  if (!llm || typeof llm.stream !== 'function' || !defaultModel || typeof defaultModel.currentSelection !== 'function') {
    throw Object.assign(new Error('这个版本的 DSH 不让插件直接调用模型'), { code: 'no_llm' })
  }
  const route = defaultModel.currentSelection()
  const timeout = AbortSignal.timeout(120000)
  let text = ''
  let finish = { kind: 'stop' }
  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    system,
    messages: [{ role: 'user', id: randomUUID(), content: [{ type: 'text', text: user }], source: { kind: 'plugin:dsh-pick' } }],
    maxTokens,
    purpose,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason ?? finish
  }
  if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
    throw Object.assign(new Error((finish.failure && finish.failure.message) || '模型调用失败'), { code: finish.failure && finish.failure.code })
  }
  return { text: text.trim(), model: route.model }
}

/** 从模型的回答里取出第一个 JSON 对象（模型常在前后加说明或代码块） */
export function extractJson(text) {
  const s = String(text || '')
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)) } catch { return null }
    }
  }
  return null
}

const KEYWORD_SYSTEM = [
  '你帮用户在 DeepSeek Harness（DSH）的插件目录里找插件。目录按包名、关键字、简介做字面匹配。',
  '把用户的需求展开成 4~10 个用来搜索的关键字：中文和英文都要有，包括同义说法和插件作者常用的英文词（比如 database、sql、notify、wechat、memory、theme）。',
  '只回答一个 JSON 对象，形如 {"keywords":["...","..."]}，不要别的文字。',
].join('\n')

const PICK_SYSTEM = [
  '你是 DeepSeek Harness（DSH）插件选型顾问，目标是给用户推荐真正好用、真能解决他需求的插件。',
  '下面给出用户的需求和一批候选插件（简介 + 数据）。请挑出真正适合的，最多 8 个，按合适程度排序；只是沾边、功能不对、装不了的不要选。',
  '判断依据：先看功能是否对得上需求，再看数据：日常基线（去噪后的每日使用量，比周下载可靠）、最近更新、是否被精选或官方收录、GitHub 星标。周下载含 CI 和镜像流量，不等于用户数。',
  '只能用给出的信息，不要编造插件或数字。理由用中文，每条不超过 40 个字，说清楚为什么适合；有明显的坑（比如很久没更新、只支持某个平台）写在 caveat 里。',
  '只回答一个 JSON 对象，形如 {"picks":[{"name":"包名","fit":0到100,"reason":"理由","caveat":"注意事项，可省略"}],"note":"一句话总结，可省略"}，不要别的文字。一个都不合适时 picks 为空数组，并在 note 里说明。',
].join('\n')

const num = n => (n == null ? '—' : Number(n).toLocaleString('en-US'))

/** 一个候选给模型看的一行 */
function candidateLine(i, rec, extra) {
  const d = rec.deep
  const days = d && d.age != null ? `${d.age} 天前更新` : rec.t ? `最近发版 ${String(rec.t).slice(0, 10)}` : ''
  return [
    `${i + 1}. ${rec.n}`,
    rec.cat ? `分类：${rec.cat}` : '',
    `周下载 ${num(rec.w)}`,
    d ? `日常基线 ${num(d.base)}/天` : '',
    rec.gh && rec.gh.s != null ? `GitHub ★${num(rec.gh.s)}` : '',
    rec.gh && rec.gh.a ? '仓库已归档' : '',
    days,
    rec.src && rec.src.length ? `收录于 ${rec.src.join('、')}` : '',
    extra,
    `简介：${String(rec.d || '').slice(0, 160)}`,
  ].filter(Boolean).join(' · ')
}

/**
 * 用关键字召回候选：每个关键字各取一批，按「最好的相关度」合并，再按相关度为主、使用量为辅排序
 * @returns {object[]} 目录记录
 */
export function recall(catalog, need, keywords) {
  const best = new Map()
  const add = (list, weight) => {
    for (const r of list) {
      const score = r.relevance * weight
      if (!best.has(r.name) || best.get(r.name) < score) best.set(r.name, score)
    }
  }
  add(searchByNeed(catalog, need, { limit: 20 }), 1)
  for (const k of keywords) add(searchByNeed(catalog, k, { limit: 12 }), 0.9)
  return [...best.entries()]
    .map(([name, score]) => ({ rec: catalog.packages[name], score }))
    .filter(x => x.rec)
    .sort((a, b) => b.score + Math.log10((b.rec.w || 0) + 1) * 3 - (a.score + Math.log10((a.rec.w || 0) + 1) * 3))
    .slice(0, MAX_CANDIDATES)
    .map(x => x.rec)
}

/**
 * AI 精选
 * @param {object} opt
 * @param {string} opt.need 用户的需求（原话）
 * @param {object} opt.catalog 目录（loadCatalog 的结果）
 * @param {object} opt.llm DSH 的 llm 服务
 * @param {object} opt.defaultModel DSH 的 agentDefaultModel 服务
 * @param {Set<string>} [opt.installed] 已装的插件
 * @returns {Promise<{picks: object[], note: string, keywords: string[], candidates: number, model: string}>}
 */
export async function aiPick({ need, catalog, llm, defaultModel, installed = new Set(), signal }) {
  const q = String(need || '').trim().slice(0, 300)
  if (!q) throw Object.assign(new Error('先写下你想解决什么问题'), { code: 'empty' })

  // 1. 查全
  const k = await callModel({ llm, defaultModel, system: KEYWORD_SYSTEM, user: q, maxTokens: 300, signal, purpose: 'dsh-pick-keywords' })
  const parsed = extractJson(k.text)
  const keywords = [...new Set((parsed && Array.isArray(parsed.keywords) ? parsed.keywords : [])
    .filter(w => typeof w === 'string').map(w => w.trim().slice(0, 40)).filter(Boolean))].slice(0, 12)
  const cands = recall(catalog, q, keywords)
  if (!cands.length) return { picks: [], note: '目录里没找到相关的插件，换个说法试试。', keywords, candidates: 0, model: k.model }

  // 2. 挑准
  const lines = cands.map((rec, i) => candidateLine(i, rec, [
    installed.has(rec.n) ? '已安装' : '',
    rec.inst && rec.inst.b === false ? '没声明 dsh.bundle，DSH 装不了' : '',
    rec.inst && rec.inst.p && rec.inst.p !== 'web' ? `${rec.inst.p} 客户端插件` : '',
  ].filter(Boolean).join(' · ')))
  const p = await callModel({
    llm, defaultModel, system: PICK_SYSTEM,
    user: `用户的需求：${q}\n\n候选插件（共 ${cands.length} 个）：\n${lines.join('\n')}`,
    maxTokens: 1800, signal, purpose: 'dsh-pick-rerank',
  })
  const out = extractJson(p.text) || {}
  const names = new Set(cands.map(r => r.n))
  const seen = new Set()
  const picks = (Array.isArray(out.picks) ? out.picks : [])
    .filter(x => x && typeof x.name === 'string' && names.has(x.name) && !seen.has(x.name) && seen.add(x.name))
    .slice(0, MAX_PICKS)
    .map(x => ({
      name: x.name,
      fit: Math.max(0, Math.min(100, Math.round(Number(x.fit) || 0))),
      reason: typeof x.reason === 'string' ? x.reason.trim().slice(0, 80) : '',
      caveat: typeof x.caveat === 'string' ? x.caveat.trim().slice(0, 80) : '',
    }))
  const note = typeof out.note === 'string' ? out.note.trim().slice(0, 160) : ''
  if (!picks.length && !note && !extractJson(p.text)) throw new Error('模型没按格式回答，再试一次')
  return { picks, note, keywords, candidates: cands.length, model: p.model }
}
