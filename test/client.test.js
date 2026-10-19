// 客户端（plugin/client.js）：它是给浏览器的手写 bundle，这里用 vm 加载，配一个最小的假 React。
// 不渲染界面，只测注册了什么、「+AI」怎么把话写进对话
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const FakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: init => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}

function load() {
  let mod
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ factory }) => { mod = factory(n => (n === 'react' ? FakeReact : null)) } } },
    document: { documentElement: { lang: 'zh-CN' } },
    navigator: { language: 'zh-CN' },
    console,
    setTimeout,
    fetch: async () => ({ json: async () => ({}) }),
  }
  vm.runInNewContext(readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8'), sandbox)
  return mod
}

function fakeInput({ draft = '', queue = [] } = {}) {
  const st = { draft, queue: queue.map(t => ({ content: [{ type: 'text', text: t }] })) }
  return {
    sent: [],
    snapshot: st,
    setDraft(t) { setTimeout(() => { st.draft = t }, 10) }, // 真实输入框也是异步更新
    async submit(mode) { this.sent.push([mode, st.draft]); st.queue.push({ content: [{ type: 'text', text: st.draft }] }); st.draft = '' },
  }
}

function applyWith({ sidebar = true, inputs = {} } = {}) {
  const mod = load()
  const regs = []
  const tabs = []
  const slots = { inject: (name, fn) => fn(), register: (d, c) => regs.push([d, c]) }
  mod.apply({
    slots,
    inject: (deps, fn) => {
      if (deps[0] === 'sidebarRight' && sidebar) fn({ sidebarRight: { openTab() {} }, sidebarRightTabs: { register: d => tabs.push(d) }, slots, effect: f => f() })
      if (deps[0] === 'sessions') fn({ sessions: { scope: id => ({ get: () => ({ input: { for: () => inputs[id] } }) }) } })
    },
  })
  return { mod, regs, tabs }
}

test('注册：右侧栏页签 + 设置页', () => {
  const { regs, tabs } = applyWith()
  assert.deepEqual(regs.map(([d]) => d.name).sort(), ['settings.section', 'sidebar.right.pane.tab'])
  assert.equal(tabs[0].kind, 'dsh-pick')
  assert.equal(tabs[0].guide[0].title(), '选插件')
})

test('老版本 DSH 没有右侧栏：只注册设置页', () => {
  const { regs } = applyWith({ sidebar: false })
  assert.deepEqual(regs.map(([d]) => d.name), ['settings.section'])
})

test('+AI：写进对话并发出；不覆盖用户正在打的字；不重复排队', async () => {
  const inputs = { s1: fakeInput(), s2: fakeInput({ draft: '用户正在打的字' }), s3: fakeInput({ queue: ['同一句话'] }) }
  const { mod } = applyWith({ inputs })
  const send = mod.__test.sendToChat
  assert.equal(await send('s1', '帮我看看'), 'sent')
  assert.deepEqual(inputs.s1.sent, [['queue', '帮我看看']])
  assert.equal(await send('s2', '帮我看看'), 'draft')
  assert.equal(inputs.s2.snapshot.draft, '用户正在打的字')
  assert.equal(await send('s3', '同一句话'), 'queued')
  assert.equal(await send('', 'x'), 'none')
  assert.equal(await send('nope', 'x'), 'none')
})
