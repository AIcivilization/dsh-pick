/* dsh-pick 面板逻辑 —— 选插件四步：说需求 → 找候选 → 多维比较 → 出结论 */
import { expandWords } from '/lib/words.js'

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

/* ---------------- 搜索（与 lib/engine.js 共用同一份词典 lib/words.js） --------------- */
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
  const res = await fetch('data/catalog.json', { cache: 'no-store' })
  if (!res.ok) { $('#meta').textContent = '目录缺失，先跑 dsh-pick build'; return }
  CAT = await res.json()

  const deepN = Object.values(CAT.packages).filter(p => p.deep).length
  $('#meta').innerHTML =
    `目录 <b>${num(CAT.total)}</b> 个插件 · 去噪指标 <b>${num(deepN)}</b> 个<br>` +
    `数据截止 <b>${CAT.anchor}</b>（npm 统计滞后约 5 天）`

  $('#foot').innerHTML =
    `<b>口径：</b>下载量含 CI、镜像、爬虫等非人类流量，不等于用户数；<b>日常基线</b>= 扣掉版本发布日与次日后的每日中位数，比原始下载量更接近真实使用量。<br>` +
    `<b>覆盖范围：</b>npm 上带 <code>dsh-plugin</code> 关键字的 ${num(CAT.total)} 个包；去噪指标只算了周下载 Top ${num(deepN)}。目录每天重建一次，重跑 <code>dsh-pick build</code> 即可。<br>` +
    `<b>当前结论由本地规则生成</b>（依据就是对比表里的数字）。装上 DSH 插件版后，这一步由 AI 生成，可结合你的具体场景解释取舍。`

  buildCategoryFilter()
  renderRank()
  renderWatch()
  bindEvents()
}

function bindEvents() {
  $('#btnFind').addEventListener('click', doSearch)
  $('#need').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch() })

  document.querySelectorAll('.examples .chip').forEach(c => {
    c.addEventListener('click', () => { $('#need').value = c.textContent; doSearch() })
  })

  document.querySelectorAll('#tabs button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b))
      const t = b.dataset.tab
      $('#tab-pick').classList.toggle('hidden', t !== 'pick')
      $('#tab-watch').classList.toggle('hidden', t !== 'watch')
    })
  })

  document.querySelectorAll('#rankFilters .chip').forEach(c => {
    c.addEventListener('click', () => {
      document.querySelectorAll('#rankFilters .chip').forEach(x => x.classList.toggle('on', x === c))
      renderRank()
    })
  })
  $('#rankCat').addEventListener('change', renderRank)

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

function renderCands(need) {
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
        `<div class="d">${esc(rec.d)}</div>` +
        `<div class="kv">` +
          `<span>周 <b>${num(rec.w)}</b></span>` +
          `<span>月 <b>${num(rec.m)}</b></span>` +
          (d ? `<span>基线 <b>${num(d.base)}</b></span><span>环比 <b>${pct(d.growth)}</b></span>` : '') +
        `</div>` +
      `</div>`
    el.addEventListener('click', () => togglePick(rec.n))
    host.appendChild(el)
  })

  $('#secCand').classList.remove('hidden')
  $('#candCount').textContent = `「${esc(need)}」命中 ${cands.length} 个 · 已选 ${picked.length}`
}

function togglePick(name) {
  if (picked.includes(name)) picked = picked.filter(x => x !== name)
  else {
    if (picked.length >= 6) { alert('最多比较 6 个'); return }
    picked.push(name)
  }
  renderCands($('#need').value.trim())
  renderCompare()
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
]

function renderCompare() {
  const sec = $('#secCmp')
  if (picked.length < 2) {
    sec.classList.add('hidden')
    $('#secVerdict').classList.add('hidden')
    $('#candCount').textContent = `「${esc($('#need').value.trim())}」命中 ${cands.length} 个 · 已选 ${picked.length}（选满 2 个开始比较）`
    return
  }

  const rows = picked.map(n => CAT.packages[n]).filter(Boolean)
  const missingDeep = rows.filter(r => !r.deep).length

  $('#cmpHead').innerHTML = '<tr><th>指标</th>' +
    rows.map((r, i) => `<th><i style="background:${colorOf(picked.indexOf(r.n))}"></i>${esc(r.n)}</th>`).join('') +
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
    (missingDeep ? `<br><span style="color:#b4530a">其中 ${missingDeep} 个未进入深挖范围（周下载 Top 榜外），去噪指标缺失，无法参与健康度比较。</span>` : '')

  sec.classList.remove('hidden')
  renderVerdict()
}

/* ---------------- 第 4 步：结论 ---------------- */
function renderVerdict() {
  const rows = picked.map(n => CAT.packages[n]).filter(Boolean)
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

function renderRank() {
  const metric = document.querySelector('#rankFilters .chip.on').dataset.m
  const cat = $('#rankCat').value
  const onlyDeep = metric !== 'w'

  let rows = Object.values(CAT.packages).filter(r => (!cat || r.cat === cat) && (!onlyDeep || r.deep))
  const val = r => metric === 'base' ? r.deep.base
    : metric === 'growth' ? (r.deep.growth === null ? -Infinity : r.deep.growth)
    : metric === 's' ? r.deep.s
    : r.w
  rows.sort((a, b) => val(b) - val(a))
  rows = rows.slice(0, 40)

  $('#rankBody').innerHTML = rows.map((r, i) => {
    const d = r.deep
    const g = d ? d.growth : null
    return `<tr>` +
      `<td style="color:var(--t3)">${i + 1}</td>` +
      `<td class="nm">${esc(r.n)} <span style="color:var(--t3);font-weight:400;font-size:11px">v${esc(r.v)}</span></td>` +
      `<td><span class="catpill">${esc(r.cat)}</span></td>` +
      `<td class="r"><b>${num(val(r))}</b></td>` +
      `<td class="r">${num(r.w)}</td>` +
      `<td class="r ${g === null ? '' : (g >= 0 ? 'up' : 'down')}">${pct(g)}</td>` +
      `<td class="r">${d && d.cadence !== null ? d.cadence + ' 天' : '—'}</td>` +
      `<td class="r">${d ? d.age + ' 天前' : '—'}</td>` +
      `</tr>`
  }).join('')
}

/* ---------------- 我的监控 ---------------- */
function watch() {
  try { return JSON.parse(localStorage.getItem(WATCH_KEY)) || [] } catch { return [] }
}
function saveWatch(list) { localStorage.setItem(WATCH_KEY, JSON.stringify(list)) }

function addPickedToWatch() {
  const list = watch()
  for (const n of picked) if (!list.includes(n)) list.push(n)
  saveWatch(list.slice(0, 30))
  renderWatch()
  alert('已加入我的监控（' + picked.join('、') + '）')
}

function renderWatch() {
  const list = watch()
  $('#watchCount').textContent = list.length ? ` (${list.length})` : ''
  const host = $('#watchList')
  if (!list.length) {
    host.innerHTML = '<div class="empty">还没有监控的插件。在「选插件」里挑几个，点「加入我的监控」。</div>'
    $('#watchChart').innerHTML = ''
    return
  }

  host.innerHTML = list.map(n => {
    const r = CAT.packages[n]
    if (!r) return `<div class="mon"><span class="nm">${esc(n)}</span><span style="color:var(--t3);font-size:11.5px">不在目录中</span><button class="x" data-rm="${esc(n)}">×</button></div>`
    const d = r.deep
    return `<div class="mon">` +
      `<span class="nm">${esc(n)}</span>` +
      `<span style="font-size:11.5px;color:var(--t3)">${esc(r.cat)}</span>` +
      `<span style="font-size:12px"><b>${num(r.w)}</b>/周</span>` +
      `<span style="font-size:12px;color:var(--t2)">基线 ${d ? num(d.base) : '—'}</span>` +
      `<button class="x" data-rm="${esc(n)}">×</button></div>`
  }).join('')

  host.querySelectorAll('[data-rm]').forEach(b =>
    b.addEventListener('click', () => saveWatch(watch().filter(x => x !== b.dataset.rm)) || renderWatch()))

  // 对数刻度横条图
  const rows = list.map(n => CAT.packages[n]).filter(Boolean)
  const max = Math.max(...rows.map(r => r.w), 1)
  $('#watchChart').innerHTML = rows.map((r, i) => {
    const w = Math.max(Math.log10(r.w + 1) / Math.log10(max + 1) * 100, 1.5)
    return `<div class="hrow" style="display:grid;grid-template-columns:210px 1fr 78px;align-items:center;gap:12px;padding:6px 0">` +
      `<div style="font-size:12px;color:var(--t2);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colorOf(i)};margin-right:6px"></i>${esc(r.n)}</div>` +
      `<div style="height:14px;background:#f1f3f6;border-radius:4px"><div style="height:100%;width:${w}%;background:${colorOf(i)};border-radius:4px"></div></div>` +
      `<div style="font-size:12px;font-weight:650;text-align:right">${num(r.w)}</div></div>`
  }).join('')
}

/* ---------------- 导出结论（网页版） ---------------- */
function exportHtml() {
  const rows = picked.map(n => CAT.packages[n]).filter(Boolean)
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
<div class="foot">数据来源 api.npmjs.org / registry.npmjs.org，截止 <b>${CAT.anchor}</b>（npm 统计滞后约 5 天）。
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
