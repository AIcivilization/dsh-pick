/* dsh-pick 面板逻辑 —— 选插件四步：说需求 → 找候选 → 多维比较 → 出结论 */

// 两种宿主的资源路径不同，这里集中定义，别的地方只认这两个键
//   dsh-pick serve（独立预览）→ /lib/words.js、/data/catalog.json
//   DSH 插件内嵌 iframe       → /api-dsh-pick/words.js、/api-dsh-pick/catalog.json
const IS_PLUGIN = location.pathname.indexOf('/api-dsh-pick') === 0
const P = {
  words: IS_PLUGIN ? '/api-dsh-pick/words.js' : '/lib/words.js',
  catalog: IS_PLUGIN ? '/api-dsh-pick/catalog.json' : '/data/catalog.json',
  live: IS_PLUGIN ? '/api-dsh-pick/live' : '/live',
}

// 嵌在 DSH 里（同源 iframe）才有「+AI」和「安装」：消息交给外层（plugin/client.js）写进当前对话；
// 独立打开（dsh-pick serve）时外面没有 DSH，这两样都不显示
let IN_DSH = false
try { IN_DSH = IS_PLUGIN && window.parent !== window && Boolean(window.parent.document) } catch { IN_DSH = false }

const $ = s => document.querySelector(s)
let CAT = null
let cands = []
let picked = []
const WATCH_KEY = 'dsh-pick-watch-v1'

const PALETTE = ['#2f6bff', '#00a39a', '#f5a524', '#e2557b', '#8b5cf6', '#0f9d58', '#d97a06']
const colorOf = i => PALETTE[i % PALETTE.length]

const num = n => (n === null || n === undefined) ? '—' : Number(n).toLocaleString('en-US')
const pct = n => (n === null || n === undefined) ? '—' : (n >= 0 ? '+' : '') + Math.round(n * 100) + '%'
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/* ---------------- 发到对话 / 安装 ---------------- */
let toastTimer = 0
function toast(text, command) {
  const el = $('#toast')
  el.innerHTML = esc(text) + (command ? `<code>${esc(command)}</code>` : '')
  el.classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('on'), command ? 9000 : 3500)
}

// 外层回话：发出去了没有
const ASK_RESULT = {
  sent: '已发到对话，AI 正在看',
  queued: '这句已经在对话里排着队了',
  draft: '对话输入框里还有没发出的文字，先发掉或清空再试',
  none: '没找到当前对话：先打开一个对话，再从右侧栏用',
}
let askSeq = 0
window.addEventListener('message', e => {
  if (e.source !== window.parent || !e.data || e.data.type !== 'dsh-pick:ask-result') return
  toast(ASK_RESULT[e.data.status] || '没发出去，再试一次')
})

/** 把一段话交给外层，写进当前对话发出去 */
function askAI(text) {
  if (!IN_DSH) return
  window.parent.postMessage({ type: 'dsh-pick:ask', id: ++askSeq, text }, location.origin)
}

/** 一个包的关键数字（发给 AI 用，一行） */
function factLine(r) {
  const d = r.deep
  return [
    r.w != null ? `周下载 ${num(r.w)}` : '',
    d ? `日常基线 ${num(d.base)}` : (r.w != null ? '无去噪指标（周下载 Top 之外）' : '只在 GitHub，没有 npm 数据'),
    d ? `近 7 日环比 ${pct(d.growth)}` : '',
    d && d.cadence != null ? `${d.cadence} 天/版` : '',
    d && d.age != null ? `${d.age} 天前更新` : '',
    d ? `健康度 ${d.s}` : '',
    r.rank ? `总榜 #${r.rank}` : '',
    r.gh ? [`GitHub ★${r.gh.s}`, r.gh.f != null ? `Fork ${r.gh.f}` : '', r.gh.i != null ? `未关闭 issue/PR ${r.gh.i}` : '', r.gh.p ? `最近提交 ${r.gh.p}` : '', r.gh.a ? '已归档' : ''].filter(Boolean).join('、') : '',
  ].filter(Boolean).join(' · ')
}
const needLine = () => {
  const need = $('#need').value.trim()
  return need ? `我的需求：${need}` : null
}
const dataAsOf = () => `（dsh-pick 数据，截止 ${CAT.anchor}；下载量含 CI / 镜像流量，不等于用户数）`
const TAIL = '需要更多数据可以用 pick_search / pick_stats / pick_compare 查。先只分析，不要安装。'

function askCard(r) {
  return [
    `帮我看看 DSH 插件 ${r.n}（v${r.v}，${r.cat}）值不值得装。`,
    needLine(),
    `简介：${String(r.d || '').slice(0, 200)}`,
    `数据${dataAsOf()}：${factLine(r)}`,
    '',
    `请说说它适不适合我、有什么风险、有没有更好的替代。${TAIL}`,
  ].filter(x => x != null).join('\n')
}

function askCands() {
  return [
    `我在找 DSH 插件，需求是「${$('#need').value.trim()}」。dsh-pick 找到这些候选${dataAsOf()}：`,
    ...cands.map((r, i) => `${i + 1}. ${r.n}（${r.cat}）— ${factLine(r)} — ${String(r.d || '').slice(0, 80)}`),
    '',
    `请帮我挑出最合适的 1~2 个并说明理由，不合适的也说一句为什么。${TAIL}`,
  ].join('\n')
}

function askVerdict() {
  const rows = picked.map(cmpRec).filter(Boolean)
  const rule = $('#verdicts').innerText.trim().replace(/\n+/g, ' / ')
  return [
    `帮我在这几个 DSH 插件里做个选择${dataAsOf()}。`,
    needLine(),
    ...rows.map(r => `- ${r.n}（${r.cat}）：${factLine(r)}`),
    rule ? `dsh-pick 的规则结论（只按数字算的，仅供参考）：${rule}` : null,
    '',
    `请结合我的需求重新判断：选哪个、为什么、什么情况下该选别的。${TAIL}`,
  ].filter(x => x != null).join('\n')
}

function askWatch() {
  const rows = watch().map(watchRec).filter(Boolean)
  rows.forEach(r => { if (r.label) r.n = r.label })
  const live = LIVE.at ? `（npm 实时数据，${new Date(LIVE.at).toLocaleString()} 刷新；下载量含 CI / 镜像流量，不等于用户数）` : dataAsOf()
  return [
    `帮我看看我关注的这些 DSH 插件最近怎么样${live}：`,
    ...rows.map(r => `- ${r.n}（${r.cat}）：${factLine(r)}`),
    '',
    `谁在涨、谁停更了、有没有该换掉的？${TAIL}`,
  ].join('\n')
}

// 已装的插件、能不能在这里装（外层 DSH 的插件管理器）
let INSTALLED = new Set()
let CAN_INSTALL = false
async function loadInstalled() {
  if (!IN_DSH) return
  try {
    const j = await (await fetch('/api-dsh-pick/installed', { cache: 'no-store' })).json()
    INSTALLED = new Set(j.names || [])
    CAN_INSTALL = Boolean(j.canInstall)
  } catch { /* 拿不到就不显示安装 */ }
}

// 和当前 DSH 兼不兼容：问插件市场（dshmarket）的接口——它按插件声明的 DSH 版本要求算好了，
// 规则和它的安装检查一致。没装插件市场就不显示这一项（接口 404），只用目录里的安装信息
const COMPAT = new Map() // 包名 → { status: 'compatible'|'incompatible'|'unknown', requirement }
let HOST_VERSION = null
let marketCompat = true
async function loadCompat(names) {
  if (!IN_DSH || !marketCompat) return
  const want = names.filter(n => !COMPAT.has(n)).slice(0, 64)
  if (!want.length) return
  want.forEach(n => COMPAT.set(n, null)) // 先占位：查不到也不反复查
  try {
    const r = await fetch('/dsh-market/discovery-compatibility', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packages: want }),
    })
    if (r.status === 404) { marketCompat = false; return }
    if (!r.ok) return
    const j = await r.json()
    HOST_VERSION = j.hostVersion || HOST_VERSION
    for (const [n, v] of Object.entries(j.plugins || {})) COMPAT.set(n, v || null)
    renderCands($('#need').value.trim(), { keepCompat: true })
  } catch { /* 查不到就不显示 */ }
}

/** 已装插件里和它同类的（「其他」类不算，太杂） */
function sameKindInstalled(r) {
  if (!r.cat || r.cat === '其他' || INSTALLED.has(r.n)) return []
  return [...INSTALLED].filter(n => n !== r.n && n !== 'dsh-pick' && CAT.packages[n] && CAT.packages[n].cat === r.cat)
}

/**
 * 能不能装、为什么不能：目录里的安装信息（dsh.bundle、客户端平台）+ 插件市场给的兼容结论
 * @returns {{ok: boolean, warn: string[], good: string[]}}
 */
function installCheck(r) {
  const warn = []
  const good = []
  let ok = true
  const inst = r.inst
  if (inst && !inst.b) { ok = false; warn.push('没声明 dsh.bundle，DSH 装不了') }
  if (inst && inst.p && inst.p !== 'web') { ok = false; warn.push(`${inst.p} 客户端插件，装进这里可能让 DSH 起不来`) }
  const c = COMPAT.get(r.n)
  if (c && c.status === 'incompatible') {
    ok = false
    warn.push(`和你的 DSH${HOST_VERSION ? ' ' + HOST_VERSION : ''} 不兼容${c.requirement ? `（需要 ${c.requirement}）` : ''}`)
  } else if (c && c.status === 'compatible' && ok) {
    // 已经装不了（没 bundle、终端版）就不说「兼容」：版本对得上不等于装得上，两句放一起让人困惑
    good.push(`兼容你的 DSH${HOST_VERSION ? ' ' + HOST_VERSION : ''}`)
  }
  if (r.gh && r.gh.a) warn.push('GitHub 仓库已归档，作者不再维护')
  else if (r.gh && daysSince(r.gh.p) > 180) warn.push(`仓库 ${Math.round(daysSince(r.gh.p) / 30)} 个月没有提交`)
  const same = sameKindInstalled(r)
  if (same.length) warn.push(`你已装同类：${same.join('、')}`)
  return { ok, warn, good }
}

/** 卡片上的提醒行 */
function checkRow(r) {
  if (!IN_DSH) return ''
  const { warn, good } = installCheck(r)
  if (!warn.length && !good.length) return ''
  return `<div class="chk">` +
    good.map(t => `<span class="good">✓ ${esc(t)}</span>`).join('') +
    warn.map(t => `<span class="warn">⚠ ${esc(t)}</span>`).join('') +
    `</div>`
}

// 安装的图标：向下的箭头落进托盘（和 GitHub、npm 图标一样 13px）
const INSTALL_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 12.5v1h11v-1"/></svg>'

/**
 * 安装区：已安装 / 安装（点一下变「确认」，再点才装）/ 装不了。
 * icon = 排行榜这种窄列：和 GitHub、npm 一样只要一个 24×22 的图标，说明放在悬停提示里
 */
function installArea(r, { icon = false } = {}) {
  if (!IN_DSH) return ''
  if (INSTALLED.has(r.n)) {
    return icon ? '<span class="ib in" title="已安装">✓</span>' : '<span class="badge-in">✓ 已安装</span>'
  }
  if (!CAN_INSTALL) return ''
  const check = installCheck(r)
  if (!check.ok) {
    return icon ? `<span class="ib no" title="不能安装：${esc(check.warn.join('；'))}">⊘</span>` : '<span class="badge-no" title="原因见卡片上的提醒">不能安装</span>'
  }
  return icon
    ? `<button class="ib inst-ic" data-install="${esc(r.n)}" data-icon="1" title="安装（点两次：第一次确认）" aria-label="安装 ${esc(r.n)}">${INSTALL_SVG}</button>`
    : `<button class="inst" data-install="${esc(r.n)}" title="用 DSH 的插件管理器安装">安装</button>`
}

async function onInstallClick(btn) {
  const name = btn.dataset.install
  const icon = btn.dataset.icon === '1' // 图标按钮：不换文字，只换样式和提示
  const label = text => { if (!icon) btn.textContent = text }
  if (!btn.classList.contains('confirm')) {
    btn.classList.add('confirm')
    label('确认安装？')
    if (icon) { btn.title = `再点一次，安装 ${name}`; toast(`再点一次安装按钮，确认安装 ${name}`) }
    setTimeout(() => {
      if (btn.isConnected && btn.classList.contains('confirm') && !btn.disabled) {
        btn.classList.remove('confirm'); label('安装')
        if (icon) btn.title = '安装（点两次：第一次确认）'
      }
    }, 4000)
    return
  }
  btn.disabled = true
  label('安装中…')
  if (icon) toast(`正在安装 ${name}…`)
  try {
    const r = await fetch('/api-dsh-pick/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const j = await r.json()
    if (j.ok) {
      INSTALLED.add(name)
      toast(j.restart ? `${name} 已安装，重启 DSH 后生效` : `${name} 已安装`)
      renderCands($('#need').value.trim())
      renderRank()
      renderAi()
      renderOurs()
      return
    }
    toast(j.message || '安装失败', j.command)
  } catch (e) {
    toast('安装请求失败：' + e.message)
  }
  btn.disabled = false
  btn.classList.remove('confirm')
  label('安装')
}

/* ---------- dsh-pick 作者的其他作品：页脚上方一个可展开的介绍区，和榜单分开 ---------- */
// 只列这几个（作者挑的），而且只列最近 60 天内还在更新的；排名不受影响
const OUR_WORKS = ['dsh-vps-manager', 'dsh-vps', 'dsh-model', 'dsh-her', 'dsh-mishu', 'dsh-tingdong', 'dsh-audiobook', 'dsh-checkin-all']
function renderOurs() {
  // 最近一次发版或提交：有的记录没有发版时间（manifest 轮换着读），就看 GitHub 最近提交
  const lastOf = r => [r.deep && r.deep.lastRelease, r.t && String(r.t).slice(0, 10), r.gh && r.gh.p].filter(Boolean).sort().pop() || ''
  const list = OUR_WORKS.map(n => CAT.packages[n]).filter(r => {
    if (!r) return false
    const age = daysSince(lastOf(r))
    return age != null && age <= 60
  })
  $('#secOurs').classList.toggle('hidden', !list.length)
  if (!list.length) return
  $('#oursN').textContent = list.length + ' 个'
  $('#oursList').innerHTML = list.map(r => {
    const age = daysSince(lastOf(r))
    return `<div class="ow">` +
      `<div class="owt"><span class="nm">${esc(r.n)}</span> <span class="v">v${esc(r.v)}</span>` +
        `<span class="owa">${watchBtn(r.n)}${installArea(r, { icon: true })}${linkBtns(r, { icon: true })}</span></div>` +
      (r.d ? `<div class="owd" title="${esc(r.d)}">${esc(r.d)}</div>` : '') +
      `<div class="owk">周下载 ${short(r.w)}${r.gh && r.gh.s ? ` · ★ ${short(r.gh.s)}` : ''} · ${ageText(age)}更新${r.sc != null ? ` · 综合分 ${r.sc}` : ''}</div>` +
    `</div>`
  }).join('') +
    '<p class="cap">这些是 dsh-pick 作者自己做的插件，放在这里只是介绍；在各个榜单里，它们和其他插件用同一套算法排名，没有加分。</p>'
}

/* ---------------- 排名文案与外链按钮 ---------------- */
function rankText(rec) {
  if (!rec.rank) return ''
  const total = `总榜 #<b>${num(rec.rank)}</b>`
  const cat = rec.crank ? ` · ${esc(rec.cat)} #<b>${num(rec.crank)}</b>` : ''
  return total + cat
}

const GH_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A7.99 7.99 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>'
// npm 的方块标志（中间一个 n）：缩到 13px 也认得出；颜色用 npm 的红
const NPM_SVG = '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="#cb3837" d="M0 0h16v16H0z"/><path fill="#fff" d="M3 3h10v10h-2.5V5.5H8V13H3z"/></svg>'

/**
 * 外链按钮。icon = 只要图标（排行榜这种窄列）：悬停看得到完整地址
 */
function linkBtns(rec, { icon = false } = {}) {
  const npm = rec.npmUrl || ('https://www.npmjs.com/package/' + rec.n)
  const cls = icon ? 'lk ic' : 'lk'
  let h = ''
  if (rec.ghUrl) {
    h += `<a class="${cls}" href="${esc(rec.ghUrl)}" target="_blank" rel="noopener" title="GitHub：${esc(rec.ghUrl)}" aria-label="GitHub">${GH_SVG}${icon ? '' : 'GitHub'}</a>`
  }
  if (rec.n) h += `<a class="${cls}" href="${esc(npm)}" target="_blank" rel="noopener" title="npm：${esc(npm)}" aria-label="npm">${NPM_SVG}${icon ? '' : 'npm'}</a>`
  return h
}

/** 最近一次发版：今天 / 昨天 / N天前 / N个月前 */
function ageText(age) {
  if (age == null) return '—'
  if (age <= 0) return '今天'
  if (age === 1) return '昨天'
  if (age < 60) return `${age}天前`
  return `${Math.round(age / 30)}个月前`
}

/**
 * 「更新」一格：上面最近一次发版，下面小字写版本节奏。两行都不折行，
 * 比分成两列（窄栏里每列都被挤成「8 / 天 / 前」三行）省地方也整齐。超过 90 天没发版用提醒色
 */
function maintCell(d) {
  if (!d) return '<td class="r mt">—</td>'
  const stale = d.age != null && d.age > 90
  const cad = d.cadence == null ? '' : `<div class="sub">${d.cadence}天/版</div>`
  return `<td class="r mt" title="最近一次发版 ${d.lastRelease || ''}${d.cadence == null ? '' : ` · 平均 ${d.cadence} 天发一个版本`}">` +
    `<div${stale ? ' class="stale"' : ''}>${ageText(d.age)}</div>${cad}</td>`
}

/* ---------------- 搜索（与 lib/engine.js 共用同一份词典 lib/words.js） --------------- */
const { expandWords } = await import(P.words)

function searchByNeed(need, limit = 10) {
  const terms = expandWords(need)
  if (!terms.length || !CAT) return []

  const maxWeight = terms.reduce((t, s) => t + s.weight, 0)
  const out = []
  for (const rec of Object.values(CAT.packages)) {
    const hay = ((rec.n || '') + ' ' + (rec.kw || []).join(' ') + ' ' + (rec.d || '')).toLowerCase()
    let hit = 0, any = false
    for (const t of terms) if (hay.includes(t.w)) { hit += t.weight; any = true }
    if (!any) continue
    const relevance = hit / maxWeight
    const pop = Math.log10(Math.max(rec.w, 1)) / 6   // 下载量只做微弱加权
    out.push({ rec, relevance, score: relevance * 0.85 + pop * 0.15 })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, limit).map(x => x.rec)
}

/* ---------------- 启动 ---------------- */
async function boot() {
  const res = await fetch(P.catalog, { cache: 'no-store' })
  if (!res.ok) { $('#meta').textContent = '目录缺失，先跑 dsh-pick build'; return }
  CAT = await res.json()

  const deepN = Object.values(CAT.packages).filter(p => p.deep).length
  // 覆盖数：几个插件市场 + npm 合起来去重（每日目录用新代码构建后才有）；旧目录只说 npm 上的包数
  const cover = CAT.boards && CAT.boards.overall && CAT.boards.overall.cover
  const MKT = { dshmarket: 'dshmarket', shop: 'dsh-plugin-shop 商店', 'dsh-m': 'dsh-m 精选', official: 'DeepSeek 官方' }
  $('#meta').innerHTML =
    (cover
      ? `收录 <b>${num(cover.all)}</b> 个插件（4 个市场 + npm 去重）· npm 上 <b>${num(cover.npm)}</b> 个 · 去噪指标 <b>${num(deepN)}</b> 个<br>`
      : `npm 上 <b>${num(CAT.total)}</b> 个插件包 · 去噪指标 <b>${num(deepN)}</b> 个<br>`) +
    `数据截止 <b>${CAT.anchor}</b>（npm 最近有数据的一天）`

  const gapNote = CAT.gaps && CAT.gaps.length
    ? `<br><b>npm 缺数据的日子：</b>${CAT.gaps.map(esc).join('、')}（那几天全 npm 的下载统计都是 0，是 npm 自己没出数据），不参与日常基线和环比的计算。`
    : ''
  $('#foot').innerHTML =
    `<b>排名说明：</b>所有榜单和综合分都是 dsh-pick 按公开数据（npm、GitHub、各插件市场）用自己的算法算的，不是 DSH / DeepSeek 官方排名，只供参考和比较。<br>` +
    `<b>口径：</b>下载量含 CI、镜像、爬虫等非人类流量，不等于用户数；<b>日常基线</b>= 扣掉版本发布日与次日后的每日中位数，比原始下载量更接近真实使用量。<br>` +
    (cover
      ? `<b>覆盖范围：</b>把 ${Object.entries(cover.markets).map(([k, v]) => `${MKT[k] || esc(k)}（${num(v)} 条）`).join('、')}和 npm 上带 <code>dsh-plugin</code> 关键字的包合起来，` +
        `按 npm 包名、GitHub 仓库去重，共 <b>${num(cover.all)}</b> 个插件：${num(cover.npm)} 个发布在 npm（能一键安装、有下载量），${num(cover.gh)} 个只在 GitHub。` +
        `市场里一个仓库拆成好几条、几个市场互相重复收录，所以去重后比各市场条数相加少。` +
        (cover.pending ? `其中 ${num(cover.pending)} 个 npm 包还没补进目录（每天补一批，几天补完），补进来之前不参与排名。` : '') +
        `去噪指标只算了 npm 上周下载最多的 ${num(deepN)} 个。目录每天自动重建。<br>`
      : `<b>覆盖范围：</b>npm 上带 <code>dsh-plugin</code> 关键字、或被插件市场收录的 ${num(CAT.total)} 个 npm 包；去噪指标只算了周下载最多的 ${num(deepN)} 个。目录每天自动重建。<br>`) +
    (IN_DSH
      ? `<b>当前结论由本地规则生成</b>（依据就是对比表里的数字）。点各处的「+AI」，把数据发到对话里让 AI 结合你的场景分析；在对话里也可以直接问「哪个插件能做某某」，AI 会自己查这份目录。`
      : `<b>当前结论由本地规则生成</b>（依据就是对比表里的数字）。装上 DSH 插件版后，可以一键交给 AI，结合你的具体场景解释取舍。`) +
    gapNote

  await loadInstalled()
  renderOurs()
  $('#btnOurs').addEventListener('click', () => {
    const open = $('#oursList').classList.toggle('hidden') === false
    $('#btnOurs').setAttribute('aria-expanded', String(open))
    $('#secOurs').classList.toggle('open', open)
    if (open) renderOurs()
  })
  await loadAiAvailable()
  if (IN_DSH) {
    ;['#aiCands', '#aiVerdict', '#aiWatch'].forEach(id => $(id).classList.remove('hidden'))
    $('#verdictCap').textContent = '以下判断由本地规则给出，只看数字。点「+AI 帮我判断」，让对话里的 AI 结合你的具体场景解释取舍。'
  }

  buildCategoryFilter()
  renderRank()
  renderWatch()
  bindEvents()

  // 支持 ?q=需求 直接带上搜索结果，方便分享「结论链接」
  const q = new URLSearchParams(location.search).get('q')
  if (q) {
    $('#need').value = q
    doSearch()
  }
}

function bindEvents() {
  $('#btnFind').addEventListener('click', doSearch)
  $('#btnAi').addEventListener('click', runAiPick)
  // 比较清单：输入插件名加入
  bindSuggest({
    input: $('#addCmp'), box: $('#addSug'), has: n => picked.includes(n), hasText: '已在清单里',
    onPick: n => { if (!picked.includes(n)) togglePick(n); $('#secCmp').scrollIntoView({ block: 'nearest' }) },
  })
  // 我的监控：「＋ 添加」打开输入框；选建议里的，或直接回车按输入的名字 / GitHub 地址加
  const watchInput = $('#addWatch')
  const watchSug = bindSuggest({
    input: watchInput, box: $('#watchSug'), has: n => watch().includes(n), hasText: '已在监控里',
    onPick: n => addToWatch(n), onEnter: text => addToWatch(text),
  })
  $('#btnWatchAdd').addEventListener('click', () => {
    const open = $('#watchAdd').classList.toggle('hidden') === false
    $('#btnWatchAdd').setAttribute('aria-expanded', String(open))
    if (open) watchInput.focus()
  })
  $('#watchAddGo').addEventListener('click', () => watchSug.submit())
  $('#need').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch() })

  document.querySelectorAll('.examples .chip').forEach(c => {
    c.addEventListener('click', () => { $('#need').value = c.textContent; doSearch() })
  })

  document.querySelectorAll('#tabs button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b))
      const t = b.dataset.tab
      // 每个标签一块内容：tab-pick / tab-rank / tab-watch
      document.querySelectorAll('#tabs button').forEach(x => $('#tab-' + x.dataset.tab).classList.toggle('hidden', x.dataset.tab !== t))
      if (t === 'watch') layoutWatchDetail() // 标签页隐藏时量不出宽度，显示出来再选版式
      // 打开「我的监控」时，数据超过 6 小时没刷新就自动刷新一次
      if (t === 'watch' && watch().length && (!LIVE.at || Date.now() - Date.parse(LIVE.at) > 6 * 3600 * 1000) && !$('#btnWatchRefresh').disabled) refreshWatch()
    })
  })

  document.querySelectorAll('#rankBoard button').forEach(bt => {
    bt.addEventListener('click', () => {
      document.querySelectorAll('#rankBoard button').forEach(x => x.classList.toggle('on', x === bt))
      document.querySelectorAll('#rankFilters .chip').forEach(c => c.classList.toggle('hidden', c.dataset.board !== bt.dataset.b))
      renderRank()
    })
  })
  document.querySelectorAll('#rankFilters .chip').forEach(c => {
    c.addEventListener('click', () => {
      document.querySelectorAll(`#rankFilters .chip[data-board="${c.dataset.board}"]`).forEach(x => x.classList.toggle('on', x === c))
      renderRank()
    })
  })
  $('#rankCat').addEventListener('change', renderRank)
  $('#rankBody').addEventListener('click', e => {
    if (!e.target.closest('[data-rank-more]')) return
    RANK_LIMIT += RANK_STEP
    renderRank()
  })

  $('#aiCands').addEventListener('click', () => cands.length && askAI(askCands()))
  $('#aiVerdict').addEventListener('click', () => picked.length >= 2 && askAI(askVerdict()))
  $('#aiWatch').addEventListener('click', () => watch().length && askAI(askWatch()))
  $('#btnWatchRefresh').addEventListener('click', refreshWatch)
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-watch]')
    if (b) toggleWatch(b.dataset.watch)
    const st = e.target.closest('[data-mine]')
    if (st) toggleMine(st.dataset.mine)
    const un = e.target.closest('[data-unpick]')
    if (un) togglePick(un.dataset.unpick)
    const pk = e.target.closest('#aiList [data-pick]')
    if (pk) togglePick(pk.dataset.pick)
    // AI 精选里的「安装」（搜索结果卡片上的由卡片自己处理）
    const ai = e.target.closest('#aiList [data-install]')
    if (ai) onInstallClick(ai)
    // 排行榜里的「安装」（搜索结果卡片上的由卡片自己处理）
    const ib = e.target.closest('#rankBody [data-install], #oursList [data-install]')
    if (ib) onInstallClick(ib)
  })

  $('#btnExport').addEventListener('click', exportHtml)
  $('#btnWatch').addEventListener('click', addPickedToWatch)
}

/* ---------------- 第 2 步：候选 ---------------- */
function doSearch() {
  const need = $('#need').value.trim()
  if (!need) return
  cands = searchByNeed(need, 10)
  renderCands(need)
}

function renderCands(need, { keepCompat = false } = {}) {
  if (!keepCompat) loadCompat(cands.map(r => r.n))
  const host = $('#cands')
  host.innerHTML = ''
  if (!cands.length) {
    host.innerHTML = '<div class="empty">目录里没找到相关的。换个说法试试，比如「数据库」「微信」「记忆」。</div>'
    $('#secCand').classList.remove('hidden')
    return
  }

  cands.forEach((rec, i) => {
    const on = picked.includes(rec.n)
    const d = rec.deep
    const el = document.createElement('div')
    el.className = 'cand' + (on ? ' on' : '')
    el.innerHTML =
      `<div class="box">${on ? '✓' : ''}</div>` +
      `<div class="body">` +
        `<div class="nm">${esc(rec.n)} <span class="v">v${esc(rec.v)}</span>` +
        `<span class="rel">${esc(rec.cat)}</span>` +
        (d ? '<span class="ok" title="有去噪指标，可参与健康度比较">✓ 可比较</span>' : '<span class="nook" title="未进入去噪范围（周下载 Top 之外），缺基线/环比/节奏">仅基础</span>') +
        `</div>` +
        `<div class="rk">${rankText(rec)}${rec.sc != null ? ` · 综合分 <b>${rec.sc}</b>` : ''}</div>` +
        ((rec.src && rec.src.length) || isOurs(rec) ? `<div>${srcChips(rec.src)}${oursTag(rec)}</div>` : '') +
        `<div class="d">${esc(rec.d)}</div>` +
        `<div class="kv">` +
          `<span>周 <b>${num(rec.w)}</b></span>` +
          `<span>月 <b>${num(rec.m)}</b></span>` +
          (d ? `<span>基线 <b>${num(d.base)}</b></span><span>环比 <b>${pct(d.growth)}</b></span>` : '') +
          (rec.gh ? `<span title="GitHub 星标 · 最近提交 ${esc(rec.gh.p || '—')}">★ <b>${short(rec.gh.s)}</b></span>` : '') +
        `</div>` +
        checkRow(rec) +
        `<div class="links">${watchBtn(rec.n)}${linkBtns(rec)}<span class="sp"></span>${installArea(rec)}` +
          (IN_DSH ? `<button class="ai" data-ask title="把这个插件的数据发到对话里问 AI">+AI</button>` : '') +
        `</div>` +
      `</div>`
    el.addEventListener('click', e => {
      // 卡片上的按钮和链接各管各的，不算「选中」
      const ask = e.target.closest('[data-ask]')
      if (ask) { e.stopPropagation(); askAI(askCard(rec)); return }
      const inst = e.target.closest('[data-install]')
      if (inst) { e.stopPropagation(); onInstallClick(inst); return }
      if (e.target.closest('a, [data-watch]')) return
      togglePick(rec.n)
    })
    host.appendChild(el)
  })

  $('#secCand').classList.remove('hidden')
  $('#candCount').textContent = `「${esc(need)}」命中 ${cands.length} 个 · 已选 ${picked.length}`
}

function togglePick(name) {
  if (picked.includes(name)) picked = picked.filter(x => x !== name)
  else {
    if (picked.length >= 6) { toast('最多比较 6 个，先移除一个'); return }
    picked.push(name)
  }
  if (cands.length) renderCands($('#need').value.trim())
  renderPickBar()
  renderAi()
  renderCompare()
  fillCompareLive()
}

/* ---------------- 比较清单：搜索结果之外的插件也能加进来 ---------------- */
function renderPickBar() {
  $('#pickChips').innerHTML = picked.length
    ? picked.map(n => `<span class="pickchip">${esc(n)}<button data-unpick="${esc(n)}" title="移出比较" aria-label="把 ${esc(n)} 移出比较">×</button></span>`).join('')
    : '<span class="none">还没有，点候选卡片或在右边输入插件名</span>'
}

/** 按名字找插件：名字开头吻合的优先，其次名字里包含、关键字吻合；同档按周下载 */
function suggest(q) {
  q = q.trim().toLowerCase()
  if (q.length < 2) return []
  const out = []
  for (const r of Object.values(CAT.packages)) {
    const n = r.n.toLowerCase()
    const tier = n.startsWith(q) || n.split('/').pop().startsWith(q) ? 0 : n.includes(q) ? 1 : (r.kw || []).some(k => String(k).toLowerCase() === q) ? 2 : -1
    if (tier >= 0) out.push([tier, r])
  }
  return out.sort((a, b) => a[0] - b[0] || (b[1].w || 0) - (a[1].w || 0)).slice(0, 8).map(x => x[1])
}
/**
 * 输入框 + 下拉建议（比较清单、我的监控共用）：上下键选、回车加、Esc 收起。
 * 没有建议、或没选中时回车：交给 onEnter（按输入的原文加），没有 onEnter 就不动
 */
function bindSuggest({ input, box, has, hasText, onPick, onEnter }) {
  let items = []
  let on = -1
  const render = () => {
    if (!items.length) { box.classList.add('hidden'); return }
    box.innerHTML = items.map((r, i) => `<div class="opt${i === on ? ' on' : ''}" data-add="${esc(r.n)}" role="option">` +
      `<b>${esc(r.n)}</b>${has(r.n) ? ` <em style="color:var(--ok-text);font-style:normal;font-size:11px">${hasText}</em>` : ''}` +
      `<span>周下载 ${short(r.w)}${r.sc != null ? ` · 综合分 ${r.sc}` : ''} · ${esc(String(r.d || '').slice(0, 60))}</span></div>`).join('')
    box.classList.remove('hidden')
  }
  const done = () => { input.value = ''; items = []; render() }
  const pick = n => { onPick(n); done() }
  const submit = () => {
    if (items.length && on >= 0) return pick(items[on].n)
    const text = input.value.trim()
    if (text && onEnter && onEnter(text) !== false) done()
  }
  input.addEventListener('input', () => { items = suggest(input.value); on = items.length ? 0 : -1; render() })
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { submit(); e.preventDefault(); return }
    if (!items.length) return
    if (e.key === 'ArrowDown') { on = (on + 1) % items.length; render(); e.preventDefault() }
    else if (e.key === 'ArrowUp') { on = (on - 1 + items.length) % items.length; render(); e.preventDefault() }
    else if (e.key === 'Escape') { items = []; render() }
  })
  input.addEventListener('blur', () => setTimeout(() => { items = []; render() }, 150))
  box.addEventListener('mousedown', e => {
    const o = e.target.closest('[data-add]')
    if (o) { e.preventDefault(); pick(o.dataset.add) }
  })
  return { submit }
}

/* ---------------- AI 精选：用 DSH 当前的模型挑插件 ---------------- */
let AI_AVAILABLE = false
let LAST_AI = null
async function runAiPick() {
  const need = $('#need').value.trim()
  if (!need) { toast('先写下你想解决什么问题'); $('#need').focus(); return }
  const btn = $('#btnAi')
  btn.disabled = true
  btn.textContent = 'AI 挑选中…'
  $('#secAi').classList.remove('hidden')
  $('#aiMeta').textContent = ''
  $('#aiList').innerHTML = '<div class="ai-wait">正在用你的模型挑选：读懂需求 → 从全部目录里召回候选 → 逐个判断。通常要 10～40 秒…</div>'
  try {
    const r = await fetch('/api-dsh-pick/ai-pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ need }) })
    const j = await r.json()
    if (!j.ok) {
      LAST_AI = null
      $('#aiList').innerHTML = `<div class="ai-wait" style="color:var(--warn-text)">${esc(j.message || 'AI 精选失败')}</div>`
    } else {
      LAST_AI = { ...j, need }
      renderAi()
    }
  } catch (e) {
    $('#aiList').innerHTML = `<div class="ai-wait" style="color:var(--warn-text)">AI 精选请求失败：${esc(e.message)}</div>`
  }
  btn.disabled = false
  btn.textContent = 'AI 精选'
}
function renderAi() {
  const j = LAST_AI
  if (!j) return
  $('#aiMeta').textContent = `「${j.need}」· 模型 ${j.model || '—'} · 从 ${j.candidates} 个候选里挑出 ${j.picks.length} 个`
  const kw = j.keywords && j.keywords.length ? `<div class="data" style="margin-bottom:8px">模型用来搜索的关键字：${j.keywords.map(esc).join('、')}</div>` : ''
  const note = j.note ? `<div class="why" style="margin-bottom:10px">${esc(j.note)}</div>` : ''
  $('#aiList').innerHTML = note + kw + (j.picks.length ? j.picks.map(p => {
    const rec = CAT.packages[p.name] || { n: p.name }
    const d = rec.deep
    const on = picked.includes(p.name)
    return `<div class="aip">` +
      `<div class="top"><span class="nm">${esc(p.name)}</span>${rec.v ? `<span style="color:var(--t3);font-size:11px">v${esc(rec.v)}</span>` : ''}${oursTag(rec)}<span class="fit" title="模型判断的合适程度（0~100）">合适度 ${p.fit}</span></div>` +
      (p.reason ? `<div class="why">${esc(p.reason)}</div>` : '') +
      (p.caveat ? `<div class="cav">⚠ ${esc(p.caveat)}</div>` : '') +
      `<div class="data">周下载 ${short(rec.w)}${d ? ` · 日常基线 ${short(d.base)}/天` : ''}${rec.gh ? ` · ★ ${short(rec.gh.s)}` : ''}${rec.sc != null ? ` · 综合分 ${rec.sc}` : ''}${d && d.age != null ? ` · ${ageText(d.age)}更新` : ''}</div>` +
      `<div class="acts"><button class="cmpbtn${on ? ' on' : ''}" data-pick="${esc(p.name)}">${on ? '✓ 已加入比较' : '加入比较'}</button>${watchBtn(p.name)}${installArea(rec)}${linkBtns(rec, { icon: true })}</div>` +
    `</div>`
  }).join('') : '<div class="ai-wait">模型觉得目录里没有真正合适的。可以换个说法，或看看下面的关键字搜索结果。</div>')
}

async function loadAiAvailable() {
  if (!IN_DSH) return
  try {
    AI_AVAILABLE = Boolean((await (await fetch('/api-dsh-pick/ai-pick', { cache: 'no-store' })).json()).available)
  } catch { AI_AVAILABLE = false }
  $('#btnAi').classList.toggle('hidden', !AI_AVAILABLE)
}

/* ---------------- 第 3 步：比较 ---------------- */
const ROWS = [
  { k: 'w',      label: '周下载',      get: r => r.w,            fmt: num,  best: 'max' },
  { k: 'm',      label: '月下载',      get: r => r.m,            fmt: num,  best: 'max' },
  { k: 'base',   label: '日常基线',    get: r => r.deep && r.deep.base, fmt: num, best: 'max' },
  { k: 'growth', label: '近 7 日环比', get: r => r.deep && r.deep.growth, fmt: pct, best: 'max' },
  { k: 'ver',    label: '版本数',      get: r => r.deep && r.deep.versions, fmt: num, best: 'max' },
  { k: 'cad',    label: '版本节奏',    get: r => r.deep && r.deep.cadence, fmt: r => r == null ? '—' : r + ' 天/版', best: 'min' },
  { k: 'age',    label: '最近更新',    get: r => r.deep && r.deep.age, fmt: r => r == null ? '—' : r + ' 天前', best: 'min' },
  { k: 's',      label: '健康度',      get: r => r.deep && r.deep.s, fmt: num, best: 'max' },
  { k: 'tot',    label: '累计下载',    get: r => r.total, fmt: num, best: 'max' },
  { k: 'gs',     label: 'GitHub 星标', get: r => r.gh && r.gh.s, fmt: num, best: 'max' },
  { k: 'gp',     label: '最近提交',    get: r => r.gh && daysSince(r.gh.p), fmt: r => r == null ? '—' : ageText(r), best: 'min' },
]

function renderCompare() {
  const sec = $('#secCmp')
  if (picked.length < 2) {
    sec.classList.add('hidden')
    $('#secVerdict').classList.add('hidden')
    $('#candCount').textContent = `「${esc($('#need').value.trim())}」命中 ${cands.length} 个 · 已选 ${picked.length}（选满 2 个开始比较）`
    return
  }

  const rows = picked.map(cmpRec).filter(Boolean)
  const missingDeep = rows.filter(r => !r.deep).length

  $('#cmpHead').innerHTML = '<tr><th>指标</th>' +
    rows.map((r, i) => `<th><i style="background:${colorOf(picked.indexOf(r.n))}"></i>${esc(r.n)}${r.live ? ' <span class="srcchip" title="指标是刚从 npm 实时算的">实时</span>' : ''}</th>`).join('') +
    '</tr>'

  let body = ''
  for (const row of ROWS) {
    const vals = rows.map(r => row.get(r))
    const valid = vals.filter(v => v !== null && v !== undefined && !Number.isNaN(v))
    let bestV = null
    if (valid.length) bestV = row.best === 'max' ? Math.max(...valid) : Math.min(...valid)

    body += `<tr><td>${row.label}</td>` + vals.map(v => {
      const isBest = bestV !== null && v === bestV
      const cls = v === null || v === undefined ? 'miss' : (isBest ? 'best num' : 'num')
      return `<td class="${cls}">${row.fmt(v)}</td>`
    }).join('') + '</tr>'
  }
  $('#cmpBody').innerHTML = body

  $('#cmpNote').innerHTML =
    `健康度 = 日常基线 40% + 增速 25% + 新鲜度 20% + 版本节奏 15%，满分 100。` +
    (rows.some(r => r.live) ? `<br>${rows.filter(r => r.live).map(r => esc(r.n)).join('、')} 不在每日构建的去噪范围（周下载前 300 多名）里，这些指标是刚从 npm 实时算的。` : '') +
    (CMP_PENDING.size ? `<br><span style="color:var(--t3)">正在从 npm 实时计算 ${[...CMP_PENDING].map(esc).join('、')} 的指标…</span>` : '') +
    (missingDeep && !CMP_PENDING.size ? `<br><span style="color:var(--warn-text)">${rows.filter(r => !r.deep).map(r => esc(r.n)).join('、')} 实时也没算出去噪指标（npm 上数据太少或这次没查到），无法参与健康度比较。</span>` : '')

  sec.classList.remove('hidden')
  renderVerdict()
}

/* ---------------- 第 4 步：结论 ---------------- */
function renderVerdict() {
  const rows = picked.map(cmpRec).filter(Boolean)
  const withDeep = rows.filter(r => r.deep)
  const noDeep = rows.filter(r => !r.deep)

  if (withDeep.length < 2) {
    // 不静默消失：说清楚为什么给不出结论，并指路
    $('#verdicts').innerHTML =
      `<div class="verdict alt" style="margin:0"><h4>给不出结论</h4><p>` +
      `已选 ${rows.length} 个，其中 <b>${withDeep.length}</b> 个有去噪指标。` +
      (noDeep.length ? `<b>${noDeep.map(r => esc(r.n)).join('、')}</b> 未进入去噪范围（周下载 Top 之外），缺日常基线、环比、版本节奏，无法参与健康度比较。<br>` : '') +
      `至少需要 2 个带「✓ 可比较」标记的包。上面排行榜里按「日常基线 / 健康度」排序的就是这批。</p></div>`
    $('#secVerdict').classList.remove('hidden')
    return
  }

  byScore = withDeep.slice().sort((a, b) => b.deep.s - a.deep.s)
  const win = byScore[0]
  const others = byScore.slice(1)

  // 备选：基线最高但不是首选的（「更稳的那个」）
  const alt = others.slice().sort((a, b) => b.deep.base - a.deep.base)[0]
  // 不推荐：健康度最低，且要么久不更新，要么基线明显低于首选
  const no = byScore[byScore.length - 1]

  const winName = esc(win.n)
  const html = []

  html.push(`<div class="verdict win"><h4>✅ 首选 ${winName}</h4><p>` +
    `日常基线 <b>${num(win.deep.base)}</b> 次/天（已扣掉发布拉取），` +
    `近 7 日环比 <b>${pct(win.deep.growth)}</b>，` +
    `${win.deep.versions} 个版本、约 <b>${win.deep.cadence === null ? '—' : win.deep.cadence + ' 天'}</b>一个，` +
    `最近更新在 <b>${win.deep.age} 天前</b>，健康度 <b>${win.deep.s}</b>。` +
    `${win.deep.growth !== null && win.deep.growth > 0 ? '仍在涨。' : '体量最大且维护稳定。'}</p></div>`)

  if (alt && alt !== win) {
    html.push(`<div class="verdict alt"><h4>⚡ 备选 ${esc(alt.n)}</h4><p>` +
      `日常基线 <b>${num(alt.deep.base)}</b> 次/天，环比 <b>${pct(alt.deep.growth)}</b>，` +
      `最近更新 <b>${alt.deep.age} 天前</b>，健康度 <b>${alt.deep.s}</b>。` +
      (alt.deep.growth !== null && alt.deep.growth > (win.deep.growth || 0)
        ? '如果你更看重势头而不是体量，选它。'
        : '如果你更看重大家已经在用的稳定度，可以改选它。') + `</p></div>`)
  }

  if (no !== win && byScore.length >= 3) {
    const baseTxt = no.deep.base > 0
      ? `，日常基线 ${num(no.deep.base)} 次/天，只有首选的 ${Math.round(no.deep.base / Math.max(win.deep.base, 1) * 100)}%`
      : `，日常基线为 0 次/天`
    html.push(`<div class="verdict no"><h4>⚠️ 不推荐 ${esc(no.n)}</h4><p>` +
      `健康度 <b>${no.deep.s}</b>（本组最低）` +
      (no.deep.age > 90 ? `，<b>${no.deep.age} 天没发新版本</b>，可能已进入维护停滞。` : '') +
      baseTxt + `。</p></div>`)
  }

  $('#verdicts').innerHTML = html.join('')
  $('#secVerdict').classList.remove('hidden')
}

var byScore = []

/* ---------------- 排行榜 ---------------- */
function buildCategoryFilter() {
  const sel = $('#rankCat')
  const cats = [...new Set(Object.values(CAT.packages).map(p => p.cat))].filter(Boolean).sort()
  sel.innerHTML = '<option value="">全部分类</option>' + cats.map(c => `<option>${esc(c)}</option>`).join('')
}

/** 距今几天（ISO 日期）；没有日期返回 null */
function daysSince(iso) {
  if (!iso) return null
  return Math.max(0, Math.floor((Date.now() - Date.parse(iso + 'T00:00:00Z')) / 86400000))
}

/** 1234 → 1.2k：星标、Fork 这种数放在窄列里 */
const short = n => (n == null ? '—' : n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n))

function rankBoard() {
  return document.querySelector('#rankBoard button.on').dataset.b
}

/* ---------- 排行榜统一出表 ---------- */
// 每个榜都先排出完整名次，只画前 RANK_LIMIT 名，下面「显示更多」再加一页
const RANK_STEP = 50
let RANK_LIMIT = RANK_STEP
let RANK_SIG = ''

/** 换了榜单、角度或分类：回到第一页 */
function rankSig(sig) {
  if (sig !== RANK_SIG) { RANK_SIG = sig; RANK_LIMIT = RANK_STEP }
}

/** 名字：npm 包名，或 gh:owner/repo 的仓库名 */
function watchName(k) {
  return k.startsWith('gh:') ? k.slice(3).split('/').pop() : k
}

/** 不在这个榜的通用原因：目录里没有、分类对不上 */
function missCommon(k, cat) {
  const rec = CAT.packages[k]
  if (!k.startsWith('gh:') && !rec) return '插件目录里没有它（还没被收录，或不是 DSH 插件）'
  if (cat && rec && rec.cat !== cat) return `它的分类是「${rec.cat || '未分类'}」，不在「${cat}」里`
  return ''
}

/**
 * all：这个榜（当前角度、分类下）的完整排名；row(x, i, on) 画一行，i 是在完整排名里的下标。
 * keysOf(x)：这一行对应的监控名（GitHub 榜一行代表一个仓库，可能对应好几个插件）。
 * 我的监控里的插件：在画出来的前几名里就高亮；不在就追加到最下面，标出它在完整排名里的名次；
 * 完整排名里也没有的，写明为什么不在这个榜
 */
function paintRank({ all, row, keysOf, cols, empty, miss }) {
  const watched = watch()
  const wset = new Set(watched)
  const shown = all.slice(0, RANK_LIMIT)
  const isOn = x => keysOf(x).some(k => wset.has(k))
  let html = all.length ? shown.map((x, i) => row(x, i, isOn(x))).join('') : `<tr><td colspan="${cols}" class="empty">${empty}</td></tr>`
  if (all.length > shown.length) {
    html += `<tr class="more"><td colspan="${cols}"><button class="btn ghost" data-rank-more>显示更多 · 还有 ${num(all.length - shown.length)} 个（共 ${num(all.length)}）</button></td></tr>`
  }
  const shownKeys = new Set(shown.flatMap(keysOf))
  const extra = watched.filter(k => !shownKeys.has(k))
  if (extra.length) {
    const seen = new Set()
    const found = extra.map(k => ({ k, i: all.findIndex(x => keysOf(x).includes(k)) }))
      .filter(({ i }) => i < 0 || (!seen.has(i) && seen.add(i)))
      .sort((a, b) => (a.i < 0) - (b.i < 0) || a.i - b.i)
    html += `<tr class="wsep"><td colspan="${cols}">我的监控 · 不在上面前 ${num(shown.length)} 名里的，排在这里</td></tr>`
    html += found.map(({ k, i }) => (i >= 0 ? row(all[i], i, true)
      : `<tr class="watched miss"><td class="rk">—</td><td class="nm" colspan="${cols - 2}">${esc(watchName(k))}` +
        `<div class="sub">不在这个榜：${esc(miss(k) || '这个榜没收录它')}</div></td><td class="lks">${watchBtn(k)}</td></tr>`)).join('')
  }
  $('#rankBody').innerHTML = html
}
const trOpen = on => `<tr${on ? ' class="watched"' : ''}>`
const rankCell = i => `<td class="rk">${i + 1}</td>`

/** 官方 / 社区 / 商店榜：数据来自别人维护的目录 */
function renderOuterBoard(board) {
  const data = CAT.boards && CAT.boards[board]
  const CAPS = {
    official: '来自 DeepSeek 官方包 dsh-official-bundles：官方提供的可选、按需插件。按周下载排，数字含 DSH 安装时的自动拉取，不等于主动选择的人数。',
    community: `来自社区目录 awesome-dsh-plugin${data ? `（共 ${num(data.total)} 个${data.updated ? `，${esc(data.updated)} 更新` : ''}）` : ''}，不是 DeepSeek 官方。下载是近 30 天。`,
    shop: `来自第三方插件商店 dsh-plugin-shop${data ? `（共 ${num(data.total)} 个）` : ''}，不是 DeepSeek 官方，商店不提供下载量。`,
  }
  $('#rankCap').textContent = CAPS[board]
  const empty = text => {
    $('#rankHead').innerHTML = ''
    $('#rankBody').innerHTML = `<tr><td class="empty">${text}</td></tr>`
  }
  if (!data || !data.rows.length) return empty('还没有这个榜单的数据（每日更新取到后就有）。')

  const nameCell = r => `<td class="nm">${esc(r.t || r.n || r.name)}${r.v ? ` <span style="color:var(--t3);font-weight:400;font-size:11px">v${esc(r.v)}</span>` : ''}` +
    (r.t ? `<div class="sub">${esc(r.n)}</div>` : '') +
    (!r.n ? '<div class="sub">只在 GitHub，没发到 npm</div>' : '') +
    (isOurs((r.n && CAT.packages[r.n]) || r) ? `<div>${oursTag((r.n && CAT.packages[r.n]) || r, { short: true })}</div>` : '') +
    (r.d ? `<div class="sub desc" title="${esc(r.d)}">${esc(r.d)}</div>` : '') + `</td>`
  const actions = r => `<td class="lks">${watchBtn(watchKey(r))}${linkBtns({ n: r.n || '', ghUrl: r.repo || '' }, { icon: true })}</td>`
  const marketName = { official: 'DeepSeek 官方', community: '社区目录', shop: '这个商店' }[board]
  const keysOf = r => [watchKey(r)].filter(Boolean)
  // 社区目录、商店的榜只存了头部（比如社区一万多个只存前两百多）：没存下来不等于没收录，
  // 综合榜那边记着每个插件被哪些市场收录了（rec.src），用它分辨
  const srcKey = { official: 'official', community: 'dshmarket', shop: 'shop' }[board]
  const miss = k => {
    const rec = CAT.packages[k]
    if (rec && (rec.src || []).includes(srcKey)) return `${marketName}收录了它，但这个榜只存了前 ${num(data.rows.length)} 个（共 ${num(data.total || data.rows.length)}），它排在后面，具体名次没存`
    return `${marketName}没收录它`
  }

  if (board === 'official') {
    rankSig(board)
    const rows = data.rows.slice().sort((x, y) => (y.w || 0) - (x.w || 0))
    $('#rankHead').innerHTML = '<tr><th style="width:44px">#</th><th>插件</th><th class="r">周下载</th><th></th></tr>'
    paintRank({ all: rows, keysOf, cols: 4, empty: '', miss, row: (r, i, on) => `${trOpen(on)}${rankCell(i)}${nameCell(r)}<td class="r"><b>${num(r.w)}</b></td>${actions(r)}</tr>` })
    return
  }

  const metric = document.querySelector(`#rankFilters .chip.on[data-board="${board}"]`).dataset.m
  rankSig(board + '|' + metric)
  let rows = data.rows.filter(r => r[metric] != null)
    .sort((x, y) => (y[metric] > x[metric] ? 1 : y[metric] < x[metric] ? -1 : 0))
  // 按星标排时一个仓库只留一行（优先留发到 npm 的那条），不然同仓库的条目数字一样、刷屏
  if (metric === 's') {
    const best = new Map()
    for (const r of rows) {
      const k = (r.repo || r.name).toLowerCase()
      if (!best.has(k) || (!best.get(k).n && r.n)) best.set(k, r)
    }
    const keep = new Set(best.values())
    rows = rows.filter(r => keep.has(r))
  }
  const hasDl = board === 'community'
  $('#rankHead').innerHTML = '<tr><th style="width:44px">#</th><th>插件</th><th class="r">★ 星标</th>' +
    (hasDl ? '<th class="r" title="近 30 天">下载</th>' : '') + '<th class="r">收录</th><th></th></tr>'
  const strong = (on, t) => (on ? `<b>${t}</b>` : t)
  const metricName = { s: '星标', dl: '下载量', added: '收录日期' }[metric]
  const inBoard = new Set(data.rows.flatMap(keysOf))
  paintRank({
    all: rows, keysOf, cols: hasDl ? 6 : 5, empty: '这个榜还没有数据。',
    miss: k => (inBoard.has(k) ? `${marketName}收录了它，但它${metric === 's' ? '和同仓库的另一个条目只列一行，或' : ''}没有${metricName}数据` : miss(k)),
    row: (r, i, on) => `${trOpen(on)}${rankCell(i)}${nameCell(r)}` +
      `<td class="r">${strong(metric === 's', num(r.s))}</td>` +
      (hasDl ? `<td class="r">${strong(metric === 'dl', num(r.dl))}</td>` : '') +
      `<td class="r">${strong(metric === 'added', r.added ? esc(r.added.slice(5)) : '—')}</td>${actions(r)}</tr>`,
  })
}

/** 「收录于」的市场名 */
const MARKET_LABEL = { dshmarket: 'dshmarket', 'dsh-m': 'dsh-m 精选', shop: 'dsh-plugin-shop 商店', official: 'DeepSeek 官方' }
// 排行榜那种窄列里用短名（悬停看全名）
const MARKET_SHORT = { dshmarket: 'dshm', 'dsh-m': '精选', shop: '商店', official: '官方' }
function srcChips(src, { short = false } = {}) {
  return (src || []).map(k => {
    const full = MARKET_LABEL[k] || k
    return `<span class="srcchip${k === 'official' ? ' off' : ''}" title="收录于 ${esc(full)}">${esc(short ? MARKET_SHORT[k] || k : full)}</span>`
  }).join('')
}

/**
 * dsh-pick 作者自己的插件（GitHub 账号 AIcivilization 下的）：照常按同一套算法排，
 * 不加分、不置顶，只标明身份——用户该知道这是「裁判自己的队员」
 */
const AUTHOR_RE = /(^|github\.com\/|^gh:)aicivilization\//i
function isOurs(x) {
  if (!x) return false
  return [x.repo, x.ghUrl, x.gh && x.gh.repo, x.k].some(u => u && AUTHOR_RE.test(String(u)))
}
const OURS_TITLE = 'dsh-pick 作者自己做的插件。排名和其他插件用同一套算法，没有加分'
const oursTag = (x, { short = false } = {}) =>
  isOurs(x) ? `<span class="srcchip ours" title="${OURS_TITLE}">${short ? 'dsh-pick 作者' : 'dsh-pick 作者的作品'}</span>` : ''

/**
 * 综合榜：几个插件市场合成一个榜（每日构建时算好，见 lib/overall.js），一个插件一行。
 * npm 上的插件能直接装；只在 GitHub 上的先只展示
 */
// 综合榜的六个角度：同一份数据，权重不同（算法见 lib/overall.js），每个角度的说明写在页面上
const ANGLE_INFO = {
  rec: { label: '综合', cap: W => `综合推荐 = 使用 ${W.use}%（日常基线，没有的按周下载折算）+ 关注 ${W.stars}%（GitHub 星标）+ 维护 ${W.maint}%（60 天内有发版或提交就满分）+ 精选 ${W.curated}%（dsh-m 精选、DeepSeek 官方）+ 稳定 ${W.stable}% + 覆盖 ${W.reach}%（被几个市场收录）。鼠标停在分数上看明细。` },
  use: { label: '使用', cap: () => '最多人用：只看去噪后的日常基线（扣掉发版拉取的虚高，最接近真实使用量）。没有去噪数据的插件不参与。' },
  rep: { label: '口碑', cap: () => '口碑：GitHub 星标 65% + 被 dsh-m 精选或 DeepSeek 官方收录 35%。注意：有些插件的仓库是它所属的大项目，星标属于整个项目。' },
  stable: { label: '稳定', cap: () => '稳定可靠：上架满 60 天、还在维护；看版本节奏是否平稳（发得太勤扣分）、有没有许可证、未关闭的问题多不多，再加一点使用量。' },
  rise: { label: '增速', cap: () => '上升最快：日常基线每天至少 20 次的插件里，按近 7 日环比增速排。小插件的增速容易大起大落，参考看。' },
  new: { label: '收录', cap: () => '新上架：最近 30 天才被插件市场收录的，越新越靠前，同一天的按使用量排。' },
}

const OV_ANGLES = ['rec', 'use', 'rep', 'stable', 'rise', 'new']
// 在综合榜里、但这个角度不参与的原因（规则见 lib/overall.js）
const OV_MISS = {
  use: '没有去噪后的日常基线（下载太少，没进深挖），不参与「使用」',
  rep: '没有 GitHub 星标，也没被精选或官方收录，不参与「口碑」',
  stable: '上架不满 60 天，或很久没维护，不参与「稳定」',
  rise: '日常基线不到每天 20 次，不参与「增速」',
  new: '被收录超过 30 天，不算新上架',
}
let hasOA = false

/**
 * 综合榜参与排名的全部插件：每日目录只把每个角度的头部存成完整的行，
 * 其余 npm 插件的六个角度分数存在各自的记录上（rec.oa），这里补成行，分类筛选、算名次都在全部插件里排。
 * 旧目录没有 rec.oa，就只有存下来的那些
 */
function overallPool(data) {
  const angles = data.angles || OV_ANGLES
  const seen = new Set(data.rows.map(r => r.k))
  const pool = data.rows.slice()
  hasOA = false
  for (const rec of Object.values(CAT.packages)) {
    if (!rec.oa) continue
    hasOA = true
    if (seen.has(rec.n)) continue
    const d = rec.deep
    const a = Object.fromEntries(angles.map((k, i) => [k, rec.oa[i] ?? null]))
    const row = { k: rec.n, n: rec.n, sc: a.rec, a, src: rec.src || [] }
    if (rec.ad) row.added = rec.ad
    if (rec.gh && rec.gh.s != null) row.s = rec.gh.s
    if (d && Number.isFinite(d.growth)) row.g = Math.round(d.growth * 100) / 100
    const last = (d && d.lastRelease) || (rec.t ? String(rec.t).slice(0, 10) : '')
    if (last) row.last = last
    pool.push(row)
  }
  return pool
}

/**
 * 综合榜：几个插件市场合成一个榜（每日构建时算好，见 lib/overall.js），一个插件一行。
 * 顶部选角度；npm 上的插件能直接装，只在 GitHub 上的先只展示
 */
function renderOverall() {
  const data = CAT.boards && CAT.boards.overall
  const onChip = document.querySelector('#rankFilters .chip.on[data-board="overall"]')
  // 旧数据（每日目录还没用新代码构建）没有分角度的分数：只能看综合
  const hasAngles = Boolean(data && data.rows.length && data.rows[0].a)
  const angle = hasAngles && onChip ? onChip.dataset.m : 'rec'
  document.querySelectorAll('#rankFilters .chip[data-board="overall"]').forEach(c => c.classList.toggle('hidden', !hasAngles))
  const W = (data && data.weights) || {}
  const info = ANGLE_INFO[angle]
  $('#rankCap').textContent = `把 dshmarket、dsh-m 精选、dsh-plugin-shop 商店、DeepSeek 官方几个市场合成一个榜，一个插件只出现一次。` +
    `${info.cap(W)}仓库已归档、DSH 装不了的不进榜。${data ? `共 ${num(data.total)} 个插件参与排名。` : ''}`
  if (!data || !data.rows.length) {
    $('#rankHead').innerHTML = ''
    $('#rankBody').innerHTML = '<tr><td class="empty">还没有综合榜的数据（每日更新取到后就有）。</td></tr>'
    return
  }
  const cat = $('#rankCat').value
  rankSig(`overall|${angle}|${cat}`)
  const valueOf = r => (hasAngles ? r.a[angle] : r.sc)
  const pool = overallPool(data)
  const rows = pool
    .filter(r => valueOf(r) != null)
    .map(r => ({ r, rec: r.n ? CAT.packages[r.n] : null }))
    .filter(({ rec }) => !cat || (rec && rec.cat === cat))
  rows.sort((x, y) => angle === 'new'
    ? String(y.r.added || '').localeCompare(String(x.r.added || '')) || valueOf(y.r) - valueOf(x.r)
    : valueOf(y.r) - valueOf(x.r) || (y.rec ? y.rec.w || 0 : 0) - (x.rec ? x.rec.w || 0 : 0))
  const inPool = new Map(pool.map(r => [r.k, r]))
  // 固定列宽（table.ov）：数字列和操作列宽度固定，插件名占剩下的；不然简介把名字一列撑得很宽，
  // 右边固定的操作列正好盖住数字
  $('#rankHead').innerHTML = '<tr><th style="width:34px">#</th><th>插件</th>' +
    `<th class="r" style="width:38px" title="这个角度的分数 0~100">${info.label}</th><th class="r" style="width:44px">周下载</th>` +
    '<th class="r" style="width:38px" title="GitHub 星标">★</th><th class="r" style="width:46px" title="最近一次发版或提交">最近</th>' +
    '<th style="width:112px"></th></tr>'
  const miss = k => {
    const common = missCommon(k, cat)
    if (common) return common
    const r = inPool.get(k)
    if (r) return OV_MISS[angle] || '这个角度不参与'
    if (k.startsWith('gh:')) return '只在 GitHub 上、排名靠后的插件综合榜没有存'
    return CAT.packages[k].oa ? '' : hasOA ? '没进综合榜：仓库已归档、没声明 dsh.bundle，或是终端版插件' : '不在综合榜存下来的前列里（每日目录更新后能看到完整名次）'
  }
  paintRank({ all: rows, cols: 7, keysOf: ({ r }) => [r.k], miss, empty: '这个角度下没有插件（或这个分类里没有）。', row: ({ r, rec }, i, on) => {
    const name = r.n || r.name
    const v = rec ? rec.v : r.v
    const w = rec ? rec.w : r.w
    const desc = rec ? rec.d : r.d
    const P = r.p || []
    const why = r.p && r.p.length >= 6
      ? `综合推荐 ${r.sc}：使用 ${P[0]} · 关注 ${P[1]} · 维护 ${P[2]} · 精选 ${P[3]} · 稳定 ${P[4]} · 覆盖 ${P[5]}（各项 0~100）`
      : `综合分 ${r.sc}`
    const cell = angle === 'rise' && r.g != null ? `<span class="sc" title="近 7 日环比 ${pct(r.g)}；${why}">${pct(r.g)}</span>`
      : angle === 'new' && r.added ? `<span class="sc" title="${esc(r.added)} 被市场收录；${why}" style="font-size:11px">${esc(r.added.slice(5))}</span>`
        : `<span class="sc" title="${why}">${valueOf(r)}</span>`
    const age = daysSince(r.last)
    // 能装的：目录里的 npm 包按装前检查给按钮；官方插件不在目录里，名字核对过，也能装
    const inst = r.n ? installArea(rec || { n: r.n }, { icon: true }) : ''
    const links = linkBtns(rec || { n: r.n || '', ghUrl: r.repo || '' }, { icon: true })
    return `${trOpen(on)}${rankCell(i)}` +
      `<td class="nm"><div class="nmline" title="${esc(name)}${v ? ' v' + esc(v) : ''}">${esc(name)}${v ? ` <span style="color:var(--t3);font-weight:400;font-size:11px">v${esc(v)}</span>` : ''}</div>` +
        `<div class="chips">${srcChips(r.src, { short: true })}${r.n ? '' : '<span class="srcchip gh" title="只在 GitHub，没发到 npm">GitHub</span>'}${oursTag(rec || r, { short: true })}</div>` +
        (desc ? `<div class="sub desc" title="${esc(desc)}">${esc(desc)}</div>` : '') + `</td>` +
      `<td class="r">${cell}</td>` +
      `<td class="r">${w != null ? short(w) : '—'}</td>` +
      `<td class="r">${r.s != null ? short(r.s) : '—'}</td>` +
      `<td class="r" title="${esc(r.last || '')}"><span${age != null && age > 90 ? ' class="stale"' : ''}>${age != null ? ageText(age) : '—'}</span></td>` +
      `<td class="lks">${watchBtn(r.k)}${inst}${links}</td></tr>`
  } })
}

function renderRank() {
  const board = rankBoard()
  document.querySelector('table.rank').classList.toggle('ov', board === 'overall')
  if (board === 'overall') {
    $('#rankCat').classList.remove('hidden')
    // 角度选单只在综合榜显示（data-board="overall" 的 chip 由切换榜单的逻辑统一显示 / 隐藏）
    renderOverall()
    return
  }
  const onChip = document.querySelector(`#rankFilters .chip.on[data-board="${board}"]`)
  const metric = onChip ? onChip.dataset.m : ''
  const cat = $('#rankCat').value
  const inCat = r => !cat || r.cat === cat
  const nameCell = r => `<td class="nm">${esc(r.n)} <span style="color:var(--t3);font-weight:400;font-size:11px">v${esc(r.v)}</span>${isOurs(r) ? `<div>${oursTag(r, { short: true })}</div>` : ''}</td>`
  const b = (on, text) => (on ? `<b>${text}</b>` : text)
  // 分类是 npm 目录自己算的，别的榜没有这个字段
  $('#rankCat').classList.toggle('hidden', board !== 'npm' && board !== 'gh')

  if (board === 'official' || board === 'community' || board === 'shop') {
    renderOuterBoard(board)
    return
  }

  rankSig(`${board}|${metric}|${cat}`)
  if (board === 'gh') {
    $('#rankCap').textContent = '按 GitHub 仓库数据：星标看关注度，最近提交看还有没有人在维护。一个仓库只列一行；仓库填成 DSH 本体的不算。'
    const val = r => metric === 'gs' ? r.gh.s
      : metric === 'gf' ? r.gh.f
      : metric === 'gi' ? r.gh.i
      : -(daysSince(r.gh.p) ?? 1e9) // 最近提交：越近越前
    // 按仓库排：一个仓库只占一行（好些作者把一串插件放在一个仓库里，数据都一样），
    // 用这个仓库里周下载最多的那个插件代表，注明共用的个数
    const byRepo = new Map()
    for (const r of Object.values(CAT.packages)) {
      if (!r.gh || !inCat(r)) continue
      const k = r.gh.repo.toLowerCase()
      const cur = byRepo.get(k)
      if (!cur) byRepo.set(k, { r, n: 1 })
      else { cur.n++; if (r.w > cur.r.w) cur.r = r }
    }
    const shared = new Map([...byRepo.values()].map(x => [x.r.n, x.n]))
    // 一行代表一个仓库：这个仓库里的插件都算这一行（监控了其中任何一个，都高亮这一行）
    const repoKeys = new Map()
    for (const r of Object.values(CAT.packages)) {
      if (!r.gh) continue
      const k = r.gh.repo.toLowerCase()
      if (!repoKeys.has(k)) repoKeys.set(k, [])
      repoKeys.get(k).push(r.n)
    }
    const rows = [...byRepo.values()].map(x => x.r).sort((x, y) => val(y) - val(x))
    $('#rankHead').innerHTML = '<tr><th style="width:44px">#</th><th>插件</th><th>分类</th>' +
      '<th class="r">★ 星标</th><th class="r">Fork</th><th class="r" title="未关闭的 issue 与 PR">讨论</th>' +
      '<th class="r" title="仓库最近一次提交">最近提交</th><th></th></tr>'
    paintRank({
      all: rows, cols: 8, empty: '目录里还没有 GitHub 数据（每日更新取到后就有）。',
      keysOf: r => repoKeys.get(r.gh.repo.toLowerCase()) || [r.n],
      miss: k => missCommon(k, cat) || '目录里没有它的 GitHub 仓库数据（没填仓库地址，或仓库填成了 DSH 本体）',
      row: (r, i, on) => {
      const age = daysSince(r.gh.p)
      return trOpen(on) + rankCell(i) +
        `<td class="nm">${esc(r.n)} <span style="color:var(--t3);font-weight:400;font-size:11px">v${esc(r.v)}</span>` +
          (isOurs(r) ? `<div>${oursTag(r, { short: true })}</div>` : '') +
          (shared.get(r.n) > 1 ? `<div class="sub" title="仓库 ${esc(r.gh.repo)} 里有 ${shared.get(r.n)} 个插件，数据相同，只列一行">等 ${shared.get(r.n)} 个插件共用这个仓库</div>` : '') +
        `</td>` +
        `<td><span class="catpill">${esc(r.cat)}</span></td>` +
        `<td class="r">${b(metric === 'gs', num(r.gh.s))}</td>` +
        `<td class="r">${b(metric === 'gf', num(r.gh.f))}</td>` +
        `<td class="r">${b(metric === 'gi', num(r.gh.i))}</td>` +
        `<td class="r" title="${esc(r.gh.p || '')}">${r.gh.a ? '<span class="arch">已归档</span>' : `<span${age != null && age > 90 ? ' class="stale"' : ''}>${b(metric === 'gp', ageText(age))}</span>`}</td>` +
        `<td class="lks">${watchBtn(r.n)}${linkBtns(r, { icon: true })}</td>` +
        `</tr>`
    } })
    return
  }

  $('#rankCap').textContent = '按 npm 下载数据：日常基线已扣掉发版拉取的虚高，最接近真实使用量；周下载含 CI、镜像流量。'
  const onlyDeep = metric !== 'w'
  const val = r => metric === 'base' ? r.deep.base
    : metric === 'growth' ? (r.deep.growth === null ? -Infinity : r.deep.growth)
    : metric === 's' ? r.deep.s
    : r.w
  const rows = Object.values(CAT.packages).filter(r => inCat(r) && (!onlyDeep || r.deep)).sort((x, y) => val(y) - val(x))
  $('#rankHead').innerHTML = '<tr><th style="width:44px">#</th><th>插件</th><th>分类</th>' +
    `<th class="r">基线</th><th class="r">周下载</th><th class="r">环比</th>${metric === 's' ? '<th class="r">健康度</th>' : ''}` +
    '<th class="r" title="最近一次发版 · 平均几天发一个版本">更新</th><th></th></tr>'
  paintRank({
    all: rows, cols: metric === 's' ? 9 : 8, empty: '这个分类里没有插件。', keysOf: r => [r.n],
    miss: k => missCommon(k, cat) || (k.startsWith('gh:') ? '只在 GitHub 上，没发到 npm' : '没有去噪数据（下载太少，没进深挖），这一项排不了；切到「周下载」能看到它的名次'),
    row: (r, i, on) => {
    const d = r.deep
    const g = d ? d.growth : null
    return trOpen(on) + rankCell(i) + nameCell(r) +
      `<td><span class="catpill">${esc(r.cat)}</span></td>` +
      `<td class="r">${b(metric === 'base', d ? num(d.base) : '—')}</td>` +
      `<td class="r">${b(metric === 'w', num(r.w))}</td>` +
      `<td class="r ${g === null ? '' : (g >= 0 ? 'up' : 'down')}">${metric === 'growth' ? `<b>${pct(g)}</b>` : pct(g)}</td>` +
      (metric === 's' ? `<td class="r"><b>${d ? d.s : '—'}</b></td>` : '') +
      maintCell(d) +
      `<td class="lks">${watchBtn(r.n)}${linkBtns(r, { icon: true })}</td>` +
      `</tr>`
  } })
}

/* ---------------- 我的监控 ---------------- */
function watch() {
  try { return JSON.parse(localStorage.getItem(WATCH_KEY)) || [] } catch { return [] }
}
function saveWatch(list) { localStorage.setItem(WATCH_KEY, JSON.stringify(list)) }

/** 监控列表里的名字：npm 包名；只在 GitHub 上的插件记成 gh:owner/repo */
function watchKey(r) {
  if (r.n) return r.n
  const m = /github\.com\/([^/]+\/[^/#]+)/.exec(r.repo || '')
  return m ? 'gh:' + m[1] : ''
}

/** 彩色 + 号（已监控显示 ✓）：点击由 document 上的委托统一处理 */
function watchBtn(key) {
  if (!key) return ''
  const on = watch().includes(key)
  return `<button class="wadd${on ? ' on' : ''}" data-watch="${esc(key)}" title="${on ? '已在我的监控里，点一下移除' : '加入我的监控'}" aria-label="${on ? '移出我的监控' : '加入我的监控'}">${on ? '✓' : '+'}</button>`
}

function toggleWatch(key) {
  const list = watch()
  const on = list.includes(key)
  if (!on && list.length >= 30) { toast('我的监控最多 30 个，先移除几个再加'); return }
  saveWatch(on ? list.filter(x => x !== key) : [...list, key])
  const now = !on
  const shown = key.startsWith('gh:') ? key.slice(3) : key
  toast(now ? `已加入我的监控：${shown}` : `已移出我的监控：${shown}`)
  renderWatch()
  // 同一个插件可能同时出现在搜索结果和排行榜里，一起更新
  document.querySelectorAll('[data-watch]').forEach(b => {
    if (b.dataset.watch !== key) return
    b.classList.toggle('on', now)
    b.textContent = now ? '✓' : '+'
    b.title = now ? '已在我的监控里，点一下移除' : '加入我的监控'
    b.setAttribute('aria-label', now ? '移出我的监控' : '加入我的监控')
    // 排行榜里这一行跟着高亮（不重画整张表，免得滚动位置跳走）
    const tr = b.closest('table.rank tr')
    if (tr) tr.classList.toggle('watched', now)
  })
}

function addPickedToWatch() {
  const list = watch()
  for (const n of picked) if (!list.includes(n)) list.push(n)
  saveWatch(list.slice(0, 30))
  renderWatch()
  alert('已加入我的监控（' + picked.join('、') + '）')
}

/* 刷新：去 npm 实时查监控列表里的包。结果存本地，下次打开还看得到上次刷新的数 */
const LIVE_KEY = 'dsh-pick-watch-live-v1'
let LIVE = (() => {
  try { return JSON.parse(localStorage.getItem(LIVE_KEY)) || { at: null, rows: {} } } catch { return { at: null, rows: {} } }
})()

/**
 * 监控卡片用的数据：有实时数据就用实时的（字段换成目录的短名，后面的代码不用分两套），
 * 否则用目录里的。目录里没有、也没刷新过的返回 null
 */
function watchRec(n) {
  // 只在 GitHub 上的插件（gh:owner/repo）：从榜单里找它的信息，有实时数据就用实时的
  if (n.startsWith('gh:')) {
    const repo = n.slice(3)
    const url = 'https://github.com/' + repo
    const inBoard = ['community', 'shop'].flatMap(k => (CAT.boards && CAT.boards[k] && CAT.boards[k].rows) || [])
      .find(r => r.repo && r.repo.toLowerCase() === url.toLowerCase())
    const live = LIVE.rows[n]
    const gh = live && live.found ? live.gh : (inBoard && inBoard.s != null ? { repo, s: inBoard.s, f: null, i: null, p: null, a: false } : null)
    return { n: '', label: repo, cat: '只在 GitHub', w: null, m: null, deep: null, ghUrl: url, gh, live: Boolean(live && live.found) }
  }
  return mergeLive(CAT.packages[n], LIVE.rows[n], n)
}

/**
 * 目录记录 + 实时查到的数据（/live 的一行）→ 一条记录，字段用目录的短名，后面的代码不用分两套。
 * 实时的覆盖目录的；npm 下载接口偶尔限流查不到时，保留目录里的指标，别把有的数据冲掉
 */
function mergeLive(base, live, n) {
  if (!live || !live.found) return base || null
  const d = live.deep
  return {
    ...(base || { n, cat: '（目录外）' }),
    n,
    v: live.latest || (base && base.v),
    d: (base && base.d) || live.description || '',
    w: live.weekly,
    m: live.monthly,
    deep: d ? { base: d.baseline, growth: d.growth, cadence: d.cadence, age: d.ageDays, lastRelease: d.lastRelease, versions: d.versions, s: d.score } : (base && base.deep) || null,
    gh: live.gh || (base && base.gh) || null,
    total: live.total ?? null,
    daily: live.daily || null,
    dailyStart: live.dailyStart || null,
    live: true,
    catalogW: base ? base.w : null,
  }
}

/* ---------------- 比较里的插件：没有去噪数据的，实时算一份 ---------------- */
// 去噪指标每日构建时只给周下载前 300 多名算；自己加进比较的插件多半在这之外，就去 npm 当场算
const CMP_LIVE = new Map() // 包名 → /live 的一行
const CMP_PENDING = new Set()
function cmpRec(n) {
  return CMP_LIVE.has(n) ? mergeLive(CAT.packages[n], CMP_LIVE.get(n), n) : CAT.packages[n]
}
async function fillCompareLive() {
  const need = picked.filter(n => CAT.packages[n] && !CAT.packages[n].deep && !CMP_LIVE.has(n) && !CMP_PENDING.has(n))
  if (!need.length) return
  need.forEach(n => CMP_PENDING.add(n))
  renderCompare()
  try {
    const r = await fetch(`${P.live}?names=${encodeURIComponent(need.join(','))}`, { cache: 'no-store' })
    const j = await r.json()
    if (r.ok) for (const row of j.rows || []) if (row.found) CMP_LIVE.set(row.name, row)
  } catch { /* 查不到就按目录里的显示 */ }
  need.forEach(n => CMP_PENDING.delete(n))
  renderCompare()
}

/* ---------------- 监控详情：快照历史、走势图、各项数据 ---------------- */
// 每次刷新在本机存一份快照（每个插件最多 30 份），「较上次」就是和上一份比
const HIST_KEY = 'dsh-pick-watch-history-v1'
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY)) || {} } catch { return {} }
}
function saveSnapshots(at) {
  const hist = loadHistory()
  for (const n of watch()) {
    const r = watchRec(n)
    if (!r || !r.live) continue
    const snap = { t: at, v: r.v || null, w: r.w ?? null, base: r.deep ? r.deep.base : null, s: r.gh ? r.gh.s : null, rank: r.rank ?? null, sc: r.sc ?? null, orank: angleRank(n, 'rec') }
    const list = (hist[n] || []).filter(x => x.t !== at)
    list.push(snap)
    hist[n] = list.slice(-30)
  }
  try { localStorage.setItem(HIST_KEY, JSON.stringify(hist)) } catch { /* 存不下就不记 */ }
}
/**
 * 拿哪一份快照当「上次」：最新一份往前、至少早 12 小时的那份（连点两次刷新，比的不是几分钟前的）；
 * 没有那么早的，就用倒数第二份
 */
const BASE_GAP_MS = 12 * 3600 * 1000
function baseSnap(list) {
  if (list.length < 2) return null
  const cur = Date.parse(list[list.length - 1].t)
  for (let i = list.length - 2; i >= 0; i--) if (cur - Date.parse(list[i].t) >= BASE_GAP_MS) return list[i]
  return list[list.length - 2]
}
/** 和「上次」的快照比：返回「较上次」的小字 */
function changeOf(n, key, now, { lowerIsBetter = false, asPct = true } = {}) {
  const prev = baseSnap(loadHistory()[n] || [])
  if (!prev || prev[key] == null || now == null) return ''
  const diff = now - prev[key]
  const when = new Date(prev.t).toLocaleDateString()
  if (diff === 0) return `<span class="ch flat" title="和 ${esc(when)} 刷新时一样">较上次持平</span>`
  const good = lowerIsBetter ? diff < 0 : diff > 0
  // 排名数字越小越好：用「升 / 降 几名」说，正负号容易看反
  const txt = lowerIsBetter ? `${diff < 0 ? '升' : '降'} ${num(Math.abs(diff))} 名`
    : asPct && prev[key] ? `${diff > 0 ? '+' : ''}${Math.round(diff / prev[key] * 100)}%` : `${diff > 0 ? '+' : ''}${num(diff)}`
  return `<span class="ch ${good ? 'up' : 'down'}" title="和 ${esc(when)} 刷新时相比">较上次 ${txt}</span>`
}
/** 30 天每日下载的走势小图（缺数据的日子断开） */
function sparkSvg(daily, color) {
  if (!daily || !daily.some(v => v != null)) return ''
  const W = 120, H = 30
  const max = Math.max(1, ...daily.filter(v => v != null))
  const x = i => (i / (daily.length - 1)) * (W - 2) + 1
  const y = v => H - 2 - (v / max) * (H - 4)
  const segs = []
  let cur = []
  daily.forEach((v, i) => {
    if (v == null) { if (cur.length) segs.push(cur); cur = []; return }
    cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`)
  })
  if (cur.length) segs.push(cur)
  return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="30 天每日下载走势，最高 ${num(max)}">` +
    segs.map(p => (p.length === 1 ? `<circle cx="${p[0].split(',')[0]}" cy="${p[0].split(',')[1]}" r="1.5" fill="${color}"/>` : `<polyline points="${p.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>`)).join('') +
    '</svg>'
}
// 综合榜每个角度的完整名次（和排行榜同一套排法），算一次存着，监控详情重画时清掉
let ANGLE_ORDER = new Map()
function angleRank(key, angle) {
  const o = CAT.boards && CAT.boards.overall
  if (!o || !o.rows.length || !o.rows[0].a) return null
  if (!ANGLE_ORDER.has(angle)) {
    const w = r => (r.n && CAT.packages[r.n] ? CAT.packages[r.n].w || 0 : 0)
    const rows = overallPool(o).filter(r => r.a[angle] != null)
      .sort((x, y) => angle === 'new' ? String(y.added || '').localeCompare(String(x.added || '')) || y.a.new - x.a.new : y.a[angle] - x.a[angle] || w(y) - w(x))
    ANGLE_ORDER.set(angle, new Map(rows.map((r, i) => [r.k, i + 1])))
  }
  return ANGLE_ORDER.get(angle).get(key) || null
}

/* ---------- 我的产品：在我的监控里标成自家的，排名时和对手比 ---------- */
const MINE_KEY = 'dsh-pick-mine-v1'
function mine() {
  try { return JSON.parse(localStorage.getItem(MINE_KEY)) || [] } catch { return [] }
}
function toggleMine(n) {
  const list = mine()
  const on = !list.includes(n)
  try { localStorage.setItem(MINE_KEY, JSON.stringify(on ? [...list, n] : list.filter(x => x !== n))) } catch { /* 存不下就只这次有效 */ }
  toast(on ? `已标成我的产品：${watchName(n)}` : `取消了「我的产品」：${watchName(n)}`)
  renderWatch()
}
const starBtn = n => {
  const on = mine().includes(n)
  return `<button class="star${on ? ' on' : ''}" data-mine="${esc(n)}" title="${on ? '是我的产品，点一下取消' : '标成我的产品（排名时算出和对手的差距）'}" aria-label="${on ? '取消我的产品' : '标成我的产品'}">${on ? '★' : '☆'}</button>`
}

/*
 * 监控详情：
 *   顶部「这次的变化」（和上一次刷新比，只列明显的）
 *   选一个指标 → 每个插件一行横条，按名次排；我的产品标出第几、和第 1 名 / 下一名差多少
 *   宽屏：下面是完整表格（每个插件一列）；窄屏：点哪个插件，下面列出它的全部数据
 */
const WD_METRIC_KEY = 'dsh-pick-wd-metric-v1'
let WD_METRIC = (() => { try { return localStorage.getItem(WD_METRIC_KEY) || 'w' } catch { return 'w' } })()
let WD_SEL = null
let WD = null // { recs, rows }：这次画的数据，切指标、点插件时不用重算

// kind：count 数量（对数刻度、差距按比例说）· pct 百分比（差距按百分点）· rank 名次 · days 天数（都是越小越好）
const WD_METRICS = [
  { k: 'w', label: '周下载', get: r => r.w, fmt: num, snap: 'w' },
  { k: 'base', label: '日常基线', get: r => (r.deep ? r.deep.base : null), fmt: v => `${num(v)}/天`, snap: 'base' },
  { k: 'growth', label: '环比', get: r => (r.deep ? r.deep.growth : null), fmt: pct, kind: 'pct' },
  { k: 'm', label: '月下载', get: r => r.m, fmt: num },
  { k: 'tot', label: '累计下载', get: r => r.total, fmt: num },
  { k: 's', label: '星标', get: r => (r.gh ? r.gh.s : null), fmt: num, snap: 's', abs: true },
  { k: 'orank', label: '综合榜名次', get: (r, n) => angleRank(n, 'rec'), fmt: v => `#${num(v)}`, kind: 'rank', snap: 'orank' },
  { k: 'rank', label: 'npm 总榜', get: r => r.rank, fmt: v => `#${num(v)}`, kind: 'rank', snap: 'rank' },
  { k: 'age', label: '最近发版', get: r => releaseAge(r), fmt: ageText, kind: 'days' },
]
const lowerBetter = m => m.kind === 'rank' || m.kind === 'days'

/** 距离最近一次发版几天：有去噪数据用它的，没有用目录里最新版的发布时间 */
function releaseAge(r) {
  if (r.deep && r.deep.age != null) return r.deep.age
  return r.t ? daysSince(String(r.t).slice(0, 10)) : null
}

/** a 比 b：差多少（给「落后第 1 名 …」「领先下一名 …」用） */
function gapText(m, a, b) {
  const d = Math.abs(a - b)
  if (m.kind === 'rank') return `${num(d)} 名`
  if (m.kind === 'days') return `${num(d)} 天`
  if (m.kind === 'pct') return `${Math.round(d * 100)} 个百分点`
  if (!b) return num(d)
  const ratio = a / b
  if (ratio >= 2) return `是它的 ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)} 倍`
  return ratio >= 1 ? `多 ${Math.round((ratio - 1) * 100)}%` : `少 ${Math.round((1 - ratio) * 100)}%`
}

function renderWatchDetail(list) {
  const sec = $('#secWatchDetail')
  if (!list.length) { sec.classList.add('hidden'); WD = null; return }
  sec.classList.remove('hidden')
  ANGLE_ORDER = new Map()
  $('#wdAsOf').textContent = LIVE.at ? `· ${new Date(LIVE.at).toLocaleString()} 刷新` : '· 还没刷新过，先显示目录数据'
  const recs = list.map(n => ({ n, r: watchRec(n) }))
  const ANG = { rec: '综合', use: '使用', rep: '口碑', stable: '稳定', rise: '增速' }
  const cell = (r, fn) => (r ? fn(r) : '—')
  const rows = [
    ['下载'],
    ['30 天每日下载', ({ r }, i) => cell(r, x => (x.daily ? sparkSvg(x.daily, colorOf(i)) : '<span style="color:var(--t3)">刷新后显示</span>'))],
    ['周下载', ({ n, r }) => cell(r, x => (x.w != null ? `<b>${num(x.w)}</b>${changeOf(n, 'w', x.w)}` : '—'))],
    ['上周（前 7 天）', ({ r }) => cell(r, x => {
      const v = (x.daily || []).filter(d => d != null)
      return v.length >= 14 ? num(v.slice(-14, -7).reduce((a, b) => a + b, 0)) : '—'
    })],
    ['日常基线（去噪）', ({ n, r }) => cell(r, x => (x.deep ? `${num(x.deep.base)}/天${changeOf(n, 'base', x.deep.base)}` : '—'))],
    ['近 7 日环比', ({ r }) => cell(r, x => (x.deep && x.deep.growth != null ? `<span class="${x.deep.growth >= 0 ? 'up' : 'down'}">${pct(x.deep.growth)}</span>` : '—'))],
    ['月下载', ({ r }) => cell(r, x => (x.m != null ? num(x.m) : '—'))],
    ['累计下载', ({ r }) => cell(r, x => (x.total != null ? num(x.total) : '—'))],
    ['版本'],
    ['当前版本', ({ r }) => cell(r, x => (x.v ? `v${esc(x.v)}` : '—'))],
    ['最近发版', ({ r }) => cell(r, x => (x.deep && x.deep.lastRelease ? `${esc(x.deep.lastRelease)}<span class="ch flat">${ageText(x.deep.age)}</span>` : '—'))],
    ['版本总数', ({ r }) => cell(r, x => (x.deep && x.deep.versions != null ? num(x.deep.versions) : '—'))],
    ['发版节奏', ({ r }) => cell(r, x => (x.deep && x.deep.cadence != null ? `${x.deep.cadence} 天/版` : '—'))],
    ['健康度', ({ r }) => cell(r, x => (x.deep && x.deep.s != null ? x.deep.s : '—'))],
    ['GitHub'],
    ['星标', ({ n, r }) => cell(r, x => (x.gh ? `${num(x.gh.s)}${changeOf(n, 's', x.gh.s, { asPct: false })}` : '—'))],
    ['Fork', ({ r }) => cell(r, x => (x.gh && x.gh.f != null ? num(x.gh.f) : '—'))],
    ['未关闭 issue / PR', ({ r }) => cell(r, x => (x.gh && x.gh.i != null ? num(x.gh.i) : '—'))],
    ['最近提交', ({ r }) => cell(r, x => (x.gh && x.gh.p ? `${esc(x.gh.p)}${x.gh.a ? '<span class="ch down">已归档</span>' : ''}` : '—'))],
    ['市场位置'],
    ['npm 总榜', ({ n, r }) => cell(r, x => (x.rank ? `#${num(x.rank)}${changeOf(n, 'rank', x.rank, { lowerIsBetter: true, asPct: false })}` : '—'))],
    ['分类排名', ({ r }) => cell(r, x => (x.crank ? `${esc(x.cat)} #${num(x.crank)}` : '—'))],
    ['综合榜排名', ({ n, r }) => cell(r, () => {
      const parts = Object.entries(ANG).map(([a, label]) => [label, angleRank(n, a)]).filter(([, v]) => v)
      const ch = changeOf(n, 'orank', angleRank(n, 'rec'), { lowerIsBetter: true, asPct: false })
      return parts.length ? parts.map(([l, v]) => `${l} #${num(v)}`).join('<br>') + ch : '<span style="color:var(--t3)">没进综合榜</span>'
    })],
    ['综合推荐分', ({ n, r }) => cell(r, x => (x.sc != null ? `${x.sc}${changeOf(n, 'sc', x.sc, { asPct: false })}` : '—'))],
    ['收录于', ({ r }) => cell(r, x => (x.src && x.src.length ? srcChips(x.src, { short: true }) : '—'))],
  ]
  WD = { recs, rows }
  const mineNow = mine()
  if (!list.includes(WD_SEL)) WD_SEL = list.find(n => mineNow.includes(n)) || list[0]
  if (!WD_METRICS.some(m => m.k === WD_METRIC)) WD_METRIC = 'w'
  renderWdChanges(list)
  renderWdBadges(list)
  paintWd()
}

/* ---------- README 排名徽章：每日构建给每个插件写一个 shields.io endpoint 文件（lib/badges.js） ---------- */
const BADGE_BASE = 'https://raw.githubusercontent.com/AIcivilization/dsh-pick/catalog/badge/'
const BADGE_LINK = 'https://github.com/AIcivilization/dsh-pick'
const badgeImg = key => 'https://img.shields.io/endpoint?url=' + encodeURIComponent(BADGE_BASE + (key.startsWith('gh:') ? 'gh/' + key.slice(3) : key) + '.json')
const badgeMd = key => `[![dsh-pick](${badgeImg(key)})](${BADGE_LINK})`

/** 我的产品各给一个徽章和「复制」；还没标的，提示一句怎么拿 */
function renderWdBadges(list) {
  const box = $('#wdBadge')
  const keys = list.filter(n => mine().includes(n))
  box.innerHTML = keys.length
    ? '<div class="hd">README 排名徽章</div>' +
      keys.map(n => `<div class="bg"><span class="bn">${esc(watchName(n))}</span>` +
        `<img src="${esc(badgeImg(n))}" alt="dsh-pick 排名徽章" loading="lazy" referrerpolicy="no-referrer">` +
        `<button type="button" class="btn ghost sm" data-badge="${esc(n)}">复制 Markdown</button></div>`).join('') +
      '<p class="cap">贴进插件的 README，名次每天跟着目录自动更新；点徽章会打开 dsh-pick。</p>'
    : '<p class="cap">在上面给自家插件点 ☆ 标成「我的产品」，这里会给出贴进 README 的排名徽章。</p>'
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true } catch { /* iframe 里可能不让用，退回老办法 */ }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { /* 复制不了 */ }
  ta.remove()
  return ok
}

/** 选中的指标、选中的插件变了：重画横条、单个插件、表格（数据不重算） */
function paintWd() {
  if (!WD) return
  const { recs, rows } = WD
  const mineNow = mine()
  const nameOf = ({ n, r }) => (r && r.label) || watchName(n)
  const selIdx = recs.findIndex(x => x.n === WD_SEL)

  // 指标选单
  $('#wdMetrics').innerHTML = WD_METRICS.map(m => `<button data-wdm="${m.k}" class="${m.k === WD_METRIC ? 'on' : ''}" role="tab" aria-selected="${m.k === WD_METRIC}">${m.label}</button>`).join('')

  // 排名横条
  const m = WD_METRICS.find(x => x.k === WD_METRIC)
  const items = recs.map((x, i) => ({ ...x, i, v: x.r ? m.get(x.r, x.n) : null }))
  const has = items.filter(x => x.v != null && Number.isFinite(x.v))
    .sort((a, b) => (lowerBetter(m) ? a.v - b.v : b.v - a.v))
  const none = items.filter(x => !has.includes(x))
  // 横条长短：数量用对数（差几个数量级），名次、天数越小越长，百分比按原值；归一到 8%~100%
  const score = v => (m.kind === 'pct' ? v : lowerBetter(m) ? -Math.log1p(v) : Math.log1p(Math.max(v, 0)))
  const ss = has.map(x => score(x.v))
  const lo = Math.min(...ss), hi = Math.max(...ss)
  const len = v => (hi === lo ? 100 : 8 + (score(v) - lo) / (hi - lo) * 92)
  const row = (x, k) => {
    const isMine = mineNow.includes(x.n)
    // 横条里只标有变化的（「持平」每行都写太吵）
    const raw = m.snap ? changeOf(x.n, m.snap, x.v, { lowerIsBetter: lowerBetter(m), asPct: !(m.abs || m.kind === 'rank') }) : ''
    const ch = raw.includes('flat') ? '' : raw.replace('较上次 ', '')
    return `<div class="wb${x.n === WD_SEL ? ' sel' : ''}${isMine ? ' mine' : ''}${x.v == null ? ' none' : ''}" data-wd="${esc(x.n)}" role="button" tabindex="0" title="点一下看 ${esc(nameOf(x))} 的全部数据">` +
      `<div class="wbt"><span class="wbr">${k != null ? k + 1 : '—'}</span>` +
      `<span class="wbn"><i style="background:${colorOf(x.i)}"></i>${esc(nameOf(x))}${isMine ? '<span class="mtag">我的</span>' : ''}</span>` +
      `<span class="wbv">${x.v != null ? m.fmt(x.v) : '—'}${ch}</span></div>` +
      (x.v != null ? `<div class="wbb"><i style="width:${len(x.v).toFixed(1)}%;background:${colorOf(x.i)}"></i></div>` : '') + '</div>'
  }
  $('#wdBars').innerHTML = has.map((x, k) => row(x, k)).join('') + none.map(x => row(x, null)).join('')

  // 我的产品：第几、落后第 1 名多少、领先下一名多少
  const mineLines = has.map((x, k) => ({ x, k })).filter(({ x }) => mineNow.includes(x.n)).map(({ x, k }) => {
    const top = has[0]
    const next = has[k + 1]
    const parts = [`<b>★ ${esc(nameOf(x))}</b> ${m.label}排第 <b>${k + 1}</b> / ${has.length}`]
    if (k > 0) parts.push(`落后第 1 名 ${esc(nameOf(top))} ${gapText(m, x.v, top.v)}`)
    else if (has.length > 1) parts.push('在你监控的插件里最好')
    if (next) parts.push(`领先下一名 ${esc(nameOf(next))} ${gapText(m, x.v, next.v)}`)
    return `<div>${parts.join('；')}</div>`
  })
  $('#wdMine').innerHTML = mineLines.join('')
  $('#wdMine').classList.toggle('hidden', !mineLines.length)

  // 宽屏的表格：每个插件一列，选中的那列高亮
  const sel = i => (i === selIdx ? ' class="sel"' : '')
  $('#wdHead').innerHTML = '<tr><th>指标</th>' + recs.map((x, i) =>
    `<th${sel(i)}>${starBtn(x.n)}<i style="background:${colorOf(i)}"></i>${esc(nameOf(x))}</th>`).join('') + '</tr>'
  $('#wdBody').innerHTML = rows.map(([label, fn]) => (fn
    ? `<tr><td>${label}</td>${recs.map((x, i) => `<td${sel(i)}>${fn(x, i)}</td>`).join('')}</tr>`
    : `<tr class="grp"><td colspan="${recs.length + 1}">${label}</td></tr>`)).join('')

  // 窄屏：选中的那个插件的全部数据
  if (selIdx >= 0) {
    const x = recs[selIdx]
    $('#wdOne').innerHTML = `<div class="hd">${starBtn(x.n)}<i style="background:${colorOf(selIdx)}"></i>${esc(nameOf(x))}` +
      `<span style="color:var(--t3);font-size:11px;font-weight:500;margin-left:auto">点上面的插件换一个看</span></div>` +
      rows.map(([label, fn]) => (fn ? `<div class="kv"><span class="k">${label}</span><span class="v">${fn(x, selIdx)}</span></div>` : `<div class="grp">${label}</div>`)).join('')
  }
  WD_COUNT = recs.length
  layoutWatchDetail()
}

/** 「这次的变化」：最近两次刷新的快照比，只列明显的（发了新版、下载涨跌两成以上、星标、名次变化），我的产品排前面 */
function renderWdChanges(list) {
  const box = $('#wdChanges')
  const hist = loadHistory()
  const mineNow = mine()
  const items = []
  let since = null
  for (const n of list) {
    const h = hist[n] || []
    const prev = baseSnap(h)
    if (!prev) continue
    const cur = h[h.length - 1]
    since = since == null || prev.t < since ? prev.t : since
    const who = `<b>${esc(watchName(n))}</b>${mineNow.includes(n) ? '<span class="mtag">我的</span>' : ''}`
    const its = []
    const add = (text, good) => its.push(`<span class="it">${text.replace('{c}', good == null ? '' : good ? 'up' : 'down')}</span>`)
    if (prev.v && cur.v && prev.v !== cur.v) add(`发了新版 v${esc(cur.v)}`)
    const pctCh = (key, label) => {
      if (!prev[key] || cur[key] == null) return
      const r = (cur[key] - prev[key]) / prev[key]
      if (Math.abs(r) >= 0.2) add(`${label} <span class="{c}">${r > 0 ? '+' : ''}${Math.round(r * 100)}%</span>`, r > 0)
    }
    pctCh('w', '周下载')
    pctCh('base', '日常基线')
    if (prev.s != null && cur.s != null && cur.s !== prev.s) add(`星标 <span class="{c}">${cur.s > prev.s ? '+' : ''}${num(cur.s - prev.s)}</span>`, cur.s > prev.s)
    const rankCh = (key, label, min) => {
      if (prev[key] == null || cur[key] == null) return
      const d = cur[key] - prev[key]
      if (Math.abs(d) >= min) add(`${label} <span class="{c}">${d < 0 ? '升' : '降'} ${num(Math.abs(d))} 名</span>`, d < 0)
    }
    rankCh('orank', '综合榜', 3)
    rankCh('rank', 'npm 总榜', 5)
    // 一个插件一行
    if (its.length) items.push({ mine: mineNow.includes(n), n: its.length, html: `<div class="ln">${who}：${its.join('')}</div>` })
  }
  if (since == null) { box.classList.add('hidden'); return }
  box.classList.remove('hidden')
  const when = new Date(since).toLocaleString()
  if (!items.length) {
    box.className = 'wdch quiet'
    box.innerHTML = `和上次刷新（${esc(when)}）比，没有明显变化。`
    return
  }
  box.className = 'wdch'
  items.sort((a, b) => b.mine - a.mine)
  box.innerHTML = `<b>这次的变化</b><span style="color:var(--t3)">（和 ${esc(when)} 的数据比）</span>` + items.map(x => x.html).join('')
}

/**
 * 监控详情选版式：右侧栏放得下整张表（每个插件一列）就用表格，放不下就在横条下面列出选中插件的全部数据。
 * 直接量表格的实际宽度：插件名长短、有没有「较上次」都会影响列宽，估不准。拖动侧栏宽度时跟着切换
 */
let WD_COUNT = 0
function layoutWatchDetail() {
  const wrap = $('#wdTable')
  if (!$('#secWatchDetail').clientWidth || !WD_COUNT) return // 标签页没显示时量不出宽度，显示出来再量
  wrap.classList.remove('hidden')
  const fits = wrap.scrollWidth <= wrap.clientWidth + 1
  wrap.classList.toggle('hidden', !fits)
  $('#wdOne').classList.toggle('hidden', fits)
}
if (typeof ResizeObserver !== 'undefined') {
  let lastW = 0
  new ResizeObserver(entries => {
    const w = Math.round(entries[0].contentRect.width)
    if (w !== lastW) { lastW = w; layoutWatchDetail() }
  }).observe(document.getElementById('secWatchDetail'))
}
// 保险：有的环境（后台页、老内核）不触发 ResizeObserver，窗口大小变了也量一次；切到「我的监控」时也会量
window.addEventListener('resize', () => layoutWatchDetail())
$('#secWatchDetail').addEventListener('click', e => {
  const mt = e.target.closest('[data-wdm]')
  if (mt) {
    WD_METRIC = mt.dataset.wdm
    try { localStorage.setItem(WD_METRIC_KEY, WD_METRIC) } catch { /* 记不住就算了 */ }
    paintWd()
    return
  }
  if (e.target.closest('[data-mine]')) return // 星标由 document 上的委托处理
  const bd = e.target.closest('[data-badge]')
  if (bd) {
    const md = badgeMd(bd.dataset.badge)
    copyText(md).then(ok => (ok ? toast('已复制徽章的 Markdown，贴进 README 就行') : toast('复制不了，手动复制这段：', md)))
    return
  }
  const row = e.target.closest('[data-wd]')
  if (row) { WD_SEL = row.dataset.wd; paintWd() }
})
$('#secWatchDetail').addEventListener('keydown', e => {
  const row = e.target.closest('[data-wd]')
  if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); WD_SEL = row.dataset.wd; paintWd() }
})

/**
 * 用户输入 → 监控名：目录里的包名直接用；GitHub 地址或 owner/repo：目录里有发到 npm 的就记包名，
 * 没有就记 gh:owner/repo；其余像 npm 包名的也收（目录外的插件，刷新时去 npm 查）。认不出返回 ''
 */
function watchKeyOf(text) {
  const t = text.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  if (CAT.packages[t]) return t
  const lower = t.toLowerCase()
  if (CAT.packages[lower]) return lower
  const gh = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/.exec(t) || (!t.startsWith('@') && /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(t))
  if (gh) {
    const repo = `${gh[1]}/${gh[2]}`
    const hit = Object.values(CAT.packages).filter(r => r.gh && r.gh.repo.toLowerCase() === repo.toLowerCase()).sort((a, b) => (b.w || 0) - (a.w || 0))[0]
    return hit ? hit.n : 'gh:' + repo
  }
  const npm = /^(?:https?:\/\/)?(?:www\.)?npmjs\.com\/package\/(.+)$/.exec(t)
  const name = (npm ? decodeURIComponent(npm[1]) : t).toLowerCase()
  return /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) ? name : ''
}

/** 「＋ 添加」：加进监控，再只查这一个的实时数据（不动「较上次」用的快照） */
function addToWatch(text) {
  const key = watchKeyOf(text)
  if (!key) { toast(`认不出「${text}」：输入 npm 包名，或 GitHub 仓库地址`); return false }
  if (watch().includes(key)) { toast(`已经在我的监控里了：${watchName(key)}`); return true }
  const before = watch().length
  toggleWatch(key)
  if (watch().length === before) return false // 满 30 个，toggleWatch 已提示
  fetchLiveOne(key)
  return true
}
async function fetchLiveOne(key) {
  try {
    const r = await fetch(`${P.live}?names=${encodeURIComponent(key)}`, { cache: 'no-store' })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status)
    const row = j.rows.find(x => x.name === key)
    if (!row) return
    LIVE = { ...LIVE, rows: { ...LIVE.rows, [key]: row } }
    try { localStorage.setItem(LIVE_KEY, JSON.stringify(LIVE)) } catch { /* 存不下就只这次有效 */ }
    if (!row.found) toast(`${watchName(key)}：${key.startsWith('gh:') ? 'GitHub 上查不到这个仓库' : 'npm 上查不到这个包'}，检查一下名字（不要的话点 × 移除）`)
    renderWatch()
  } catch { /* 没网就先显示目录数据，点「刷新」再查 */ }
}

async function refreshWatch() {
  const list = watch()
  if (!list.length) return
  const btn = $('#btnWatchRefresh')
  btn.disabled = true
  btn.textContent = '刷新中…'
  try {
    const r = await fetch(`${P.live}?names=${encodeURIComponent(list.join(','))}`, { cache: 'no-store' })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status)
    LIVE = { at: j.at, anchor: j.anchor, rows: Object.fromEntries(j.rows.map(x => [x.name, x])) }
    try { localStorage.setItem(LIVE_KEY, JSON.stringify(LIVE)) } catch { /* 存不下就只这次有效 */ }
    saveSnapshots(j.at)
    const miss = j.rows.filter(x => !x.found).map(x => x.name)
    toast([
      miss.length ? `已刷新；npm 上查不到：${miss.join('、')}` : `已刷新 ${j.rows.length} 个插件`,
      j.githubError ? `（${j.githubError}）` : '',
    ].join(''))
  } catch (e) {
    toast('刷新失败：' + e.message + '（检查网络后再试）')
  }
  btn.disabled = false
  btn.textContent = '↻ 刷新'
  renderWatch()
}

function renderWatch() {
  const list = watch()
  $('#watchCount').textContent = list.length ? ` (${list.length})` : ''
  $('#btnWatchRefresh').classList.toggle('hidden', !list.length)
  $('#watchAsOf').innerHTML = !list.length ? ''
    : LIVE.at ? `<b>实时数据</b>，${esc(new Date(LIVE.at).toLocaleString())} 刷新（npm 统计截止 ${esc(LIVE.anchor || '—')}）。`
      : `现在显示的是目录数据（截止 <b>${esc(CAT.anchor)}</b>）。`
  const host = $('#watchList')
  if (!list.length) {
    $('#watchAdd').classList.remove('hidden') // 空的时候直接摆出输入框
    host.innerHTML = '<div class="empty">还没有监控的插件。点上面的「＋ 添加」输入插件名，或在「选插件」、排行榜里点彩色的 +。</div>'
    return
  }

  // 像排行榜一样：上面一行是列名，每个插件一行。名字在最前、图标和移除在最后，
  // 中间各列始终都在，右侧栏变窄时一起按比例压缩（放不下的用省略号，悬停看全文）
  const cell = (text, title, cls = '') => `<span class="mc${cls ? ' ' + cls : ''}" title="${esc(title)}">${text}</span>`
  const head = '<div class="mrow mhead">' +
    '<span class="mc nm">插件</span>' +
    [['总榜', 'r', '总榜排名'], ['分类', '', '分类'], ['周下载', 'r', '周下载'], ['基线', 'r', '日常基线'], ['★', 'r', 'GitHub 星标'], ['发版', 'r', '最近一次发版']]
      .map(([t, cls, title]) => `<span class="mc${cls ? ' ' + cls : ''}" title="${title}">${t}</span>`).join('') +
    '<span class="mc acts"></span></div>'
  host.innerHTML = head + list.map(n => {
    const r = watchRec(n)
    const name = r ? esc(r.label || n) : esc(n)
    const ver = r && r.v ? ` <span class="ver">v${esc(r.v)}</span>` : ''
    const live = r && r.live ? '<i class="livedot" title="实时数据：刚从 npm / GitHub 查的"></i>' : ''
    const nameCell = `<span class="mc nm" title="${name}${r && r.v ? ' v' + esc(r.v) : ''}">${starBtn(n)}${live}${name}${ver}</span>`
    const acts = `<span class="mc acts">${r ? linkBtns(r, { icon: true }) : ''}<button class="x" data-rm="${esc(n)}" title="从我的监控移除" aria-label="移除 ${name}">×</button></span>`
    if (!r) return `<div class="mrow">${nameCell}<span class="mc span">不在目录中，点「刷新」去 npm 查</span>${acts}</div>`
    const d = r.deep
    // 和目录数据比，周下载涨了还是跌了（只在刷新过、差得明显时标）
    let delta = ''
    if (r.live && r.catalogW) {
      const ch = (r.w - r.catalogW) / Math.max(r.catalogW, 1)
      if (Math.abs(ch) >= 0.05) delta = `<span class="delta ${ch > 0 ? 'up' : 'down'}">${ch > 0 ? '↑' : '↓'}${Math.round(Math.abs(ch) * 100)}%</span>`
    }
    const rankFull = r.rank ? `总榜 #${num(r.rank)}${r.crank ? ` · ${r.cat} #${num(r.crank)}` : ''}` : ''
    return '<div class="mrow">' + nameCell +
      cell(r.rank ? `#${r.rank < 1000 ? r.rank : short(r.rank)}` : '—', rankFull || '不在总榜里', 'r') +
      cell(esc(r.cat || '—'), r.cat || '') +
      cell(r.w != null ? `<b>${short(r.w)}</b>${delta}` : '—', r.w != null ? `周下载 ${num(r.w)}${delta ? `（和目录数据相比 ${delta.replace(/<[^>]+>/g, '')}）` : ''}` : '只在 GitHub，没有 npm 数据', 'r') +
      cell(d ? short(d.base) : '—', d ? `日常基线 ${num(d.base)} 次/天` : '没有去噪指标', 'r') +
      cell(r.gh ? `${short(r.gh.s)}${r.gh.a ? ' · 已归档' : ''}` : '—', r.gh ? `GitHub ★ ${num(r.gh.s)}${r.gh.p ? ` · 最近提交 ${r.gh.p}` : ''}${r.gh.a ? ' · 已归档' : ''}` : '没有 GitHub 数据', 'r') +
      cell(d ? ageText(d.age) : '—', d && d.lastRelease ? `最近发版 ${d.lastRelease}` : '', 'r') +
      acts + '</div>'
  }).join('')

  host.querySelectorAll('[data-rm]').forEach(b =>
    b.addEventListener('click', () => saveWatch(watch().filter(x => x !== b.dataset.rm)) || renderWatch()))

  renderWatchDetail(list)
}

/* ---------------- 导出结论（网页版） ---------------- */
function exportHtml() {
  const rows = picked.map(cmpRec).filter(Boolean)
  if (!rows.length) return
  const need = $('#need').value.trim()
  const verdicts = $('#verdicts').innerHTML

  const body = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>dsh-pick 选型结论 · ${esc(need)}</title>
<style>body{font-family:-apple-system,"PingFang SC",sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#1a1e26;line-height:1.7}
h1{font-size:20px}h2{font-size:15px;margin:26px 0 10px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:9px 10px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left;color:#8b95a4}thead th{color:#1a1e26}
.verdict{border-radius:10px;padding:13px 15px;margin-bottom:10px;border:1px solid}
.win{background:#e7f6ee;border-color:#bfe6d1}.alt{background:#fdf3e3;border-color:#f2ddb6}.no{background:#fdecec;border-color:#f2cccc}
.verdict h4{margin:0 0 6px;font-size:13px}.verdict p{margin:0;font-size:12.5px;color:#58606e}
.foot{font-size:11.5px;color:#8b95a4;margin-top:28px;border-top:1px dashed #ddd;padding-top:12px}
.best{color:#0f9d58;font-weight:700}.miss{color:#b9c2ce}
</style></head><body>
<h1>dsh-pick 选型结论</h1>
<p style="color:#58606e;font-size:13px">需求：<b>${esc(need)}</b></p>
<h2>比较</h2>
<table><thead><tr><th>指标</th>${rows.map(r => `<th>${esc(r.n)}</th>`).join('')}</tr></thead><tbody>
${ROWS.map(row => {
    const vals = rows.map(r => row.get(r))
    const valid = vals.filter(v => v !== null && v !== undefined && !Number.isNaN(v))
    const bv = valid.length ? (row.best === 'max' ? Math.max(...valid) : Math.min(...valid)) : null
    return `<tr><td>${row.label}</td>` + vals.map(v =>
      `<td class="${v === null || v === undefined ? 'miss' : (v === bv ? 'best' : '')}">${row.fmt(v)}</td>`).join('') + '</tr>'
  }).join('')}
</tbody></table>
<h2>结论</h2>${verdicts}
<div class="foot">数据来源 api.npmjs.org / registry.npmjs.org，截止 <b>${CAT.anchor}</b>（npm 最近有数据的一天）。
下载量含 CI、镜像、爬虫等非人类流量，不等于用户数；<b>日常基线</b>＝扣掉版本发布日与次日后的每日中位数。
本页由 dsh-pick 面板导出。</div>
</body></html>`

  const blob = new Blob([body], { type: 'text/html' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `dsh-pick-${(need || '结论').slice(0, 12).replace(/\s+/g, '_')}.html`
  a.click()
  URL.revokeObjectURL(a.href)
}

boot()
