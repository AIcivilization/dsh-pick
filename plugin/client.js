/* global window, document */
// plugin/client.js — dsh-pick 的设置页
//
// 手写单文件 bundle，没有构建链：由 dsh web 客户端的 ModuleLoader 注入
// （写法照 dsh-model / dsh-vps-manager）。挂两处：DSH 右侧栏的一个页签（主入口），
// 和「设置 → dsh-pick」（暂时保留，内容相同）。
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
      accent: '#2f6bff',
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
          msg.command ? h('code', { style: { display: 'block', marginTop: 4, color: C.text, userSelect: 'all' } }, msg.command) : null,
        ) : null,
      )
    }

    /**
     * 面板本体。fill = 放在右侧栏里：占满栏高，iframe 自己滚动；
     * 否则（设置页）iframe 跟着内容长高，由设置页滚动
     */
    function PickPanel({ fill }) {
      const frame = useRef(null)
      const [meta, setMeta] = useState(null)
      const [frameH, setFrameH] = useState(720)

      useEffect(() => {
        let alive = true
        fetch('/api-dsh-pick/meta', { credentials: 'same-origin' })
          .then(r => r.json())
          .then(j => { if (alive) setMeta(j) })
          .catch(() => {})
        return () => { alive = false }
      }, [])

      useEffect(() => {
        if (fill) return undefined
        // iframe 里改不了高度（跨文档），用一个粗策略：内容高差太多就跟着长
        const t = setInterval(() => {
          try {
            const doc = frame.current && frame.current.contentDocument
            if (doc && doc.body) {
              const need = Math.max(720, doc.body.scrollHeight + 40)
              if (Math.abs(need - frameH) > 40) setFrameH(need)
            }
          } catch { /* 跨域就不管，保持默认高度 */ }
        }, 1500)
        return () => clearInterval(t)
      }, [frameH, fill])

      const tip = !meta
        ? L('正在读取目录…', 'Loading catalog…')
        : meta.total
          ? L(
              `目录 ${meta.total.toLocaleString()} 个插件 · 去噪指标 ${meta.deepCount} 个 · 数据截止 ${meta.anchor}`,
              `${meta.total.toLocaleString()} plugins · ${meta.deepCount} with denoised metrics · as of ${meta.anchor}`)
          : L('目录未生成：在 dsh-pick 目录跑一次 dsh-pick build', 'Catalog not built yet: run `dsh-pick build`')

      return h('div', {
        style: fill
          ? { color: C.text, height: '100%', display: 'flex', flexDirection: 'column', padding: '10px 12px', boxSizing: 'border-box' }
          : { color: C.text },
      },
        h(HeaderBar),
        h('div', {
          style: {
            fontSize: 12, color: C.faint, margin: '2px 0 10px', lineHeight: 1.6,
          },
        }, tip),

        h('iframe', {
          ref: frame,
          src: '/api-dsh-pick/panel',
          title: 'dsh-pick',
          style: {
            width: '100%',
            height: fill ? 'auto' : frameH + 'px',
            flex: fill ? '1 1 0' : undefined,
            minHeight: fill ? 0 : undefined,
            border: '1px solid ' + C.border,
            borderRadius: '10px',
            background: 'transparent',
            display: 'block',
          },
        }),

        h('div', {
          style: { fontSize: 11, color: C.faint, marginTop: 8, lineHeight: 1.7, display: fill ? 'none' : undefined },
        },
          L(
            '排名按周下载；日常基线已扣掉版本发布日与次日的拉取虚高，比原始下载量更接近真实使用量。' +
            '下载量含 CI / 镜像 / 爬虫流量，不等于用户数。',
            'Ranks are weekly downloads; daily baseline strips the publish-day spike. ' +
            'Download counts include CI/mirror traffic, not real users.'),
        ),
      )
    }

    // 右侧栏页签（DSH 0.2 起有右侧栏；老版本没有这个服务就只在设置页里）
    const SIDEBAR_TAB_ID = 'dsh-pick/panel'
    const SIDEBAR_KIND = 'dsh-pick'
    const SidebarBody = () => h(PickPanel, { fill: true })

    function PickIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 32 32', fill: 'none' },
        h('path', { d: 'M6 22l6-7 5 5 9-11', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    const injectSlots = ['slots']
    function apply(ctx) {
      try {
        ctx.inject && ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
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
          const body = () => slots.register({ name: 'sidebar.right.pane.tab', key: SIDEBAR_TAB_ID }, SidebarBody)
          effect(() => (slots.inject ? slots.inject('sidebar.right.pane.tab', body) : body()), 'dsh-pick: sidebar body')
        })
      } catch (error) {
        console.warn('[dsh-pick] 右侧栏注册失败', error)
      }
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-pick', order: 30, label: () => 'dsh-pick' },
            PickPanel,
          ))
      } catch (error) {
        console.warn('[dsh-pick] 设置页注册失败', error)
      }
    }

    module.exports = { name: 'dsh-pick', inject: injectSlots, apply }
    return module.exports
  },
})
