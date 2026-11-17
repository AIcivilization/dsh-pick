// AI 精选：用一个假的大模型测流程（查全 → 挑准）、核对包名、出错时说清楚
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aiPick, extractJson, recall, callModel } from '../lib/ai-pick.js'
import { reloadCatalog, loadCatalog } from '../lib/engine.js'
import { makeCatalog } from './fixtures.js'

/** 假模型：按调用顺序依次给出回答；记下每次收到的提示 */
function fakeLlm(answers) {
  const calls = []
  return {
    calls,
    llm: {
      async * stream(opt) {
        calls.push(opt)
        const text = answers[calls.length - 1] ?? ''
        if (text instanceof Error) { yield { type: 'finish', reason: { kind: 'error', failure: { message: text.message } } }; return }
        for (const part of [text.slice(0, 5), text.slice(5)]) yield { type: 'text-delta', text: part }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm-1' }) },
  }
}

test('extractJson：前后有说明文字或代码块也能取出来', () => {
  assert.deepEqual(extractJson('好的：\n```json\n{"a":[1,{"b":"}"}]}\n```'), { a: [1, { b: '}' }] })
  assert.equal(extractJson('没有 JSON'), null)
  assert.equal(extractJson('{坏的'), null)
})

test('recall：原话和模型给的关键字都去搜，合并去重', async () => {
  reloadCatalog(makeCatalog())
  const cat = await loadCatalog()
  const names = recall(cat, '想让它记住以前聊过的', ['memory', 'context']).map(r => r.n)
  assert.ok(names.includes('dsh-mnemon') && names.includes('meow-memory'))
  assert.equal(names.length, new Set(names).size)
})

test('aiPick：两步调用；只收候选里有的包名；理由、合适度规整好', async () => {
  reloadCatalog(makeCatalog())
  const cat = await loadCatalog()
  const f = fakeLlm([
    '{"keywords":["memory","记忆"]}',
    '```json\n{"picks":[{"name":"meow-memory","fit":120,"reason":"跨会话记忆，正是你要的"},{"name":"made-up-plugin","fit":90,"reason":"编的"},{"name":"dsh-mnemon","fit":70,"reason":"可组合的记忆","caveat":"配置稍复杂"}],"note":"记忆类首选 meow-memory"}\n```',
  ])
  const r = await aiPick({ need: '让 DSH 记住以前的对话', catalog: cat, llm: f.llm, defaultModel: f.defaultModel, installed: new Set(['dsh-mnemon']) })
  assert.deepEqual(r.picks.map(p => p.name), ['meow-memory', 'dsh-mnemon'], '编造的包名丢掉')
  assert.equal(r.picks[0].fit, 100, '合适度夹在 0~100')
  assert.equal(r.picks[1].caveat, '配置稍复杂')
  assert.equal(r.note, '记忆类首选 meow-memory')
  assert.deepEqual(r.keywords, ['memory', '记忆'])
  assert.equal(r.model, 'm-1')
  assert.equal(f.calls.length, 2)
  const second = f.calls[1].messages[0].content[0].text
  assert.match(second, /用户的需求：让 DSH 记住以前的对话/)
  assert.match(second, /dsh-mnemon.*已安装/)
  assert.match(f.calls[1].system, /不要编造/)
})

test('aiPick：需求为空、DSH 不给调模型、模型报错时说清楚', async () => {
  reloadCatalog(makeCatalog())
  const cat = await loadCatalog()
  const f = fakeLlm([])
  await assert.rejects(aiPick({ need: '  ', catalog: cat, llm: f.llm, defaultModel: f.defaultModel }), e => e.code === 'empty')
  await assert.rejects(callModel({ llm: null, defaultModel: null, system: '', user: '' }), e => e.code === 'no_llm')
  const bad = fakeLlm([new Error('额度用完了')])
  await assert.rejects(aiPick({ need: '记忆', catalog: cat, llm: bad.llm, defaultModel: bad.defaultModel }), /额度用完了/)
})
