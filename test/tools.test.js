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
