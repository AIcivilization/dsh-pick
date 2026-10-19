/* global window, document */
// plugin/client.js — dsh-pick 的设置页
//
// 手写单文件 bundle，没有构建链：由 dsh web 客户端的 ModuleLoader 注入
// （写法照 dsh-model / dsh-vps-manager）。挂两处：DSH 右侧栏的一个页签（完整面板），
// 和「设置 → dsh-pick」（精简版：版本 / 更新 / 卸载、怎么打开、数据口径）。
//
// 界面本身就是一个 iframe，指向宿主路由 /api-dsh-pick/panel —— 面板那套 UI
// 是独立调试过的（dsh-pick serve 直接能开），这里原样复用，不再用 React 重写一遍。
// 硬约束：界面崩了不能影响 dsh，注册一律包在 try/catch 里。

window.__ModuleLoader__.load({
  id: 'dsh-pick',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    // 语言：跟着页面（dsh 只有中、英两种）
    const isZh = () => {
      const l = (document.documentElement.lang || navigator.language || 'zh').toLowerCase()
      return l.startsWith('zh')
    }
    const L = (zh, en) => (isZh() ? zh : en)

    // 用 dsh 自己的颜色变量，跟随明暗主题
    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      sub: 'var(--dsw-alias-label-secondary, #888)',
      faint: 'var(--dsw-alias-label-tertiary, #999)',
      border: 'var(--dsw-alias-border-l3, rgba(127,127,127,.25))',
      accent: 'var(--dsw-alias-link, #2f6bff)',
      danger: '#c94040',
    }

    // 和宿主通信：会改东西的请求用 JSON POST（宿主只收同源 JSON）
    async function api(path, method = 'GET') {
      const r = await fetch('/api-dsh-pick/' + path, {
        method,
        credentials: 'same-origin',
        headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' ? '{}' : undefined,
      })
      return r.json()
    }

    function Btn({ onClick, disabled, danger, primary, title, children }) {
      return h('button', {
        type: 'button', onClick, disabled, title,
        style: {
          appearance: 'none', fontFamily: 'inherit', fontSize: 12, lineHeight: '18px',
          padding: '2px 10px', borderRadius: 6, cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1, whiteSpace: 'nowrap',
          border: '1px solid ' + (danger ? C.danger : primary ? C.accent : C.border),
          background: primary ? C.accent : 'transparent',
          color: primary ? '#fff' : danger ? C.danger : C.text,
        },
      }, children)
    }

    /** 一条给用户自己在终端执行的命令：等宽显示，旁边一个「复制」 */
    function CommandLine({ command }) {
      const [copied, setCopied] = useState(false)
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(command)
        } catch {
          // 剪贴板不让用（非安全上下文等）：退回到选中后 execCommand
          const ta = document.createElement('textarea')
          ta.value = command
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          try { document.execCommand('copy') } catch { /* 实在不行用户还能手动选 */ }
          ta.remove()
        }
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
        h('code', {
          style: {
            flex: '1 1 auto', minWidth: 0, padding: '4px 8px', borderRadius: 6, fontSize: 12, color: C.text,
            border: '1px solid ' + C.border, userSelect: 'all', overflowWrap: 'anywhere',
          },
        }, command),
        h(Btn, { onClick: copy }, copied ? L('已复制', 'Copied') : L('复制', 'Copy')))
    }

    /** 标题行：dsh-pick · 版本号 · 更新 ……（最右）卸载 */
    function HeaderBar() {
      const [info, setInfo] = useState(null)
      const [phase, setPhase] = useState('checking') // checking | idle | updating | updated | removing | removed
      const [confirm, setConfirm] = useState(false)
      const [msg, setMsg] = useState(null) // { text, command? }

      const check = (force) => {
        setPhase('checking')
        api('update' + (force ? '?force=1' : ''))
          .then(j => { setInfo(j); setPhase('idle') })
          .catch(() => setPhase('idle'))
      }
      useEffect(() => { check(false) }, [])

      const update = async () => {
        setPhase('updating'); setMsg(null)
        try {
          const j = await api('update', 'POST')
          if (j.ok) { setPhase('updated'); return }
          setMsg({ text: j.message, command: j.command })
        } catch (e) {
          setMsg({ text: L('更新请求失败：', 'Update failed: ') + e.message })
        }
        setPhase('idle')
      }

      const uninstall = async () => {
        setConfirm(false); setPhase('removing'); setMsg(null)
        try {
          const j = await api('uninstall', 'POST')
          if (j.ok) { setPhase('removed'); return }
          setMsg({ text: j.message, command: j.command })
          setPhase('idle')
        } catch {
          // DSH 卸下插件时自己的接口也随之消失，请求多半就是这么断的
          setPhase('removed')
        }
      }

      let upd
      if (phase === 'updating') upd = { label: L('正在更新…', 'Updating…'), disabled: true }
      else if (phase === 'updated') upd = { label: L('已更新，重启 DSH 生效', 'Updated; restart DSH'), disabled: true }
      else if (info && info.restartPending) upd = { label: L(`v${info.restartPending} 已装好，重启 DSH 生效`, `v${info.restartPending} installed; restart DSH`), disabled: true }
      else if (info && info.available) upd = { label: L(`更新到 v${info.latest}`, `Update to v${info.latest}`), primary: true, onClick: update }
      else if (phase === 'checking') upd = { label: L('检查更新…', 'Checking…'), disabled: true }
      else upd = {
        label: info && info.latest ? L('已是最新', 'Up to date') : L('检查更新', 'Check for updates'),
        onClick: () => check(true),
        title: L('点一下重新检查', 'Click to check again'),
      }

      const busy = phase === 'updating' || phase === 'removing' || phase === 'removed'

      return h('div', { style: { marginBottom: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 15, fontWeight: 650 } }, 'dsh-pick'),
          info && info.running ? h('span', { style: { fontSize: 12, color: C.sub, fontVariantNumeric: 'tabular-nums' } }, 'v' + info.running) : null,
          h(Btn, { onClick: upd.onClick, disabled: upd.disabled || busy, primary: upd.primary, title: upd.title }, upd.label),
          h('span', { style: { flex: 1 } }),
          phase === 'removed'
            ? h('span', { style: { fontSize: 12, color: C.sub } }, L('已卸载，重启 DSH 后彻底移除', 'Uninstalled; restart DSH to finish'))
            : phase === 'removing'
              ? h('span', { style: { fontSize: 12, color: C.sub } }, L('正在卸载…', 'Uninstalling…'))
              : confirm
                ? h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
                    h('span', { style: { fontSize: 12, color: C.sub } }, L('确定卸载？', 'Uninstall?')),
                    h(Btn, { danger: true, onClick: uninstall }, L('确认卸载', 'Confirm')),
                    h(Btn, { onClick: () => setConfirm(false) }, L('取消', 'Cancel')))
                : h(Btn, { danger: true, disabled: busy, onClick: () => setConfirm(true) }, L('卸载', 'Uninstall')),
        ),
        msg ? h('div', { style: { fontSize: 12, color: C.danger, marginTop: 6, lineHeight: 1.6 } },
          msg.text,
          msg.command ? h(CommandLine, { command: msg.command }) : null,
        ) : null,
      )
    }

    // —— 「+AI」：面板（iframe）里点了，消息传到这里，写进这个对话的输入框发出去 ——
    // 拿输入框的办法照 dsh-vps-manager：sessions 服务 → 这个对话的 conversation.input
    let composerOf = null
    function composerFor(sessionId) {
      try { return (sessionId && composerOf && composerOf(sessionId)) || null } catch { return null }
    }
    /** 输入框里还没发出去的文字 */
    function composerDraft(input) {
      try {
        const st = input.snapshot || (input.state && input.state.get && input.state.get()) || {}
        return String(st.draft || '').trim()
      } catch { return '' }
    }
    /** 这个对话里排着队、还没轮到的消息（只取文字） */
    function queuedTexts(input) {
      try {
        const st = input.snapshot || (input.state && input.state.get && input.state.get()) || {}
        return (st.queue || []).map(m => (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim())
      } catch { return [] }
    }
    /** @returns {'sent'|'queued'|'draft'|'none'} */
    async function sendToChat(sessionId, text) {
      const input = composerFor(sessionId)
      if (!input) return 'none'
      // 用户正在输入的内容不覆盖
      if (composerDraft(input)) return 'draft'
      // AI 忙着时连点几下，别排一串一样的
      if (queuedTexts(input).includes(text.trim())) return 'queued'
      input.setDraft(text)
      // 输入框更新是异步的：等它收到这句话再发，不然发出去的是空的
      for (let i = 0; i < 20 && !composerDraft(input); i += 1) await new Promise(r => setTimeout(r, 25))
      if (!composerDraft(input)) {
        if (input.focus) input.focus()
        return 'none'
      }
      await input.submit('queue')
      return 'sent'
    }

    /** 右侧栏里的完整面板：标题行 + 占满栏高的 iframe（iframe 自己滚动；目录信息面板里自带） */
    function PickPanel({ sessionId }) {
      const frame = useRef(null)
      const sid = sessionId ? String(sessionId) : ''

      useEffect(() => {
        const onMessage = async (e) => {
          const win = frame.current && frame.current.contentWindow
          if (!win || e.source !== win || e.origin !== window.location.origin) return
          const d = e.data
          if (!d || d.type !== 'dsh-pick:ask' || typeof d.text !== 'string' || !d.text.trim()) return
          let status = 'none'
          try { status = await sendToChat(sid, d.text.slice(0, 8000)) } catch { status = 'none' }
          win.postMessage({ type: 'dsh-pick:ask-result', id: d.id, status }, window.location.origin)
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [sid])

      return h('div', {
        style: { color: C.text, height: '100%', display: 'flex', flexDirection: 'column', padding: '10px 12px', boxSizing: 'border-box' },
      },
        h(HeaderBar),
        h('iframe', {
          ref: frame,
          src: '/api-dsh-pick/panel',
          title: 'dsh-pick',
          style: {
            width: '100%',
            flex: '1 1 0',
            minHeight: 0,
            border: '1px solid ' + C.border,
            borderRadius: '10px',
            background: 'transparent',
            display: 'block',
          },
        }),
      )
    }

    // 数据口径说明：面板底部原来那段，现在放在设置页
    const DATA_NOTE = () => L(
      '排名按周下载；日常基线已扣掉版本发布日与次日的拉取虚高，比原始下载量更接近真实使用量。' +
      '下载量含 CI / 镜像 / 爬虫流量，不等于用户数。npm 统计约滞后 5 天。',
      'Ranks are weekly downloads; daily baseline strips the publish-day spike and is closer to real use. ' +
      'Download counts include CI/mirror/crawler traffic, not real users. npm stats lag about 5 days.')

    /** 右侧栏的服务（apply 里拿到）；老版本 DSH 没有 */
    let sidebarRightApi = null

    function Section({ title, children }) {
      return h('div', { style: { marginTop: 18 } },
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, title),
        h('div', { style: { fontSize: 12.5, color: C.sub, lineHeight: 1.7 } }, children))
    }

    /** 设置页：完整面板在右侧栏，这里只放管理和说明 */
    function SettingsSection() {
      const [meta, setMeta] = useState(null)
      const [openMsg, setOpenMsg] = useState('')

      useEffect(() => {
        let alive = true
        api('meta').then(j => { if (alive) setMeta(j) }).catch(() => {})
        return () => { alive = false }
      }, [])

      const openSidebar = () => {
        try {
          sidebarRightApi.openTab(SIDEBAR_KIND)
          setOpenMsg(L('已在右侧栏打开，关闭设置就能看到', 'Opened in the right sidebar; close Settings to see it'))
        } catch {
          // 右侧栏是跟着对话走的：没有打开的对话时开不了
          setOpenMsg(L('先回到一个对话，再从右侧栏打开', 'Go back to a conversation first, then open it from the right sidebar'))
        }
      }

      const catalog = !meta
        ? L('正在读取目录…', 'Loading catalog…')
        : meta.total
          ? L(
              `目录收录 ${meta.total.toLocaleString()} 个插件，其中 ${meta.deepCount} 个有去噪指标；数据截止 ${meta.anchor}。`,
              `${meta.total.toLocaleString()} plugins in the catalog, ${meta.deepCount} with denoised metrics; data as of ${meta.anchor}.`)
          : L('目录未生成：在 dsh-pick 目录跑一次 dsh-pick build', 'Catalog not built yet: run `dsh-pick build`')

      return h('div', { style: { color: C.text } },
        h(HeaderBar),

        h(Section, { title: L('怎么打开', 'How to open') },
          h('div', null, L(
            '选插件面板在对话页的右侧栏：打开右侧栏，在引导页里点「选插件」。',
            'The picker lives in the conversation\'s right sidebar: open the sidebar and choose "Pick a plugin" on its guide page.')),
          sidebarRightApi
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
                h(Btn, { onClick: openSidebar }, L('在右侧栏打开', 'Open in right sidebar')),
                openMsg ? h('span', { style: { fontSize: 12, color: C.faint } }, openMsg) : null)
            : null,
        ),

        h(Section, { title: L('数据口径', 'About the data') },
          h('div', null, catalog),
          meta && meta.total ? h('div', { style: { marginTop: 4 } }, meta.source === 'remote'
            ? L('数据每天自动更新' + (meta.checkedAt ? `，最近一次检查 ${new Date(meta.checkedAt).toLocaleString()}` : '') + '。',
                'Data updates daily' + (meta.checkedAt ? `; last checked ${new Date(meta.checkedAt).toLocaleString()}` : '') + '.')
            : L('现在用的是随插件自带的数据：每日更新还没取到（网络不通时会这样），取到后自动换上。',
                'Using the data bundled with the plugin; the daily update has not arrived yet and will be used once it does.')) : null,
          h('div', { style: { marginTop: 4 } }, DATA_NOTE()),
        ),
      )
    }

    // 右侧栏页签（DSH 0.2 起有右侧栏；老版本没有这个服务就只在设置页里）
    const SIDEBAR_TAB_ID = 'dsh-pick/panel'
    const SIDEBAR_KIND = 'dsh-pick'

    function PickIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 32 32', fill: 'none' },
        h('path', { d: 'M6 22l6-7 5 5 9-11', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    const injectSlots = ['slots']
    function apply(ctx) {
      try {
        // 对话输入框（可选服务：没有就是「+AI」发不出去，面板照常能用）
        ctx.inject && ctx.inject(['sessions', 'conversation'], (scope) => {
          const sessions = (scope.get && scope.get('sessions')) || scope.sessions
          const reader = (sessionId) => {
            const actx = sessions && sessions.scope && sessions.scope(sessionId)
            const conv = actx && actx.get && actx.get('conversation')
            const input = conv && conv.input && conv.input.for && conv.input.for(actx)
            return input && typeof input.setDraft === 'function' && typeof input.submit === 'function' ? input : null
          }
          composerOf = reader
          if (scope.effect) scope.effect(() => () => { if (composerOf === reader) composerOf = null }, 'dsh-pick: composer')
        })
      } catch (error) {
        console.warn('[dsh-pick] 拿不到对话输入框', error)
      }
      try {
        ctx.inject && ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
          const right = (scope.get && scope.get('sidebarRight')) || scope.sidebarRight
          const tabs = (scope.get && scope.get('sidebarRightTabs')) || scope.sidebarRightTabs
          if (!tabs || typeof tabs.register !== 'function') return
          const effect = (fn, label) => (scope.effect ? scope.effect(fn, label) : fn())
          effect(() => tabs.register({
            id: SIDEBAR_TAB_ID,
            kind: SIDEBAR_KIND,
            priority: 'extension',
            keepMounted: true,
            title: () => 'dsh-pick',
            guide: [{
              id: 'dsh-pick',
              order: 70,
              title: () => L('选插件', 'Pick a plugin'),
              description: () => L('说需求 → 找候选 → 多维比较 → 出结论', 'Describe a need, compare candidates, get a verdict'),
              icon: PickIcon,
            }],
          }), 'dsh-pick: sidebar type')
          const slots = scope.slots || ctx.slots
          const body = () => slots.register({ name: 'sidebar.right.pane.tab', key: SIDEBAR_TAB_ID }, PickPanel)
          effect(() => (slots.inject ? slots.inject('sidebar.right.pane.tab', body) : body()), 'dsh-pick: sidebar body')
          if (right && typeof right.openTab === 'function') {
            sidebarRightApi = right
            effect(() => () => { if (sidebarRightApi === right) sidebarRightApi = null }, 'dsh-pick: sidebar api')
          }
        })
      } catch (error) {
        console.warn('[dsh-pick] 右侧栏注册失败', error)
      }
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-pick', order: 30, label: () => 'dsh-pick' },
            SettingsSection,
          ))
      } catch (error) {
        console.warn('[dsh-pick] 设置页注册失败', error)
      }
    }

    // 给测试用的内部句柄（浏览器里没人碰它）
    module.exports = { name: 'dsh-pick', inject: injectSlots, apply, __test: { sendToChat } }
    return module.exports
  },
})
