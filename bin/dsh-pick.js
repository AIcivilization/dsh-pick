#!/usr/bin/env node
// bin/dsh-pick.js — dsh-pick 命令行
//
//   dsh-pick build [--deep 200] [--pages 9]   抓取目录并算去噪指标
//   dsh-pick search "我想装个数据库"           按需求找候选
//   dsh-pick rank [--metric weekly|baseline|growth|score] [--cat 分类] [--limit 30]
//   dsh-pick stats <pkg> [pkg...]             精确数据（目录没有就实时查）
//   dsh-pick serve [--port 8891]              起本地服务，预览面板

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCatalog, loadCatalog, searchByNeed, rank, stats, normalize } from '../lib/engine.js'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const [, , cmd = 'help', ...rest] = process.argv

function arg(name, dflt) {
  const i = rest.indexOf('--' + name)
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : dflt
}
const has = name => rest.includes('--' + name)
// 位置参数：把 `--flag 值` 整对踢掉，剩下的才是需求文本
const positionals = (() => {
  const out = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) { if (rest[i + 1] && !rest[i + 1].startsWith('--')) i++; continue }
    out.push(rest[i])
  }
  return out
})()

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)
const num = n => (n === null || n === undefined) ? '—' : Number(n).toLocaleString('en-US')
const pct = n => n === null || n === undefined ? '—' : (n >= 0 ? '+' : '') + (n * 100).toFixed(0) + '%'

async function main() {
  switch (cmd) {
    case 'build': {
      const deep = Number(arg('deep', 200))
      const pages = Number(arg('pages', 9))
      await buildCatalog({ deep, pages, deepOnly: has('deep-only'), onProgress: m => console.log('·', m) })
      break
    }

    case 'search': {
      const need = positionals.join(' ') || arg('need', '')
      const cat = await loadCatalog()
      const limit = Number(arg('limit', 12))
      const r = searchByNeed(cat, need, { limit })
      if (!r.length) { console.log('没找到候选。目录需先跑 `dsh-pick build`。'); break }
      console.log(`\n需求：「${need}」  候选 ${r.length} 个（相关性 / 评分 / 周下载 / 日常基线 / 环比 / 最近更新）\n`)
      for (const x of r) {
        const d = x.deep
        console.log(
          pad(x.name, 34) + padL(x.relevance + '%', 6) +
          ' ' + padL(num(x.weekly), 9) + ' ' +
          (d ? padL(num(d.baseline), 9) + ' ' + padL(pct(d.growth), 8) + ' ' + pad(d.ageDays + 'd', 6) : pad('—', 25)) +
          '  ' + x.category
        )
        if (x.description) console.log('   ' + x.description.slice(0, 100))
      }
      console.log()
      break
    }

    case 'rank': {
      const cat = await loadCatalog()
      const metric = arg('metric', 'weekly')
      const category = arg('cat', null)
      const limit = Number(arg('limit', 30))
      const rows = rank(cat, { metric, category, limit })
      console.log(`\n榜单：${category || '全部'} · 指标 ${metric} · 截止 ${cat.anchor}  共 ${cat.total} 个包\n`)
      console.log(pad('排名', 5) + pad('插件', 34) + padL('周下载', 10) + padL('月下载', 10) + ' ' + padL('基线', 9) + ' ' + padL('环比', 8) + ' ' + pad('更新', 6) + '分类')
      rows.forEach((r, i) => {
        const d = r.deep
        console.log(
          padL(i + 1, 4) + ' ' + pad(r.n, 34) + padL(num(r.w), 10) + padL(num(r.m), 10) + ' ' +
          (d ? padL(num(d.base), 9) + ' ' + padL(pct(d.growth), 8) + ' ' + pad(d.age + 'd', 6) : pad('—', 24) + ' ') +
          r.cat
        )
      })
      console.log()
      break
    }

    case 'stats': {
      const names = positionals
      if (!names.length) { console.log('用法：dsh-pick stats <pkg> [pkg...]'); break }
      const cat = await loadCatalog()
      const rows = await stats(cat, names)
      for (const r of rows) {
        if (r.source === 'not-found') { console.log(`\n${r.name}：npm 上不存在或无名下数据`); continue }
        const d = r.deep
        console.log(`\n${r.name} ${r.version || ''}  [${r.category || '未分类'}]  (${r.source})`)
        if (r.description) console.log('  ' + r.description.slice(0, 120))
        console.log(`  周 ${num(r.weekly)} · 月 ${num(r.monthly)}${r.total != null ? ' · 累计 ' + num(r.total) : ''}`)
        if (d) console.log(`  日常基线 ${num(d.baseline)} · 环比 ${pct(d.growth)} · ${d.versions} 个版本 · ${d.cadence} 天/版 · ${d.ageDays} 天前更新 · 评分 ${d.score}`)
      }
      console.log()
      break
    }

    case 'serve': {
      const port = Number(arg('port', 8891))
      const types = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript' }
      const extName = f => f.slice(f.lastIndexOf('.'))
      // 只放行这三个目录：面板、目录数据、共享词典
      const ROOTS = {
        '/web/': join(PKG_ROOT, 'web'),
        '/data/': join(PKG_ROOT, 'data'),
        '/lib/': join(PKG_ROOT, 'lib'),
      }
      const server = createServer(async (req, res) => {
        try {
          let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
          if (p === '/') p = '/web/panel.html'
          const prefix = Object.keys(ROOTS).find(k => p.startsWith(k))
          if (!prefix) { res.writeHead(403).end('forbidden'); return }
          let buf
          if (prefix === '/data/') {
            // 目录要走一遍归一化，补上排名与链接字段
            buf = Buffer.from(JSON.stringify(await loadCatalog()), 'utf8')
          } else {
            buf = await readFile(join(ROOTS[prefix], p.slice(prefix.length)))
          }
          res.writeHead(200, {
            'content-type': (types[extName(p)] || 'text/plain') + '; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(buf)
        } catch {
          res.writeHead(404).end('not found')
        }
      })
      server.listen(port, '127.0.0.1', () => console.log(`dsh-pick 面板 → http://127.0.0.1:${port}/`))
      break
    }

    default:
      console.log(`
dsh-pick — DSH 插件选型助手

  build   抓取目录并算去噪指标        --deep 200 --pages 9
  search  按需求描述找候选            --limit 12
  rank    排行榜                      --metric weekly|baseline|growth|score --cat 分类 --limit 30
  stats   精确数据（实时兜底）          dsh-pick stats <pkg> [pkg...]
  serve   本地预览面板                 --port 8891
`)
  }
}

main().catch(e => { console.error('失败：', e.message); process.exit(1) })
