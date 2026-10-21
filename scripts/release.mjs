#!/usr/bin/env node
// scripts/release.mjs — 发版：一条命令走完 README「发布流程」，顺序不会错
//
//   npm run release -- 0.3.2 -m "改了什么"         指定版本号
//   npm run release -- patch -m "改了什么"         0.3.1 → 0.3.2（minor / major 同理）
//   npm run release -- patch -m "改了什么" --dry-run   只检查、只跑测试，什么都不改
//
// 顺序：检查 → 测试 → 改版本号并提交 → 推 GitHub → 打标签并推送 → npm publish → 等 npm 上能查到。
// 先 GitHub 再 npm：npm 上每个版本都能在 git 里找到对应提交。
// 在哪个目录运行都行，脚本自己切到仓库根目录（以前在 ~ 里执行 git push 报过 not a git repository）。

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PKG_FILE = join(ROOT, 'package.json')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const mIndex = args.indexOf('-m')
const message = mIndex >= 0 ? String(args[mIndex + 1] || '').trim() : ''
const target = args.find((a, i) => !a.startsWith('-') && i !== mIndex + 1)

const fail = (text) => {
  console.error(`\n✗ ${text}`)
  process.exit(1)
}
const step = (text) => console.log(`\n▸ ${text}`)
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()
// Windows 上的 npm 是 npm.cmd：新版 Node 不许不经 shell 直接起 .cmd（会报 EINVAL / ENOENT）。
// 这里传给 npm 的参数都是固定的短词和版本号，没有空格和引号，走 shell 不会被拆错
const viaShell = cmd => cmd === 'npm' && process.platform === 'win32'
const run = (cmd, a) => {
  const r = spawnSync(cmd, a, { cwd: ROOT, stdio: 'inherit', shell: viaShell(cmd) })
  if (r.status !== 0) fail(`${cmd} ${a.join(' ')} 失败（退出码 ${r.status}）`)
}

if (!target || !message) {
  fail('用法：npm run release -- <x.y.z | patch | minor | major> -m "改了什么" [--dry-run]')
}

const pkg = JSON.parse(readFileSync(PKG_FILE, 'utf8'))
const cur = pkg.version.split(/[.-]/).slice(0, 3).map(Number)
const next = target === 'major' ? `${cur[0] + 1}.0.0`
  : target === 'minor' ? `${cur[0]}.${cur[1] + 1}.0`
    : target === 'patch' ? `${cur[0]}.${cur[1]}.${cur[2] + 1}`
      : target
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) fail(`版本号不对：${next}`)
const tag = `v${next}`

console.log(`dsh-pick ${pkg.version} → ${next}${dryRun ? '（演练，不改任何东西）' : ''}`)
console.log(`说明：${message}`)

// —— 检查 ——
step('检查仓库状态')
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('不在 main 分支上')
if (git('status', '--porcelain')) fail('有没提交的改动，先提交或收起来再发版')
git('fetch', '-q', 'origin', 'main', '--tags')
if (git('rev-list', '--count', 'HEAD..origin/main') !== '0') fail('本地落后于 GitHub 上的 main，先 git pull')
if (git('tag', '-l', tag)) fail(`标签 ${tag} 已经存在`)
const onNpm = spawnSync('npm', ['view', `${pkg.name}@${next}`, 'version'], { cwd: ROOT, encoding: 'utf8', shell: viaShell('npm') })
if (onNpm.stdout.trim() === next) fail(`npm 上已经有 ${next} 了（npm 不许覆盖已发布的版本）`)
const npmUser = spawnSync('npm', ['whoami'], { cwd: ROOT, encoding: 'utf8', shell: viaShell('npm') })
console.log(npmUser.status === 0 ? `  npm 账号：${npmUser.stdout.trim()}` : '  npm 还没登录：发布时会打开浏览器让你确认')

step('跑测试')
run('npm', ['test', '--silent'])

if (dryRun) {
  console.log(`\n✓ 演练通过。去掉 --dry-run 就会发布 ${tag}`)
  process.exit(0)
}

// —— 发布 ——
step(`改版本号并提交`)
pkg.version = next
writeFileSync(PKG_FILE, JSON.stringify(pkg, null, 2) + '\n')
git('add', 'package.json')
git('commit', '-q', '-m', `${tag}：${message}`)

step('推 GitHub')
run('git', ['push', 'origin', 'main'])

step(`打标签 ${tag} 并推送`)
git('tag', '-a', tag, '-m', `${pkg.name} ${tag}：${message}`)
run('git', ['push', 'origin', tag])

step('发布到 npm（可能要在浏览器里确认）')
run('npm', ['publish'])

// npm 收下后要处理一会儿才查得到（实测一两分钟），等到能查到再说成功
step('等 npm 上能查到新版本')
const deadline = Date.now() + 5 * 60 * 1000
for (;;) {
  try {
    const r = await fetch(`https://registry.npmjs.org/${pkg.name}/${next}`, { signal: AbortSignal.timeout(10000) })
    if (r.ok) break
  } catch { /* 网络抖一下，接着等 */ }
  if (Date.now() > deadline) {
    console.log(`  5 分钟了还查不到 ${next}。npm 有时更慢，过一会儿用 npm view ${pkg.name} version 再看`)
    process.exit(0)
  }
  process.stdout.write('.')
  await new Promise(r => setTimeout(r, 10000))
}
console.log(`\n✓ ${pkg.name}@${next} 已发布：GitHub 提交、标签 ${tag}、npm 都到位了`)
