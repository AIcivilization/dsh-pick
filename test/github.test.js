import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRepo, fetchRepos, fetchRepoLive } from '../lib/github.js'
import { baselineWithStart, growth, sum } from '../lib/metrics.js'
import { fakeFetch } from './fixtures.js'

test('parseRepo：各种写法的仓库地址', () => {
  assert.equal(parseRepo('git+https://github.com/MichengAI/dsh-archive-manager.git'), 'MichengAI/dsh-archive-manager')
  assert.equal(parseRepo('https://github.com/a/b/tree/main/packages/x'), 'a/b')
  assert.equal(parseRepo('git@github.com:a/b.git'), 'a/b')
  assert.equal(parseRepo('https://gitlab.com/a/b'), null)
  assert.equal(parseRepo(''), null)
})

test('fetchRepos：GraphQL 批量查，查不到的跳过，没令牌不查', async () => {
  assert.equal((await fetchRepos(['a/b'], {})).size, 0)
  let body = null
  const fetchImpl = async (url, opt) => {
    body = JSON.parse(opt.body)
    assert.match(opt.headers.authorization, /^bearer t0ken$/)
    return new Response(JSON.stringify({
      data: {
        r0: { stargazerCount: 7, forkCount: 2, isArchived: false, pushedAt: '2026-10-20T01:02:03Z', licenseInfo: { spdxId: 'MIT' }, issues: { totalCount: 1 }, pullRequests: { totalCount: 2 } },
        r1: null, // 删了 / 私有
      },
    }))
  }
  const m = await fetchRepos(['Demo/One', 'demo/one', 'gone/repo'], { token: 't0ken', fetchImpl })
  assert.equal((body.query.match(/repository\(/g) || []).length, 2) // 同一个仓库（大小写不同）只查一次
  assert.deepEqual(m.get('demo/one'), { repo: 'Demo/One', s: 7, f: 2, i: 3, p: '2026-10-20', a: false, l: 'MIT' })
  assert.equal(m.has('gone/repo'), false)
})

test('fetchRepoLive：实时查；被限流时说清楚', async () => {
  const ok = fakeFetch({ 'repos/a/b': { full_name: 'a/b', stargazers_count: 5, forks_count: 1, open_issues_count: 4, pushed_at: '2026-10-21T00:00:00Z', archived: true, license: { spdx_id: 'NOASSERTION' } } })
  assert.deepEqual(await fetchRepoLive('a/b', { fetchImpl: ok }), { repo: 'a/b', s: 5, f: 1, i: 4, p: '2026-10-21', a: true, l: null })
  assert.equal(await fetchRepoLive('x/y', { fetchImpl: fakeFetch({}) }), null)
  await assert.rejects(fetchRepoLive('a/b', { fetchImpl: fakeFetch({ 'repos/a/b': 403 }) }), e => e.code === 'rate-limited')
})

test('npm 缺数据的日子（null）不参与基线和环比', () => {
  const full = Array(14).fill(100)
  const holes = [...full.slice(0, 5), null, null, null, ...full.slice(5)]
  assert.equal(baselineWithStart(holes), 100) // 当成 0 的话中位数会被拉低
  assert.equal(growth(holes), 0) // 当成 0 的话会算出凭空的涨跌
  assert.equal(growth([...Array(10).fill(100), null, null, null, null]), null) // 有效天数不够 14 天就不算
  assert.equal(sum([1, null, 2]), 3)
})

test('仓库填成 DSH 本体的，星标不算在插件头上', async () => {
  const { countsForPlugin } = await import('../lib/github.js')
  assert.equal(countsForPlugin('dsh-ab-memory', 'deepseek-ai/deepseek-harness'), false)
  assert.equal(countsForPlugin('@deepseek-ai/dsh-base', 'deepseek-ai/deepseek-harness'), true)
  assert.equal(countsForPlugin('dshmarket', 'dsh-market/dsh-market'), true)
  assert.equal(countsForPlugin('x', null), false)
})

test('按 GitHub 排行：一个仓库只留一行', async () => {
  const { rank } = await import('../lib/engine.js')
  const gh = { repo: 'a/mono', s: 50, p: '2026-10-01' }
  const cat = { packages: {
    p1: { n: 'p1', w: 10, gh }, p2: { n: 'p2', w: 99, gh }, p3: { n: 'p3', w: 1, gh: { repo: 'b/solo', s: 5, p: '2026-10-02' } },
  } }
  assert.deepEqual(rank(cat, { metric: 'stars' }).map(r => r.n), ['p2', 'p3'])
})
