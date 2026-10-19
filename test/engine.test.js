import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expandWords } from '../lib/words.js'
import { installFacts, newerCatalog, loadCatalog, reloadCatalog, cachePath, searchByNeed, rank } from '../lib/engine.js'
import { makeCatalog, tempHome } from './fixtures.js'

const strong = need => expandWords(need).filter(t => t.weight >= 2).map(t => t.w)

test('整句需求：去掉口头词，认出藏在句子里的词典词', () => {
  assert.ok(strong('我想装个数据库').includes('数据库'))
  assert.ok(strong('我想装个数据库').includes('database'))
  assert.ok(strong('有没有好用的记忆插件').includes('memory'))
  assert.ok(strong('任务完成时给我发微信通知').includes('wechat'))
  assert.ok(!strong('我想装个数据库').includes('我想'))
})

test('同一个词只留最高权重', () => {
  const words = expandWords('数据库 数据库管理').map(t => t.w)
  assert.equal(words.length, new Set(words).size)
})

test('installFacts：bundle、平台、DSH 版本要求', () => {
  assert.deepEqual(installFacts({}), { b: false, p: null, r: null })
  assert.deepEqual(
    installFacts({
      dsh: { bundle: { patch: './x.yml' }, client: { platform: 'web' } },
      peerDependencies: { '@deepseek-ai/cordis': '^4.0.1', '@deepseek-ai/dsh-settings': '^0.2.0-rc.1' },
    }),
    { b: true, p: 'web', r: '^0.2.0-rc.1' },
  )
  // engines.dsh 与 dsh.engines.dsh 都认；重复的要求只写一次
  assert.equal(installFacts({ engines: { dsh: '>=0.2.0' }, peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' } }).r, '>=0.2.0')
  assert.equal(installFacts({ dsh: { engines: { dsh: '^0.2.0' } } }).r, '^0.2.0')
})

test('newerCatalog：先比统计截止日，再比构建日', () => {
  const a = { anchor: '2026-10-14', asOf: '2026-10-19', packages: {} }
  const b = { anchor: '2026-10-13', asOf: '2026-10-19', packages: {} }
  assert.equal(newerCatalog(a, b), true)
  assert.equal(newerCatalog(b, a), false)
  assert.equal(newerCatalog({ ...b, asOf: '2026-10-20' }, b), true)
  assert.equal(newerCatalog(a, null), true)
  assert.equal(newerCatalog(null, a), false)
})

test('loadCatalog：每日更新的那份更新就用它，否则用随包自带的', async () => {
  const home = await tempHome()
  const env = { DSH_HOME: home }
  await mkdir(dirname(cachePath(env)), { recursive: true })

  await writeFile(cachePath(env), JSON.stringify(makeCatalog({ anchor: '2099-01-01' })))
  reloadCatalog(null)
  const fresh = await loadCatalog({ env })
  assert.equal(fresh.source, 'remote')
  assert.equal(fresh.anchor, '2099-01-01')

  await writeFile(cachePath(env), JSON.stringify(makeCatalog({ anchor: '2000-01-01' })))
  reloadCatalog(null)
  const bundled = await loadCatalog({ env })
  assert.equal(bundled.source, 'bundled')
  reloadCatalog(null)
})

test('归一化：补上排名与 npm 链接', () => {
  reloadCatalog(makeCatalog())
  return loadCatalog().then(cat => {
    assert.equal(cat.packages['dsh-mnemon'].rank, 1)
    assert.equal(cat.packages['dsh-mnemon'].crank, 1)
    assert.match(cat.packages['dsh-sql'].npmUrl, /npmjs\.com\/package\/dsh-sql$/)
  })
})

test('searchByNeed / rank', async () => {
  reloadCatalog(makeCatalog())
  const cat = await loadCatalog()
  const names = searchByNeed(cat, '我想装个数据库', { limit: 3 }).map(r => r.name)
  assert.deepEqual(names.slice(0, 2).sort(), ['dsh-database-explorer', 'dsh-sql'])
  assert.equal(rank(cat, { metric: 'score', limit: 1 })[0].n, 'meow-memory')
  assert.equal(rank(cat, { metric: 'baseline', limit: 1 })[0].n, 'dsh-mnemon')
  assert.ok(rank(cat, { category: '记忆与上下文' }).every(r => r.cat === '记忆与上下文'))
})
