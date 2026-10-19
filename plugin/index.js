// plugin/index.js — dsh-pick 的 DSH 插件（宿主端）
//
// 只做一件事：把「选插件」面板挂到 dsh 自己的 webServer 上，让 dsh 设置页里能看，
// 顺便给面板提供数据接口。数据来自随包自带的 data/catalog.json，或每天自动更新下来的那份
// （~/.dsh/dsh-pick/catalog.json，见 lib/remote.js），用新的那份；只读公开的 npm 数据，不外传任何东西。
//
// 路由（都走 dsh 的登录校验，所以先过 dsh 自己的鉴权）：
//   GET  /api-dsh-pick/panel        面板 HTML
//   GET  /api-dsh-pick/panel.js     面板逻辑
//   GET  /api-dsh-pick/words.js     搜索词典
//   GET  /api-dsh-pick/catalog.json 目录（含排名、链接、去噪指标）
//   GET  /api-dsh-pick/meta         目录概要（更新时间、包数、来源）
//   GET  /api-dsh-pick/update       本插件版本 + npm 上的最新版本
//   POST /api-dsh-pick/update       更新到 npm 最新版（交给 DSH 的插件管理器）
//   POST /api-dsh-pick/uninstall    从 DSH 卸载本插件
//   GET  /api-dsh-pick/installed    DSH 里已装的插件名（面板的「已安装」标记）
//   POST /api-dsh-pick/install      安装目录里的某个插件 { name }
//
// 另外注册 4 个 AI 工具（plugin/tools.js）：对话里的 AI 能自己查目录、比较插件。
//
// 写法照 dsh-model（同机参考）与 dsh-vps-manager（同作者）的 plugin/index.js。

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { registerTools } from './tools.js'
import { loadCatalog } from '../lib/engine.js'
import { refreshCatalog, remoteState, CHECK_EVERY_MS } from '../lib/remote.js'

/** 本包根目录：插件就是完整的 dsh-pick 包 */
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

/** 只放行这几个固定文件，别把 bin/ 也暴露出去 */
const FILES = {
  '/panel': 'web/panel.html',
  '/panel.js': 'web/panel.js',
  '/words.js': 'lib/words.js',
}

async function readPkgJson() {
  try {
    return JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

const PACKAGE = 'dsh-pick'
// npm 官方源连不上（国内常见）就问镜像
const NPM_REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com']
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** a 比 b 新返回正数（x.y.z，预发布版比同号正式版旧） */
function compareVersions(a, b) {
  const parse = v => {
    const [core, pre = ''] = String(v || '').replace(/^v/, '').split('-', 2)
    return { nums: core.split('.').map(n => parseInt(n, 10) || 0), pre }
  }
  const x = parse(a), y = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0)
    if (d) return d
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

/** npm 上 latest 是哪个版本；10 分钟内复用上次的结果 */
let npmCache = null
async function latestOnNpm(force) {
  if (!force && npmCache && Date.now() - npmCache.at < 10 * 60 * 1000) return npmCache.version
  for (const registry of NPM_REGISTRIES) {
    try {
      const r = await fetch(`${registry}/${PACKAGE}/latest`, { signal: AbortSignal.timeout(6000) })
      if (!r.ok) continue
      const { version } = await r.json()
      if (VERSION_RE.test(String(version || ''))) {
        npmCache = { version, at: Date.now() }
        return version
      }
    } catch { /* 换下一个源 */ }
  }
  return ''
}

/** 给用户自己在终端执行的命令：DSH 0.2 起 --profile 必填，且要写在 add / remove 前面 */
function pluginCommand(args, profile) {
  return /^[A-Za-z0-9._-]+$/.test(profile || '') ? `dsh plugin --profile ${profile} ${args}` : `dsh plugin ${args}`
}

/** 插件管理器的失败结果 → 一行人话（取诊断输出的最后几行） */
/** 插件管理器失败结果里的错误码（没失败返回空串） */
function managerCode(result) {
  if (!(result && (result.application === 'failed' || result.application === 'cancelled' || result.error))) return ''
  return (result.error && result.error.code) || result.application || 'failed'
}

/**
 * 官方桌面版（0.2.1-rc.2 实测）的插件管理器不能在运行中升级已装的插件：installBundle 一律答
 * already-installed（插件市场的「更新」也栽在这里）。只能退出 DSH、在终端用 dsh plugin 装
 */
const ALREADY_INSTALLED_HINT =
  '这个版本的 DSH 不能在运行中升级已装的插件。请完全退出 DSH（Mac 上按 Cmd+Q，不是关窗口），' +
  '在终端执行下面的命令，再重新打开 DSH。如果提示版本太新（发布不满 1 天），过一天再执行。'

function managerError(result) {
  if (!(result && (result.application === 'failed' || result.application === 'cancelled' || result.error))) return ''
  const code = (result.error && result.error.code) || result.application || 'failed'
  const detail = String((result.error && result.error.diagnostic) || (result.packageResult && result.packageResult.output) || '')
    .trim().split('\n').slice(-3).join(' ').slice(-300)
  return detail ? `${code}：${detail}` : code
}

/** 读请求体里的 JSON（最多 16 KB，这里只收很小的参数） */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 16 * 1024) { req.destroy(); resolve({}) } else chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/** DSH 插件管理器清单里已装、已启用的插件名；拿不到就是 null（老版本 DSH） */
function installedNames(pluginManager) {
  try {
    const list = pluginManager && typeof pluginManager.listBundles === 'function' ? pluginManager.listBundles() : null
    if (!Array.isArray(list)) return null
    return new Set(list.filter(b => b && b.name && b.installed !== false).map(b => b.name))
  } catch {
    return null
  }
}

const NAME_RE = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * 会改东西的请求（更新、卸载）只收同源的 JSON POST：
 * 别的网站发不出带 application/json 的跨站请求（要预检），Origin 也对不上
 */
function isSafePost(req) {
  if (req.method !== 'POST') return false
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** 目录概要：给面板顶部、设置页显示「更新时间 / 包数 / 来源」用 */
async function catalogMeta() {
  const cat = await loadCatalog()
  const packages = cat.packages || {}
  const state = await remoteState()
  return {
    asOf: cat.asOf || null,
    anchor: cat.anchor || null,
    total: cat.total || Object.keys(packages).length,
    deepCount: Object.values(packages).filter(p => p && p.deep).length,
    source: cat.source || 'bundled',
    checkedAt: state.checkedAt || null,
  }
}

/** 归一化后的目录（带排名、npm / GitHub 链接）序列化一次就够：目录对象换了才重算 */
let catalogText = { of: null, text: '' }
async function catalogJson() {
  const cat = await loadCatalog()
  if (catalogText.of !== cat) catalogText = { of: cat, text: JSON.stringify(cat) }
  return catalogText.text
}

export const name = 'dsh-pick'
export const inject = []

export function apply(ctx) {
  // 启动时加载的版本；磁盘上的可能更新（更新了还没重启）
  let running = ''
  readPkgJson().then(p => { running = p.version || '' })

  // DSH 自己的插件管理器（和 DSH「插件」页同一套：带锁跑 pnpm、失败自动还原）。老版本 DSH 没有
  let pluginManager
  ctx.inject(['pluginManager'], (pmCtx) => {
    pluginManager = pmCtx.pluginManager || (pmCtx.get && pmCtx.get('pluginManager'))
  })
  // 当前 profile（官方桌面版 desktop，dsh web 是 web），只用来拼给用户手动执行的命令
  let profile
  try {
    profile = ctx.get && ctx.get('profileContext') && ctx.get('profileContext').name
  } catch { profile = undefined }

  // 每日更新的目录：启动时查一次，之后每 6 小时查一次（查不到就继续用手上的）
  const refresh = () => refreshCatalog().catch(() => {})
  const startTimer = setTimeout(refresh, 5000) // 别和 DSH 启动抢网络
  const timer = setInterval(refresh, CHECK_EVERY_MS)
  if (timer.unref) timer.unref()
  if (startTimer.unref) startTimer.unref()
  const stop = () => { clearTimeout(startTimer); clearInterval(timer) }
  if (typeof ctx.effect === 'function') ctx.effect(() => stop)
  else if (typeof ctx.on === 'function') ctx.on('dispose', stop)

  // AI 工具：DSH 有 tools 服务才注册（可选依赖，没有也不影响面板）
  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.tools || (toolsCtx.get && toolsCtx.get('tools'))
    if (!tools || typeof tools.register !== 'function') return
    registerTools({ tools }, { installed: () => installedNames(pluginManager) || new Set() })
      .catch(e => console.warn('[dsh-pick] AI 工具注册失败', e))
  })

  ctx.inject(['webServer'], (webCtx) => {
    const ws = webCtx.webServer
    if (!ws || typeof ws.register !== 'function') return

    const track = d => d

    // 面板静态资源
    for (const [route, rel] of Object.entries(FILES)) {
      track(ws.register({
        kind: 'exact',
        path: '/api-dsh-pick' + route,
        handler: async (req, res) => {
          try {
            const buf = await readFile(join(PKG_ROOT, rel))
            const ext = rel.slice(rel.lastIndexOf('.'))
            res.writeHead(200, {
              'content-type': TYPES[ext] || 'text/plain; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(buf)
          } catch (e) {
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({
              error: { code: 'not_built', message: `缺少 ${rel}，先跑一次 dsh-pick build` },
            }))
          }
        },
      }))
    }

    // 目录（归一化后的：带排名与链接；用新的那份）
    track(ws.register({
      kind: 'exact',
      path: '/api-dsh-pick/catalog.json',
      handler: async (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(await catalogJson())
      },
    }))

    // 目录概要
    track(ws.register({
      kind: 'exact',
      path: '/api-dsh-pick/meta',
      handler: async (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(await catalogMeta()))
      },
    }))

    // 版本与更新
    track(ws.register({
      kind: 'exact',
      path: '/api-dsh-pick/update',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const force = /[?&]force=1/.test(req.url || '')
          const [pkg, latest] = await Promise.all([readPkgJson(), latestOnNpm(force)])
          const installed = pkg.version || ''
          const current = compareVersions(installed, running) > 0 ? installed : running
          return sendJson(res, 200, {
            running,
            restartPending: installed && running && compareVersions(installed, running) > 0 ? installed : '',
            latest,
            available: Boolean(latest) && compareVersions(latest, current) > 0,
            canInstall: Boolean(pluginManager && typeof pluginManager.installBundle === 'function'),
            command: pluginCommand(`add ${PACKAGE}@${latest || 'latest'}`, profile),
          })
        }
        if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
        const latest = await latestOnNpm(true)
        const command = pluginCommand(`add ${PACKAGE}@${latest || 'latest'}`, profile)
        if (!latest) return sendJson(res, 200, { ok: false, message: '查不到 npm 上的最新版本，检查网络后再试', command })
        if (compareVersions(latest, running) <= 0) return sendJson(res, 200, { ok: false, message: `已经是最新版 v${running}` })
        if (!pluginManager || typeof pluginManager.installBundle !== 'function') {
          return sendJson(res, 200, { ok: false, message: '这个版本的 DSH 不能在这里装插件，请在终端执行命令', command })
        }
        try {
          const result = await pluginManager.installBundle(`${PACKAGE}@${latest}`, { enabled: true })
          if (managerCode(result) === 'already-installed') return sendJson(res, 200, { ok: false, message: ALREADY_INSTALLED_HINT, command })
          const err = managerError(result)
          if (err) return sendJson(res, 200, { ok: false, message: `更新失败（${err}）`, command })
          return sendJson(res, 200, { ok: true, version: latest })
        } catch (e) {
          if (e && e.code === 'already-installed') return sendJson(res, 200, { ok: false, message: ALREADY_INSTALLED_HINT, command })
          return sendJson(res, 200, { ok: false, message: `更新失败：${e.message}`, command })
        }
      },
    }))

    // 卸载本插件
    track(ws.register({
      kind: 'exact',
      path: '/api-dsh-pick/uninstall',
      handler: async (req, res) => {
        if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
        const command = pluginCommand(`remove ${PACKAGE}`, profile)
        if (!pluginManager || typeof pluginManager.removeBundle !== 'function') {
          return sendJson(res, 200, { ok: false, message: '这里没法直接卸载：完全退出 DSH 后在终端执行命令', command })
        }
        try {
          const result = await pluginManager.removeBundle(PACKAGE)
          const err = managerError(result)
          if (err) return sendJson(res, 200, { ok: false, message: `卸载失败（${err}），可完全退出 DSH 后在终端执行命令`, command })
          return sendJson(res, 200, { ok: true })
        } catch (e) {
          return sendJson(res, 200, { ok: false, message: `卸载失败：${e.message}`, command })
        }
      },
    }))

    // 已装的插件（面板卡片上的「已安装」）
    track(ws.register({
      kind: 'exact',
      path: '/api-dsh-pick/installed',
      handler: async (req, res) => {
        const names = installedNames(pluginManager)
        sendJson(res, 200, {
          known: Boolean(names),
          names: names ? [...names] : [],
          canInstall: Boolean(pluginManager && typeof pluginManager.installBundle === 'function'),
        })
      },
    }))

    // 安装目录里的插件：只装目录里有的（都是带 dsh-plugin 关键字的 npm 包），不接受任意包名
    track(ws.register({
      kind: 'exact',
      path: '/api-dsh-pick/install',
      handler: async (req, res) => {
        if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
        const { name } = await readJsonBody(req)
        if (typeof name !== 'string' || !NAME_RE.test(name)) return sendJson(res, 400, { ok: false, message: '包名不对' })
        const rec = (await loadCatalog()).packages[name]
        if (!rec) return sendJson(res, 400, { ok: false, message: `${name} 不在 DSH 插件目录里，这里不装` })
        // 没声明 dsh.bundle 的包，DSH 一定拒绝安装：不白跑一趟 pnpm
        if (rec.inst && rec.inst.b === false) {
          return sendJson(res, 400, { ok: false, message: `${name} 没有声明 dsh.bundle，DSH 不能把它当插件安装` })
        }
        const command = pluginCommand(`add ${name}`, profile)
        if (!pluginManager || typeof pluginManager.installBundle !== 'function') {
          return sendJson(res, 200, { ok: false, message: '这个版本的 DSH 不能在这里装插件，请在终端执行命令', command })
        }
        try {
          const result = await pluginManager.installBundle(name, { enabled: true })
          const err = managerError(result)
          if (err) return sendJson(res, 200, { ok: false, message: `安装失败（${err}）`, command })
          return sendJson(res, 200, { ok: true, restart: result && result.application === 'restart-required' })
        } catch (e) {
          return sendJson(res, 200, { ok: false, message: `安装失败：${e.message}`, command })
        }
      },
    }))

    // 面板是内嵌在 dsh 设置页里的 iframe，同源即可，不需要额外令牌：
    // 这些路由全都先过 dsh 的登录校验（挂在 dsh 自己的 webServer 上）。
  })
}

export default { name, inject, apply, __meta: { pkgRoot: PKG_ROOT, version: () => readPkgJson().then(p => p.version || '') } }
