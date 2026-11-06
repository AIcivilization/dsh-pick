// scripts/catalog-meta.mjs — 每日目录发布前的最后一道检查（GitHub Actions 用）
//
// 用法：node scripts/catalog-meta.mjs <catalog.json> <输出目录>
// 校验目录像样（包够多、字段齐），不像样就失败退出——坏数据绝不推到 catalog 分支；
// 像样就把目录和一个很小的 meta.json 写进输出目录。插件先取 meta.json 比新旧，再决定要不要下载整个目录。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validCatalog, shrinkProblem } from '../lib/remote.js'

const [src, outDir] = process.argv.slice(2)
if (!src || !outDir) {
  console.error('用法：node scripts/catalog-meta.mjs <catalog.json> <输出目录>')
  process.exit(2)
}

const text = await readFile(src, 'utf8')
const cat = JSON.parse(text)
if (!validCatalog(cat)) {
  console.error('目录不像样（包太少或字段缺失），不发布')
  process.exit(1)
}

const packages = Object.values(cat.packages)

const meta = {
  tool: 'dsh-pick',
  anchor: cat.anchor,
  asOf: cat.asOf,
  total: packages.length,
  deepCount: packages.filter(p => p.deep).length,
  withInstallFacts: packages.filter(p => p.inst).length,
  bytes: Buffer.byteLength(text),
  builtAt: new Date().toISOString(),
}

// 线上上一份 meta（raw 比 jsDelivr 新：CDN 有缓存）。拿不到（第一次、网络问题）就不比
let previous = null
try {
  const r = await fetch('https://raw.githubusercontent.com/AIcivilization/dsh-pick/catalog/meta.json', { signal: AbortSignal.timeout(15000) })
  if (r.ok) previous = await r.json()
} catch { /* 不比 */ }
const problem = shrinkProblem(previous, meta)
if (problem && process.env.ALLOW_SHRINK !== '1') {
  console.error(`目录缩水了：${problem}。这次不发布，线上继续用上一份。确认是正常缩小，就设 ALLOW_SHRINK=1 再跑`)
  process.exit(1)
}

await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, 'catalog.json'), text)
await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
console.log(JSON.stringify(meta))
