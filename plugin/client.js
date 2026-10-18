/* global window, document */
// plugin/client.js — dsh-pick 的设置页
//
// 手写单文件 bundle，没有构建链：由 dsh web 客户端的 ModuleLoader 注入
// （写法照 dsh-model / dsh-vps-manager）。挂在「设置 → dsh-pick」。
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
    }

    function PickPanel() {
      const frame = useRef(null)
      const [meta, setMeta] = useState(null)
      const [h, setH] = useState(720)

      useEffect(() => {
        let alive = true
        fetch('/api-dsh-pick/meta', { credentials: 'same-origin' })
          .then(r => r.json())
          .then(j => { if (alive) setMeta(j) })
          .catch(() => {})
        return () => { alive = false }
      }, [])

      useEffect(() => {
        // iframe 里改不了高度（跨文档），用一个粗策略：内容高差太多就跟着长
        const t = setInterval(() => {
          try {
            const doc = frame.current && frame.current.contentDocument
            if (doc && doc.body) {
              const need = Math.max(720, doc.body.scrollHeight + 40)
              if (Math.abs(need - h) > 40) setH(need)
            }
          } catch { /* 跨域就不管，保持默认高度 */ }
        }, 1500)
        return () => clearInterval(t)
      }, [h])

      const tip = !meta
        ? L('正在读取目录…', 'Loading catalog…')
        : meta.total
          ? L(
              `目录 ${meta.total.toLocaleString()} 个插件 · 去噪指标 ${meta.deepCount} 个 · 数据截止 ${meta.anchor}`,
              `${meta.total.toLocaleString()} plugins · ${meta.deepCount} with denoised metrics · as of ${meta.anchor}`)
          : L('目录未生成：在 dsh-pick 目录跑一次 dsh-pick build', 'Catalog not built yet: run `dsh-pick build`')

      return h('div', { style: { color: C.text } },
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
            height: h + 'px',
            border: '1px solid ' + C.border,
            borderRadius: '10px',
            background: 'transparent',
            display: 'block',
          },
        }),

        h('div', {
          style: { fontSize: 11, color: C.faint, marginTop: 8, lineHeight: 1.7 },
        },
          L(
            '排名按周下载；日常基线已扣掉版本发布日与次日的拉取虚高，比原始下载量更接近真实使用量。' +
            '下载量含 CI / 镜像 / 爬虫流量，不等于用户数。',
            'Ranks are weekly downloads; daily baseline strips the publish-day spike. ' +
            'Download counts include CI/mirror traffic, not real users.'),
        ),
      )
    }

    const injectSlots = ['slots']
    function apply(ctx) {
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
