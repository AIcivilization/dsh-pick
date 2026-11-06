// lib/github.js — 插件仓库在 GitHub 上的数据
//
// npm 下载量回答「多少人在拉」，GitHub 回答「维护得怎么样」：星标、Fork、未关闭的 issue / PR、
// 最近一次提交、是不是已经归档。两边合起来判断才靠谱。
//
// 两种取法：
//   - 每日构建（GitHub Actions）：GraphQL 一次查 50 个仓库，五千个仓库一百来次请求就完。要令牌：
//     Actions 里自带的 GITHUB_TOKEN 就够；本地 build 没设 GITHUB_TOKEN 就跳过这一步
//   - 「我的监控」刷新：REST 逐个查，不用令牌（每小时 60 次，监控列表最多 30 个，够用）
//
// 存进目录的字段名短（五千多个包都要存）：
//   s 星标 · f Fork · i 未关闭的 issue + PR · p 最近一次提交（YYYY-MM-DD）· a 已归档 · l 许可证 · repo owner/name

const GRAPHQL = 'https://api.github.com/graphql'
const REST = 'https://api.github.com/repos/'
const BATCH = 50

/** 从各种写法的仓库地址里取出 owner/name；不是 GitHub 仓库返回 null */
export function parseRepo(url) {
  const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/.exec(String(url || ''))
  if (!m) return null
  const name = m[2].replace(/\.git$/, '')
  if (!name || name === '.' || name === '..') return null
  return `${m[1]}/${name}`
}

const day = iso => (iso ? String(iso).slice(0, 10) : null)

/**
 * 这个仓库的星标能不能算在插件头上。DSH 本体（deepseek-ai/ 下的仓库）不能：
 * 实测有插件把 repository 填成 deepseek-ai/deepseek-harness，凭空「拥有」25 万星。
 * DeepSeek 官方自己的包（@deepseek-ai/ 下）例外
 */
export function countsForPlugin(pkgName, repo) {
  if (!repo) return false
  const owner = repo.split('/')[0].toLowerCase()
  return owner !== 'deepseek-ai' || String(pkgName).startsWith('@deepseek-ai/')
}

function fromGraphql(r, repo) {
  return {
    repo,
    s: r.stargazerCount,
    f: r.forkCount,
    i: (r.issues ? r.issues.totalCount : 0) + (r.pullRequests ? r.pullRequests.totalCount : 0),
    p: day(r.pushedAt),
    a: Boolean(r.isArchived),
    l: (r.licenseInfo && r.licenseInfo.spdxId) || null,
  }
}

/** GraphQL 字符串字面量：仓库名只含 [A-Za-z0-9_.-]（parseRepo 保证），这里再转义一次防万一 */
const lit = s => JSON.stringify(String(s))

/**
 * 批量查仓库（每日构建用）
 * @param {string[]} repos owner/name 列表（会去重）
 * @returns {Promise<Map<string, object>>} 小写的 owner/name → 数据；查不到的不在里面
 */
export async function fetchRepos(repos, { token, fetchImpl = globalThis.fetch, onProgress = () => {} } = {}) {
  const out = new Map()
  if (!token) return out
  // 去重不分大小写（GitHub 仓库名不分），保留第一次出现的写法
  const seen = new Map()
  for (const r of repos) if (r && !seen.has(r.toLowerCase())) seen.set(r.toLowerCase(), r)
  const unique = [...seen.values()]
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH)
    const fields = 'stargazerCount forkCount isArchived pushedAt licenseInfo { spdxId } issues(states: OPEN) { totalCount } pullRequests(states: OPEN) { totalCount }'
    const query = '{' + batch.map((repo, k) => {
      const [owner, name] = repo.split('/')
      return `r${k}: repository(owner: ${lit(owner)}, name: ${lit(name)}) { ${fields} }`
    }).join(' ') + '}'
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetchImpl(GRAPHQL, {
          method: 'POST',
          headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'dsh-pick' },
          body: JSON.stringify({ query }),
          signal: AbortSignal.timeout(30000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const j = await res.json()
        // 仓库删了 / 改名 / 私有：那一项是 null，errors 里有说明，别的照常
        batch.forEach((repo, k) => {
          const r = j.data && j.data[`r${k}`]
          if (r) out.set(repo.toLowerCase(), fromGraphql(r, repo))
        })
        break
      } catch (e) {
        if (attempt === 3) onProgress(`  GitHub 第 ${i / BATCH + 1} 批查不到：${e.message}`)
        else await new Promise(r => setTimeout(r, 1500 * attempt))
      }
    }
    onProgress(`  GitHub ${Math.min(i + BATCH, unique.length)} / ${unique.length}…`)
  }
  return out
}

/**
 * 实时查一个仓库（「我的监控」刷新用，不要令牌）
 * @returns {Promise<object|null>} 查不到返回 null；被限流抛出 code = 'rate-limited' 的错
 */
export async function fetchRepoLive(repo, { fetchImpl = globalThis.fetch, token } = {}) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-pick' }
  if (token) headers.authorization = `bearer ${token}`
  const res = await fetchImpl(REST + repo, { headers, signal: AbortSignal.timeout(10000) })
  if (res.status === 403 || res.status === 429) {
    throw Object.assign(new Error('GitHub 限流了（不登录每小时 60 次），过一会儿再刷新'), { code: 'rate-limited' })
  }
  if (!res.ok) return null
  const r = await res.json()
  return {
    repo: r.full_name || repo,
    s: r.stargazers_count,
    f: r.forks_count,
    // REST 的 open_issues_count 本来就包含未关闭的 PR，和 GraphQL 那边加起来的口径一致
    i: r.open_issues_count,
    p: day(r.pushed_at),
    a: Boolean(r.archived),
    l: (r.license && r.license.spdx_id && r.license.spdx_id !== 'NOASSERTION') ? r.license.spdx_id : null,
  }
}
