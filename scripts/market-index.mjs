// scripts/market-index.mjs — 生成 DSH「发现」页用的插件索引（GitHub Actions 用）
//
// 用法：node scripts/market-index.mjs <catalog.json> <输出目录>
// 要先 npm ci：校验用官方的 @deepseek-ai/dsh-plugin-market-index（开发依赖，不进 npm 包）。
// 目录里没有发布时间（t）的够格插件，这里逐个去 npm 查；整份校验不过就失败退出，坏索引绝不发布。

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import { buildMarketIndex } from '../lib/market-index.js'

const [src, outDir] = process.argv.slice(2)
if (!src || !outDir) {
  console.error('用法：node scripts/market-index.mjs <catalog.json> <输出目录>')
  process.exit(2)
}

const catalog = JSON.parse(await readFile(src, 'utf8'))

// 够格（有 bundle、有 engines.dsh）但目录里没记发布时间的，查 npm 上这个版本的发布时间
const need = Object.values(catalog.packages).filter(r => r.inst && r.inst.b && r.inst.e && r.v && !r.t)
const times = {}
let i = 0
await Promise.all(Array.from({ length: 8 }, async () => {
  while (i < need.length) {
    const rec = need[i++]
    try {
      const res = await fetch(`https://registry.npmjs.org/${rec.n.replace('/', '%2f')}`, { signal: AbortSignal.timeout(30000) })
      const doc = res.ok ? await res.json() : null
      const t = doc && doc.time && doc.time[rec.v]
      if (t) times[rec.n] = t
    } catch { /* 查不到就不收这一个 */ }
  }
}))

const { index, skipped, rejected } = buildMarketIndex(catalog, { parse: parseMarketIndex, times })
const text = JSON.stringify(index)
await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, 'index.json'), text)
console.log(JSON.stringify({ plugins: index.plugins.length, bytes: Buffer.byteLength(text), skipped, rejected: rejected.length }))
for (const r of rejected.slice(0, 20)) console.log(`  校验不过，没收：${r.name} — ${r.reason}`)
