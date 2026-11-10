import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildToolDefinitions, annotate } from '../plugin/tools.js'
import { reloadCatalog, loadCatalog } from '../lib/engine.js'
import { makeCatalog } from './fixtures.js'

reloadCatalog(makeCatalog())
const defs = await buildToolDefinitions({ installed: () => new Set(['dsh-mnemon', 'dsh-pick']) })
const tool = Object.fromEntries(defs.map(d => [d.name, d]))
const text = (name, args, v) => tool[name].output.render(args, v)[0].text

test('注册了 4 个工具', () => {
  assert.deepEqual(Object.keys(tool).sort(), ['pick_compare', 'pick_rank', 'pick_search', 'pick_stats'])
})

test('pick_search：结果是纯 JSON，带口径说明', async () => {
  const args = { need: '我想装个数据库', limit: 3 }
  const v = await tool.pick_search.execute(args, {})
  assert.deepEqual(JSON.parse(JSON.stringify(v)), v)
  assert.deepEqual(v.candidates.slice(0, 2).map(c => c.name).sort(), ['dsh-database-explorer', 'dsh-sql'])
  const t = text('pick_search', args, v)
  assert.match(t, /不要自己推算/)
  assert.match(t, /声明需要 DSH \^0\.2\.0-rc\.1/)
})

test('提醒：装不了、终端版、已装同类', async () => {
  const cat = await loadCatalog()
  const rows = annotate(
    ['dsh-no-bundle', 'dsh-tui-memory', 'meow-memory', 'dsh-mnemon'].map(name => ({ name })),
    cat,
    new Set(['dsh-mnemon', 'dsh-pick']),
  )
  const by = Object.fromEntries(rows.map(r => [r.name, r]))
  assert.match(by['dsh-no-bundle'].notes.join(), /dsh\.bundle/)
  assert.match(by['dsh-tui-memory'].notes.join(), /tui 客户端插件/)
  assert.match(by['meow-memory'].notes.join(), /已装了同类插件：dsh-mnemon/)
  // 自己已经装了：不提示「同类」，标「已安装」
  assert.equal(by['dsh-mnemon'].installed, true)
  assert.deepEqual(by['dsh-mnemon'].notes, [])
})

test('pick_compare：逐项最好、按健康度排序、至少两个', async () => {
  const v = await tool.pick_compare.execute({ names: ['dsh-mnemon', 'meow-memory'] }, {})
  assert.equal(v.rows[0].name, 'meow-memory') // 健康度 79 > 77
  assert.equal(v.best.find(b => b.label.startsWith('日常基线')).winner, 'dsh-mnemon')
  await assert.rejects(tool.pick_compare.execute({ names: ['dsh-mnemon'] }, {}), /至少要两个/)
  await assert.rejects(tool.pick_compare.execute({ names: ['../../etc', 'x y'] }, {}), /至少要两个/)
})

test('pick_rank：默认按日常基线，分类过滤', async () => {
  const v = await tool.pick_rank.execute({ category: '记忆与上下文', limit: 2 }, {})
  assert.equal(v.metric, 'baseline')
  assert.deepEqual(v.rows.map(r => r.name), ['dsh-mnemon', 'meow-memory'])
  assert.match(text('pick_rank', {}, v), /^目录数据截止 2026-10-13/)
})

test('pick_stats：目录里有去噪指标的直接用，不联网', async () => {
  const v = await tool.pick_stats.execute({ names: ['dsh-mnemon'] }, {})
  assert.equal(v.rows[0].source, 'catalog')
  assert.equal(v.rows[0].installed, true)
})

test('GitHub：排行按星标、提交时间；结果里带 GitHub 数据和「已归档」提醒', async () => {
  const stars = await tool.pick_rank.execute({ metric: 'stars', limit: 2 }, {})
  assert.deepEqual(stars.rows.map(r => r.name), ['meow-memory', 'dsh-mnemon'])
  const pushed = await tool.pick_rank.execute({ metric: 'pushed', limit: 1 }, {})
  assert.equal(pushed.rows[0].name, 'dsh-mnemon')
  const t = text('pick_rank', {}, stars)
  assert.match(t, /GitHub ★480 · Fork 30/)
  assert.match(t, /仓库已归档/)
})

test('pick_rank 看别的榜单；installed 可以是异步的', async () => {
  const { makeCatalog: mk } = await import('./fixtures.js')
  const cat = mk()
  cat.boards = { community: { total: 2, rows: [{ n: 'a', name: 'a', s: 1, dl: 50 }, { n: null, name: 'b', repo: 'https://github.com/x/b', s: 9 }] } }
  reloadCatalog(cat)
  const v = await tool.pick_rank.execute({ board: 'community', metric: 'stars' }, {})
  const t = text('pick_rank', {}, v)
  assert.match(t, /社区目录（共 2 个）/)
  assert.match(t, /^1\. b · ★9/m)
  assert.match(t, /只在 GitHub/)
  const none = await tool.pick_rank.execute({ board: 'official' }, {})
  assert.match(none.board, /还没有/)

  const defs2 = await buildToolDefinitions({ installed: async () => new Set(['dsh-mnemon']) })
  const stats = defs2.find(d => d.name === 'pick_stats')
  assert.equal((await stats.execute({ names: ['dsh-mnemon'] }, {})).rows[0].installed, true)
})

test('pick_rank 看综合榜', async () => {
  const { makeCatalog: mk } = await import('./fixtures.js')
  const cat = mk()
  cat.boards = { overall: { total: 2, weights: { use: 40, stars: 20, maint: 20, consensus: 10, health: 10 }, rows: [
    { k: 'dsh-mnemon', n: 'dsh-mnemon', sc: 88, p: [90, 80, 97, 50, 77], src: ['dshmarket', 'shop'], s: 120 },
    { k: 'gh:y/only', n: null, name: 'only', repo: 'https://github.com/y/only', sc: 40, p: [0, 60, 40, 25, 40], src: ['dshmarket'] },
  ] } }
  reloadCatalog(cat)
  const v = await tool.pick_rank.execute({ board: 'overall' }, {})
  const t = text('pick_rank', {}, v)
  assert.match(t, /综合榜（2 个插件参与排名/)
  assert.match(t, /^1\. dsh-mnemon · 综合分 88/m)
  assert.match(t, /收录于 dshmarket、dsh-plugin-shop/)
  assert.match(t, /（已安装）/)
  assert.match(t, /只在 GitHub（https:\/\/github.com\/y\/only）/)
})
