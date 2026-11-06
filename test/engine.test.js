import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expandWords } from '../lib/words.js'
import { installFacts, newerCatalog, loadCatalog, reloadCatalog, cachePath, searchByNeed, rank, addCommunity, communityRecord, slimRecord, normalize, weeklyDue, WEEKLY_ROTATION } from '../lib/engine.js'
import { communityPackages } from '../lib/boards.js'
import { makeCatalog, tempHome, fakeFetch } from './fixtures.js'

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
  assert.deepEqual(installFacts({}), { b: false, p: null, r: null, e: null, a: null })
  assert.deepEqual(
    installFacts({
      dsh: { bundle: { patch: './x.yml' }, client: { platform: 'web' } },
      peerDependencies: { '@deepseek-ai/cordis': '^4.0.1', '@deepseek-ai/dsh-settings': '^0.2.0-rc.1' },
    }),
    { b: true, p: 'web', r: '^0.2.0-rc.1', e: null, a: null },
  )
  // e 只认顶层 engines.dsh、原样保留；a 只留作者名
  assert.equal(installFacts({ engines: { dsh: '>=0.2.0-0 ' } }).e, '>=0.2.0-0 ')
  assert.equal(installFacts({ dsh: { engines: { dsh: '^0.2.0' } } }).e, null)
  assert.equal(installFacts({ author: 'Wang Fei <a@b.c> (https://x)' }).a, 'Wang Fei')
  assert.equal(installFacts({ author: { name: 'Li', email: 'x' } }).a, 'Li')
  assert.equal(installFacts({ author: { email: 'x' } }).a, null)
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

test('communityRecord：manifest 要和包名对得上，外部字段校验类型', () => {
  const row = { n: 'dsh-a', m: 90, repo: 'https://github.com/x/dsh-a' }
  assert.equal(communityRecord(row, null), null)
  assert.equal(communityRecord(row, { name: 'dsh-other' }), null, '名字对不上（比如 .. 请求到了 registry 根）')

  const rec = communityRecord(row, {
    name: 'dsh-a', version: '1.2.3', description: 'x'.repeat(300), keywords: ['memory', 7],
    homepage: 'javascript:alert(1)', repository: { url: 'git+https://github.com/evil/other.git' },
    dsh: { bundle: {}, client: { platform: 'web' } },
  })
  assert.equal(rec.d.length, 160)
  assert.deepEqual(rec.kw, ['memory'])
  assert.equal(rec.home, '')
  assert.equal(rec.repo, 'https://github.com/x/dsh-a', '社区目录校验过的仓库优先')
  assert.deepEqual(rec.inst, { b: true, p: 'web', r: null, e: null, a: null })
  assert.equal(rec.m, 90)

  // 字段类型不对也不能崩
  const odd = communityRecord({ n: 'dsh-a', m: null, repo: null }, { name: 'dsh-a', description: 1, keywords: 'memory', repository: 'https://github.com/x/y' })
  assert.deepEqual([odd.v, odd.d, odd.kw, odd.m, odd.repo], ['', '', [], 0, 'https://github.com/x/y'])
})

test('addCommunity：补进 npm 上有的包，搜索翻到的不动，查不到的不收', async t => {
  const manifest = name => ({ name, version: '1.0.0', description: `about ${name}`, keywords: ['dsh-plugin', 'memory'], dsh: { bundle: {} } })
  const fake = fakeFetch({
    'downloads/point/last-week/dsh-b,dsh-c': { 'dsh-b': { downloads: 70 }, 'dsh-c': null },
    'downloads/point/last-week/dsh-c': 404,
    'downloads/point/last-week/@s%2fdsh-d': { downloads: 500 },
    'downloads/point/last-week/@s%2fdsh-e': { downloads: 8 },
    'registry.npmjs.org/@s%2fdsh-e/latest': manifest('@s/dsh-e'),
    'registry.npmjs.org/dsh-b/latest': manifest('dsh-b'),
    'registry.npmjs.org/dsh-c/latest': manifest('dsh-c'),
    'registry.npmjs.org/@s%2fdsh-d/latest': manifest('@s/dsh-d'),
    'registry.npmjs.org/dsh-gone/latest': 404,
  })
  t.mock.method(globalThis, 'fetch', fake)

  const kept = { n: 'dsh-a', w: 5, m: 6 }
  const records = new Map([['dsh-a', kept]])
  const rows = ['dsh-a', 'dsh-b', 'dsh-c', '@s/dsh-d', '@s/dsh-e', 'dsh-gone'].map(n => ({ n, m: 300, repo: null }))
  // @s/dsh-d 上次没有数，必查；@s/dsh-e 上次有数，查不查看今天轮没轮到
  const today = ['2026-11-01', '2026-11-02', '2026-11-03'].find(d => !weeklyDue('@s/dsh-e', d))
  const added = await addCommunity(records, rows, { previous: { 'dsh-c': { w: 33 }, '@s/dsh-e': { w: 6 } }, today })

  assert.equal(added, 4)
  assert.deepEqual([...records.keys()].sort(), ['@s/dsh-d', '@s/dsh-e', 'dsh-a', 'dsh-b', 'dsh-c'])
  assert.equal(records.get('dsh-a'), kept, '搜索接口已有的不覆盖')
  assert.ok(!fake.calls.some(u => u.includes('dsh-a')), '已有的不多花请求')
  assert.equal(records.get('dsh-b').w, 70)
  assert.equal(records.get('@s/dsh-d').w, 500)
  assert.equal(records.get('@s/dsh-e').w, 6, '没轮到的带 scope 包沿用上次的')
  assert.ok(!fake.calls.some(u => u.includes('last-week/@s%2fdsh-e')), '没轮到就不花请求')
  assert.equal(records.get('@s/dsh-d').m, 500, '月下载不会比周下载少')
  assert.equal(records.get('dsh-c').w, 33, '查不到周下载就沿用上次的')

  // 补进来的包搜索和 npm 榜都能找到
  reloadCatalog({ anchor: '2026-10-13', packages: Object.fromEntries(records) })
  const cat = await loadCatalog()
  assert.ok(searchByNeed(cat, 'memory').some(r => r.name === '@s/dsh-d'))
  assert.equal(rank(cat, { limit: 1 })[0].n, '@s/dsh-d')
  reloadCatalog(null)
})

test('weeklyDue：带 scope 的包每 WEEKLY_ROTATION 天正好轮到一次', () => {
  const days = Array.from({ length: WEEKLY_ROTATION * 2 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`)
  for (const name of ['@a/x', '@b/dsh-yy', '@michengai/dsh-pua']) {
    assert.equal(days.filter(d => weeklyDue(name, d)).length, 2, name)
  }
})

test('slimRecord：只去掉读的一方用不上的', () => {
  const rec = slimRecord({
    n: 'a', pub: '2026-01-01', rel: ['2026-01-01'],
    home: 'https://github.com/x/a#readme', repo: 'git+https://github.com/x/a.git',
    kw: ['dsh-plugin', 'DeepSeek-Harness', 'memory', ...Array.from({ length: 20 }, (_, i) => `k${i}`)],
    inst: { b: true, p: null, r: null },
    gh: { repo: 'x/a', s: 1, a: false, l: null },
  })
  assert.deepEqual(rec, {
    n: 'a',
    repo: 'https://github.com/x/a',
    kw: ['memory', ...Array.from({ length: 11 }, (_, i) => `k${i}`)],
    inst: { b: true },
    gh: { repo: 'x/a', s: 1 },
  })
  // 仓库不是 GitHub，或写法不是 https：主页还要用来找 GitHub 地址，不能丢
  assert.equal(slimRecord({ n: 'a', home: 'https://github.com/x/a', repo: 'https://gitlab.com/x/a' }).home, 'https://github.com/x/a')
  assert.equal(slimRecord({ n: 'a', home: 'https://github.com/x/a', repo: 'git+ssh://git@github.com/x/a.git' }).home, 'https://github.com/x/a')
  // 有用的值原样留着
  const kept = slimRecord({ n: 'a', inst: { b: false, p: 'tui', r: '^1' }, gh: { repo: 'x/a', a: true, l: 'MIT' } })
  assert.deepEqual([kept.inst, kept.gh], [{ b: false, p: 'tui', r: '^1' }, { repo: 'x/a', a: true, l: 'MIT' }])
  // 瘦身后的记录归一化照常出 GitHub 地址
  const cat = normalize({ packages: { a: slimRecord({ n: 'a', home: 'https://github.com/x/a', repo: 'git+https://github.com/x/a.git' }) } })
  assert.equal(cat.packages.a.ghUrl, 'https://github.com/x/a')
})

test('communityPackages：包名不合法的不要，重复的只留一个', () => {
  const rows = communityPackages({ plugins: [
    { npm: 'dsh-a', downloads: 9, url: 'https://github.com/x/a/tree/main/pkg' },
    { npm: 'dsh-a', downloads: 1 },
    { npm: '../../etc/passwd' }, { npm: 'a b' }, { npm: 'a,b' }, { npm: 'a?x=1' }, { npm: 7 }, { npm: null }, null,
    { npm: '@s/dsh-b', downloads: -1, url: 'javascript:alert(1)' },
  ] })
  assert.deepEqual(rows, [
    { n: 'dsh-a', m: 9, repo: 'https://github.com/x/a' },
    { n: '@s/dsh-b', m: null, repo: null },
  ])
  assert.deepEqual(communityPackages(null), [])
  assert.deepEqual(communityPackages({ plugins: 'x' }), [])
})
