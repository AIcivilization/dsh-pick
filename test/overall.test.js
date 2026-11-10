// 综合榜：几个插件市场合成一个榜
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOverall, percentiles, spread, maintScore, MARKETS } from '../lib/overall.js'
import { picksMembers } from '../lib/boards.js'

const NOW = Date.parse('2026-11-10T00:00:00Z')
const pkg = (n, extra = {}) => ({ n, v: '1.0.0', w: 1000, cat: '其他', repo: `https://github.com/x/${n}`, inst: { b: true, p: 'web' }, t: '2026-11-01T00:00:00Z', ...extra })

test('percentiles / spread / maintScore', () => {
  assert.deepEqual(percentiles([0, 5, 1, 5, 9]), [0, 0.5, 0, 0.5, 1])
  const sp = spread([0, 1, 2, 4])
  assert.equal(sp[0], 0)
  assert.equal(sp[3], 1) // 最大的：百分位 1、比例 1
  assert.ok(sp[2] > sp[1])
  assert.equal(maintScore(['2026-11-10'], NOW), 1)
  assert.equal(maintScore(['2026-01-01', null], NOW), 0) // 半年以上
  assert.equal(maintScore([null], NOW), null)
})

test('合并去重：npm 包按名字、只在 GitHub 的按仓库；GitHub 条目发了 npm 的并到 npm 那条', () => {
  const packages = { a: pkg('a', { w: 5000, gh: { repo: 'x/a', s: 50 } }), b: pkg('b') }
  const members = {
    community: [{ n: 'a', repo: null, name: 'a' }, { n: null, repo: 'https://github.com/x/a', name: 'a-gh' }, { n: null, repo: 'https://github.com/y/only', name: 'only', s: 30, added: '2026-10-01' }],
    shop: [{ n: 'a', repo: 'https://github.com/x/a', name: 'a' }, { n: null, repo: 'https://github.com/Y/Only', name: 'only' }],
    picks: [{ n: 'b', repo: null, name: 'b' }],
    official: [],
  }
  const o = buildOverall({ packages, members, now: NOW })
  assert.equal(o.total, 3) // a、b、y/only
  const a = o.rows.find(r => r.k === 'a')
  assert.deepEqual(a.src.sort(), ['dshmarket', 'shop'])
  const only = o.rows.find(r => r.k === 'gh:y/only')
  assert.deepEqual(only.src.sort(), ['dshmarket', 'shop'], '仓库名大小写不同也算同一个')
  assert.equal(only.p[0], 0, '没有下载数据，使用项是 0')
  assert.equal(only.s, 30)
  assert.equal(only.repo, 'https://github.com/y/only')
  // 写回 npm 记录：综合分和「收录于」
  assert.equal(packages.a.sc, a.sc)
  assert.deepEqual(packages.b.src, ['dsh-m'])
  assert.ok(o.rows[0].k === 'a', '下载多、星标多、两个市场收录的排第一')
})

test('一票否决：归档、没 bundle、终端版不进榜', () => {
  const packages = {
    ok: pkg('ok'),
    arch: pkg('arch', { gh: { repo: 'x/arch', s: 9999, a: true } }),
    nob: pkg('nob', { inst: { b: false } }),
    tui: pkg('tui', { inst: { b: true, p: 'tui' } }),
  }
  const o = buildOverall({ packages, members: {}, now: NOW })
  assert.deepEqual(o.rows.map(r => r.k), ['ok'])
  assert.deepEqual(o.excluded, { '仓库已归档': 1, '没声明 dsh.bundle': 1, '终端版插件': 1 })
})

test('官方插件不在目录里也进榜，带着名字、版本、下载量；别的市场收了它也算', () => {
  const packages = { a: pkg('a') }
  const members = {
    official: [{ n: '@deepseek-ai/x', repo: null, name: '@deepseek-ai/x', w: 500, v: '0.2.0', d: '官方的', t: '2026-11-09T00:00:00Z' }],
    shop: [{ n: '@deepseek-ai/x', repo: null, name: '@deepseek-ai/x' }],
    community: [], picks: [],
  }
  const o = buildOverall({ packages, members, now: NOW })
  const x = o.rows.find(r => r.k === '@deepseek-ai/x')
  assert.deepEqual(x.src.sort(), ['official', 'shop'])
  assert.deepEqual([x.name, x.v, x.d, x.w], ['@deepseek-ai/x', '0.2.0', '官方的', 500])
  assert.equal(packages['@deepseek-ai/x'], undefined, '不往目录里塞记录')
})

test('某个市场这次抓不到：沿用上次的「收录于」', () => {
  const packages = { a: pkg('a') }
  const o = buildOverall({ packages, members: { community: null, shop: [], picks: [], official: [] }, previousSrc: { a: ['dshmarket', 'shop'] }, now: NOW })
  assert.deepEqual(o.rows[0].src, ['dshmarket'], '抓不到的 dshmarket 沿用；抓到了的商店按这次的')
  assert.equal(MARKETS.length, 4)
})

test('dsh-m 精选：作者自己那个区不算推荐', () => {
  const rows = picksMembers({ plugins: [
    { id: 'mine', npm: 'mine', github: 'me/mine', category: 'self-dev' },
    { id: 'mine-too', npm: 'mine-too', github: 'me/mine-too', category: 'self-dev', alsoCategories: ['essentials'] },
    { id: 'theirs', npm: 'theirs', github: 'you/theirs', category: 'essentials' },
    { id: 'bad', npm: '../x', github: 'not a repo', category: 'essentials' },
  ] })
  assert.deepEqual(rows.map(r => r.n), ['mine-too', 'theirs'])
})
