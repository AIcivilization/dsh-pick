import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { refreshCatalog, validCatalog, MIRRORS } from '../lib/remote.js'
import { cachePath, loadCatalog, reloadCatalog } from '../lib/engine.js'
import { makeCatalog, tempHome, fakeFetch } from './fixtures.js'

const NEW = makeCatalog({ anchor: '2099-01-01', extra: 600 })
const meta = cat => ({ anchor: cat.anchor, asOf: cat.asOf })

async function setup() {
  const env = { DSH_HOME: await tempHome() }
  reloadCatalog(null)
  return env
}

test('validCatalog：包太少、日期不对、字段缺失都不要', () => {
  assert.equal(validCatalog(NEW), true)
  assert.equal(validCatalog(makeCatalog({ anchor: '2099-01-01' })), false) // 包太少
  assert.equal(validCatalog({ ...NEW, anchor: 'yesterday' }), false)
  assert.equal(validCatalog('<html>'), false)
})

test('有更新：下载、写进 ~/.dsh/dsh-pick/、马上换上', async () => {
  const env = await setup()
  const fetchImpl = fakeFetch({ 'meta.json': meta(NEW), 'catalog.json': NEW })
  const r = await refreshCatalog({ fetchImpl, env })
  assert.equal(r.updated, true)
  assert.equal(r.anchor, '2099-01-01')
  const saved = JSON.parse(await readFile(cachePath(env), 'utf8'))
  assert.equal(saved.anchor, '2099-01-01')
  const cat = await loadCatalog({ env })
  assert.equal(cat.source, 'remote')
  reloadCatalog(null)
})

test('没有更新：只取 meta.json，不下载整个目录', async () => {
  const env = await setup()
  const fetchImpl = fakeFetch({ 'meta.json': { anchor: '2000-01-01', asOf: '2000-01-01' }, 'catalog.json': NEW })
  const r = await refreshCatalog({ fetchImpl, env })
  assert.equal(r.updated, false)
  assert.ok(!fetchImpl.calls.some(u => u.endsWith('catalog.json')))
})

test('6 小时内查过就不再查；force 照查', async () => {
  const env = await setup()
  await mkdir(join(env.DSH_HOME, 'dsh-pick'), { recursive: true })
  await writeFile(join(env.DSH_HOME, 'dsh-pick', 'remote.json'), JSON.stringify({ checkedAt: new Date().toISOString() }))
  const fetchImpl = fakeFetch({ 'meta.json': meta(NEW), 'catalog.json': NEW })
  assert.equal((await refreshCatalog({ fetchImpl, env })).checked, false)
  assert.equal(fetchImpl.calls.length, 0)
  assert.equal((await refreshCatalog({ fetchImpl, env, force: true })).updated, true)
  reloadCatalog(null)
})

test('第一个镜像连不上就换下一个', async () => {
  const env = await setup()
  const fetchImpl = fakeFetch({
    [MIRRORS[0]]: new Error('blocked'),
    [MIRRORS[1] + 'meta.json']: meta(NEW),
    [MIRRORS[1] + 'catalog.json']: NEW,
  })
  const r = await refreshCatalog({ fetchImpl, env })
  assert.equal(r.updated, true)
  assert.equal(r.mirror, MIRRORS[1])
  reloadCatalog(null)
})

test('下载到坏文件：不写、不换，下次再试', async () => {
  const env = await setup()
  const fetchImpl = fakeFetch({ 'meta.json': meta(NEW), 'catalog.json': { anchor: '2099-01-01', packages: {} } })
  const r = await refreshCatalog({ fetchImpl, env })
  assert.equal(r.updated, false)
  assert.ok(r.error)
  await assert.rejects(readFile(cachePath(env), 'utf8'))
  // 没记 checkedAt：下一轮还会再查
  await assert.rejects(readFile(join(dirname(cachePath(env)), 'remote.json'), 'utf8'))
})
