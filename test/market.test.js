// DSH「发现」页的插件索引：生成（用官方校验器）与加进索引源
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import { indexEntry, buildMarketIndex, INDEX_URL } from '../lib/market-index.js'
import { ensureMarketSource, marketStatus } from '../lib/market-source.js'
import { tempHome } from './fixtures.js'

const ok = (n, extra = {}) => ({
  n, v: '1.2.3', d: '描述', w: 100, cat: '记忆与上下文', kw: ['memory'], t: '2026-11-01T08:00:00.000Z',
  repo: 'git+https://github.com/x/' + n + '.git',
  inst: { b: true, e: '>=0.2.0-0', a: 'Li' }, deep: { base: 9, s: 70 }, gh: { repo: 'x/' + n, s: 5 }, ...extra,
})

test('indexEntry：只收有 bundle、有 engines.dsh、有版本和发布时间的', () => {
  assert.equal(indexEntry(ok('a', { inst: { b: false, e: '*' } })).skip, '没声明 dsh.bundle')
  assert.equal(indexEntry(ok('a', { inst: { b: true } })).skip, '没声明 engines.dsh')
  assert.equal(indexEntry(ok('a', { t: undefined })).skip, '没有发布时间')
  assert.ok(indexEntry(ok('a', { t: undefined }), '2026-11-01T00:00:00Z').entry, '构建脚本另外查到的时间也行')
  const { entry } = indexEntry(ok('dsh-a'))
  assert.deepEqual(entry.versions, [{ version: '1.2.3', publishTimestamp: Math.floor(Date.parse('2026-11-01T08:00:00.000Z') / 1000), source: { type: 'npm' }, engines: { dsh: '>=0.2.0-0' } }])
  assert.deepEqual(entry['dist-tags'], { latest: '1.2.3' })
  assert.deepEqual(entry.repository, { url: 'https://github.com/x/dsh-a' })
  assert.deepEqual(entry.metadata, { category: 'memory', keywords: ['memory'], sortKeys: { downloads: 100, baseline: 9, stars: 5, health: 70 } })
  assert.equal(entry.author, 'Li')
})

test('buildMarketIndex：过官方校验器，不合规的单条剔除，整份照样合格', () => {
  const catalog = { packages: {
    'dsh-a': ok('dsh-a', { w: 5 }),
    'dsh-b': ok('dsh-b', { w: 50 }),
    'Dsh-Upper': ok('Dsh-Upper'), // 新包名不许大写：校验器拒收
    'dsh-bad-range': ok('dsh-bad-range', { inst: { b: true, e: 'not a range' } }),
    'dsh-none': ok('dsh-none', { inst: { b: true } }),
  } }
  const { index, skipped, rejected } = buildMarketIndex(catalog, { parse: parseMarketIndex })
  assert.deepEqual(index.plugins.map(p => p.name), ['dsh-b', 'dsh-a']) // 按周下载排
  assert.deepEqual(rejected.map(r => r.name).sort(), ['Dsh-Upper', 'dsh-bad-range'])
  assert.deepEqual(skipped, { '没声明 engines.dsh': 1 })
  assert.doesNotThrow(() => parseMarketIndex(index, INDEX_URL))
})

function fakeMarket(initial = []) {
  const m = { urls: [...initial], sets: 0 }
  m.listIndexes = async () => m.urls.map(url => ({ url, title: 'x' }))
  m.setIndexes = async urls => { m.sets++; m.urls = [...urls] }
  return m
}

test('ensureMarketSource：自动加一次；用户删掉后不再自动加；按钮照样能加', async () => {
  const env = { DSH_HOME: await tempHome() }
  const m = fakeMarket(['https://other.example/index.json'])
  assert.equal((await ensureMarketSource(m, { env })).status, 'added')
  assert.deepEqual(m.urls, ['https://other.example/index.json', INDEX_URL]) // 别人的源保留
  assert.equal((await ensureMarketSource(m, { env })).status, 'present')
  m.urls = ['https://other.example/index.json'] // 用户在「发现」里删掉了
  assert.equal((await ensureMarketSource(m, { env })).status, 'skipped')
  assert.equal(m.urls.length, 1)
  assert.equal((await ensureMarketSource(m, { env, force: true })).status, 'added')
  assert.deepEqual(await marketStatus(m), { available: true, added: true, url: INDEX_URL })
})

test('ensureMarketSource：没有这个服务、或出错时说清楚，不抛', async () => {
  const env = { DSH_HOME: await tempHome() }
  assert.equal((await ensureMarketSource(undefined, { env })).status, 'unavailable')
  assert.equal((await marketStatus(undefined)).available, false)
  const broken = fakeMarket()
  broken.setIndexes = async () => { throw new Error('plugin-market/settings-unavailable') }
  const r = await ensureMarketSource(broken, { env })
  assert.equal(r.status, 'failed')
  assert.match(r.message, /settings-unavailable/)
})
