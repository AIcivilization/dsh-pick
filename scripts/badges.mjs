// scripts/badges.mjs — 每日构建时生成 README 排名徽章的 endpoint 文件（GitHub Actions 用）
//
// 用法：node scripts/badges.mjs <catalog.json> <输出目录>
// 写到 <输出目录>/badge/ 下，和目录一起推到 catalog 分支。说明见 lib/badges.js。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { buildBadges } from '../lib/badges.js'

const [src, outDir] = process.argv.slice(2)
if (!src || !outDir) {
  console.error('用法：node scripts/badges.mjs <catalog.json> <输出目录>')
  process.exit(2)
}

const cat = JSON.parse(await readFile(src, 'utf8'))
const files = buildBadges(cat)
const dirs = new Set(files.map(([p]) => dirname(join(outDir, 'badge', p))))
for (const d of dirs) await mkdir(d, { recursive: true })
for (const [p, body] of files) await writeFile(join(outDir, 'badge', p), JSON.stringify(body))
const ranked = files.filter(([, b]) => b.message !== 'listed').length
console.log(`徽章：${files.length.toLocaleString()} 个（有名次 ${ranked.toLocaleString()} 个）`)
