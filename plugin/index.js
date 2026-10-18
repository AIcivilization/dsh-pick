// plugin/index.js — dsh-pick 的 DSH 插件（宿主端）
//
// 只做一件事：把「选插件」面板挂到 dsh 自己的 webServer 上，让 dsh 设置页里能看，
// 顺便给面板提供数据接口。数据全部来自本包 data/catalog.json，不外传。
//
// 路由（都走 dsh 的登录校验，所以先过 dsh 自己的鉴权）：
//   GET  /api-dsh-pick/panel        面板 HTML
//   GET  /api-dsh-pick/panel.js     面板逻辑
//   GET  /api-dsh-pick/words.js     搜索词典
//   GET  /api-dsh-pick/catalog.json 目录（含排名、链接、去噪指标）
//   GET  /api-dsh-pick/meta         目录概要（更新时间、包数）
//
// 写法照 dsh-model（同机参考）与 dsh-vps-manager（同作者）的 plugin/index.js。

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** 本包根目录：插件就是完整的 dsh-pick 包 */
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

/** 只放行这几个固定文件，别把 bin/ 也暴露出去 */
const FILES = {
  '/panel': 'web/panel.html',
  '/panel.js': 'web/panel.js',
  '/words.js': 'lib/words.js',
  '/catalog.json': 'data/catalog.json',
}

async function readPkgJson() {
  try {
    return JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8'))
  } catch {
    return {}
}
}

/** 目录概要：给面板顶部显示「更新时间 / 包数」用 */
async function catalogMeta() {
  try {
    const cat = JSON.parse(await readFile(join(PKG_ROOT, 'data', 'catalog.json'), 'utf8'))
    const packages = cat.packages || {}
    return {
      asOf: cat.asOf || null,
      anchor: cat.anchor || null,
      total: cat.total || Object.keys(packages).length,
      deepCount: Object.values(packages).filter(p => p && p.deep).length,
    }
  } catch {
    return { asOf: null, anchor: null, total: 0, deepCount: 0 }
  }
}

export const name = 'dsh-pick'
export const inject = []

export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    const ws = webCtx.webServer
    if (!ws || typeof ws.register !== 'function') return

    const track = d => d

    // 面板静态资源
    for (const [route, rel] of Object.entries(FILES)) {
      track(ws.register({
        kind: 'exact',
        path: '/api-dsh-pick' + route,
        handler: async (req, res) => {
          try {
            const buf = await readFile(join(PKG_ROOT, rel))
            const ext = rel.slice(rel.lastIndexOf('.'))
            res.writeHead(200, {
              'content-type': TYPES[ext] || 'text/plain; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(buf)
          } catch (e) {
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({
              error: { code: 'not_built', message: `缺少 ${rel}，先跑一次 dsh-pick build` },
            }))
          }
        },
      }))
    }

    // 目录概要
    track(ws.register({
      kind: 'exact',
      path: '/api-dsh-pick/meta',
      handler: async (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(await catalogMeta()))
      },
    }))

    // 面板是内嵌在 dsh 设置页里的 iframe，同源即可，不需要额外令牌：
    // 这些路由全都先过 dsh 的登录校验（挂在 dsh 自己的 webServer 上）。
  })
}

export default { name, inject, apply, __meta: { pkgRoot: PKG_ROOT, version: () => readPkgJson().then(p => p.version || '') } }
