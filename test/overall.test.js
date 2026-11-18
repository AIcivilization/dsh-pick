// 综合榜：几个插件市场合成一个榜
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOverall, percentiles, spread, maintScore, stableScore, MARKETS, ANGLES } from '../lib/overall.js'
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
  assert.equal(maintScore(['2026-09-20'], NOW), 1, '60 天内都算还在维护，不按发版频率加分')
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

test('稳定分：上架久、节奏平稳、有许可证、问题少的高', () => {
  const good = stableScore({ firstDays: 200, cadence: 7, license: true, issues: 1, stars: 100 })
  const churn = stableScore({ firstDays: 200, cadence: 0.2, license: true, issues: 1, stars: 100 })
  const fresh = stableScore({ firstDays: 5, cadence: 7, license: true, issues: 1, stars: 100 })
  assert.ok(good > churn, '发得太勤扣分')
  assert.ok(good > fresh, '刚上架扣分')
  assert.ok(good > 0.9)
})

test('六个角度：各自的分数；不参与的为 null；每个角度的前几名都会存下来', () => {
  const deep = (base, growth) => ({ base, growth, cadence: 5, lastRelease: '2026-11-01', s: 70 })
  const packages = {
    old: pkg('old', { w: 9000, deep: deep(900, 0.1), gh: { repo: 'x/old', s: 500, l: 'MIT', i: 2 } }),
    hot: pkg('hot', { w: 3000, deep: deep(200, 3) }),
    tiny: pkg('tiny', { w: 10 }),
  }
  const members = {
    community: [{ n: 'old', added: '2026-01-01' }, { n: 'hot', added: '2026-08-01' }, { n: 'tiny', added: '2026-11-08' }],
    picks: [{ n: 'old' }], shop: [], official: [],
  }
  const o = buildOverall({ packages, members, now: NOW })
  assert.deepEqual(o.angles, ANGLES)
  const by = Object.fromEntries(o.rows.map(r => [r.k, r]))
  assert.equal(by.tiny.a.use, null, '没有去噪数据不参与「最多人用」')
  assert.equal(by.tiny.a.stable, null, '上架不满 60 天不参与「稳定可靠」')
  assert.ok(by.tiny.a.new != null, '30 天内收录的进「新上架」')
  assert.equal(by.old.a.new, null)
  assert.ok(by.hot.a.rise > by.old.a.rise, '增速快的在「上升最快」靠前')
  assert.ok(by.old.a.rep > 0, '有星标、被精选的有口碑分')
  assert.equal(by.tiny.a.rep, null, '没有星标也没被精选的不参与「口碑」')
  assert.equal(by.hot.g, 3)
  assert.equal(by.tiny.added, '2026-11-08')
  assert.equal(by.old.p[3], 100, '被 dsh-m 精选：精选项满分')
})

test('每个参与排名的 npm 包都带六个角度的分数（rec.oa）：面板按分类筛、算名次都在全部插件里排', () => {
  const packages = { ok: pkg('ok', { w: 50 }), tiny: pkg('tiny', { w: 3 }), arch: pkg('arch', { gh: { repo: 'x/arch', s: 1, a: true } }) }
  const members = { community: [{ n: 'tiny', added: '2026-11-08' }], picks: [], shop: [], official: [] }
  const o = buildOverall({ packages, members, now: NOW })
  assert.equal(packages.ok.oa.length, ANGLES.length)
  assert.equal(packages.ok.oa[0], packages.ok.sc, '第一个是综合推荐')
  const row = o.rows.find(r => r.k === 'tiny')
  assert.deepEqual(packages.tiny.oa, ANGLES.map(k => row.a[k]))
  assert.equal(packages.tiny.ad, '2026-11-08')
  assert.equal(packages.arch.oa, undefined, '不进榜的不带')
})

test('覆盖数：几个市场 + npm 去重；市场里有、目录还没补进来的 npm 包也算，暂时不排名', () => {
  const packages = { a: pkg('a'), b: pkg('b') }
  const members = {
    community: [{ n: 'a' }, { n: null, repo: 'https://github.com/y/gh-only', name: 'gh-only' }, { n: 'not-yet' }],
    shop: [{ n: 'a' }, { n: 'b' }, { n: 'not-yet' }, { n: null, repo: 'https://github.com/y/gh-only', name: 'gh-only' }],
    picks: [], official: [],
  }
  const o = buildOverall({ packages, members, now: NOW })
  assert.deepEqual(o.cover, { all: 4, npm: 3, gh: 1, pending: 1, markets: { dshmarket: 3, 'dsh-m': 0, shop: 4, official: 0 } })
  assert.ok(!o.rows.some(r => r.k === 'not-yet'))
})
