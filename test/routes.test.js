// 宿主端路由：用真实的 plugin/index.js，接一个假的 webServer 和假的插件管理器
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { makeCatalog, tempHome } from './fixtures.js'

process.env.DSH_HOME = await tempHome() // 别碰本机真的 ~/.dsh
const { reloadCatalog } = await import('../lib/engine.js')
reloadCatalog(makeCatalog())

// npm 上的「最新版」固定成 9.9.9；本地请求照常走
const realFetch = globalThis.fetch
globalThis.fetch = async (url, opt) => (/registry\.|npmmirror/.test(String(url))
  ? new Response(JSON.stringify({ version: '9.9.9' }))
  : realFetch(url, opt))

const plugin = (await import('../plugin/index.js')).default

const pm = {
  bundles: [{ name: 'dsh-mnemon', installed: true }, { name: 'dsh-pick', installed: true }],
  calls: [],
  next: null, // 下一次 installBundle 的答复
  listBundles() { return this.bundles },
  async installBundle(spec) { this.calls.push(['install', spec]); return this.next || { application: 'applied' } },
  async removeBundle(name) { this.calls.push(['remove', name]); return {} },
}

const routes = {}
const stops = []
plugin.apply({
  get: n => (n === 'profileContext' ? { name: 'desktop' } : undefined),
  effect: fn => stops.push(fn()),
  inject: (deps, fn) => {
    if (deps[0] === 'webServer') fn({ webServer: { register: d => { routes[d.path] = d.handler } } })
    if (deps[0] === 'pluginManager') fn({ pluginManager: pm })
  },
})
await new Promise(r => setTimeout(r, 30)) // 等 apply 里读完 package.json

const server = http.createServer((req, res) => {
  const h = routes[req.url.split('?')[0]]
  if (h) return h(req, res)
  res.writeHead(404); res.end()
}).listen(0)
const base = `http://127.0.0.1:${server.address().port}/api-dsh-pick/`
after(() => { server.close(); stops.forEach(s => s && s()) })

const get = async p => (await realFetch(base + p)).json()
const post = async (p, body = {}, headers = {}) => {
  const r = await realFetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: r.status, ...(await r.json()) }
}

test('目录接口发的是归一化后的（带排名与链接）', async () => {
  const cat = await get('catalog.json')
  assert.equal(cat.packages['dsh-mnemon'].rank, 1)
  assert.ok(cat.packages['dsh-sql'].npmUrl)
})

test('目录概要带来源', async () => {
  const meta = await get('meta')
  assert.equal(meta.total, 7)
  assert.equal(meta.anchor, '2026-10-13')
  assert.ok(['bundled', 'remote'].includes(meta.source))
})

test('会改东西的请求：只收同源的 JSON POST', async () => {
  for (const p of ['update', 'uninstall', 'install']) {
    assert.equal((await post(p, {}, { origin: 'http://evil.example' })).status, 403)
    const form = await realFetch(base + p, { method: 'POST', body: 'name=x' })
    assert.equal(form.status, 403)
  }
})

test('更新：桌面版答 already-installed 时，给出退出 DSH 的提示和命令', async () => {
  pm.next = { application: 'failed', error: { code: 'already-installed' } }
  const r = await post('update')
  pm.next = null
  assert.equal(r.ok, false)
  assert.match(r.message, /完全退出 DSH/)
  assert.equal(r.command, 'dsh plugin --profile desktop add dsh-pick@9.9.9')
})

test('更新：成功时交给插件管理器装 npm 最新版', async () => {
  const r = await post('update')
  assert.equal(r.ok, true)
  assert.deepEqual(pm.calls.at(-1), ['install', 'dsh-pick@9.9.9'])
})

test('安装：只装目录里有、并且声明了 dsh.bundle 的', async () => {
  assert.match((await post('install', { name: 'left-pad' })).message, /不在 DSH 插件目录里/)
  assert.match((await post('install', { name: '../../x' })).message, /包名不对/)
  assert.match((await post('install', { name: 'dsh-no-bundle' })).message, /dsh\.bundle/)
  const ok = await post('install', { name: 'meow-memory' })
  assert.equal(ok.ok, true)
  assert.deepEqual(pm.calls.at(-1), ['install', 'meow-memory'])
})

test('已装列表', async () => {
  const r = await get('installed')
  assert.equal(r.known, true)
  assert.ok(r.names.includes('dsh-mnemon'))
  assert.equal(r.canInstall, true)
})

test('卸载交给插件管理器', async () => {
  const r = await post('uninstall')
  assert.equal(r.ok, true)
  assert.deepEqual(pm.calls.at(-1), ['remove', 'dsh-pick'])
})
