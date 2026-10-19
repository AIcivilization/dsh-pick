// 测试用的小目录：字段形状和 data/catalog.json 一样，内容固定，结果不随真实数据变
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const deep = (base, growth, cadence, age, s) => ({ daily: [], base, growth, cadence, age, lastRelease: '2026-10-10', versions: 20, s })

export function makeCatalog({ anchor = '2026-10-13', asOf = '2026-10-18', extra = 0 } = {}) {
  const packages = {
    'dsh-sql': { n: 'dsh-sql', v: '0.4.5', d: '连接 SQLite、MySQL 或 PostgreSQL，查询数据库', kw: ['dsh-plugin', 'sql', 'database'], w: 532, m: 2180, cat: '代码与开发', deep: deep(78, 0.01, 5.6, 13, 58), inst: { b: true, p: 'web', r: null } },
    'dsh-database-explorer': { n: 'dsh-database-explorer', v: '0.9.25', d: 'Database explorer: SQLite / MySQL / PostgreSQL / Redis', kw: ['dsh-plugin', 'database'], w: 791, m: 1130, cat: '代码与开发', inst: { b: true, p: 'web', r: '^0.2.0-rc.1' } },
    'dsh-mnemon': { n: 'dsh-mnemon', v: '1.0.0', d: 'Composable memory for DeepSeek Harness', kw: ['dsh-plugin', 'memory'], w: 10102, m: 40000, cat: '记忆与上下文', deep: deep(1005, 0.21, 0.9, 1, 77), inst: { b: true, p: 'web', r: null } },
    'meow-memory': { n: 'meow-memory', v: '0.31.0', d: 'Cross-session project memory', kw: ['dsh-plugin', 'memory'], w: 3259, m: 9000, cat: '记忆与上下文', deep: deep(264, 0.77, 1.9, 10, 79), inst: { b: true, p: 'web', r: null } },
    'dsh-tui-memory': { n: 'dsh-tui-memory', v: '0.1.0', d: 'memory for the terminal UI', kw: ['dsh-plugin', 'memory'], w: 40, m: 120, cat: '记忆与上下文', inst: { b: true, p: 'tui', r: null } },
    'dsh-no-bundle': { n: 'dsh-no-bundle', v: '0.0.1', d: 'a library that forgot dsh.bundle', kw: ['dsh-plugin', 'memory'], w: 12, m: 30, cat: '记忆与上下文', inst: { b: false, p: null, r: null } },
    'dsh-pick': { n: 'dsh-pick', v: '0.3.1', d: '选插件', kw: ['dsh-plugin'], w: 300, m: 900, cat: '插件市场与工具链' },
  }
  // 凑够包数（remote.validCatalog 要求至少 500 个）
  for (let i = 0; i < extra; i++) {
    packages[`pad-${i}`] = { n: `pad-${i}`, v: '1.0.0', d: 'padding', kw: [], w: i, m: i, cat: '其他' }
  }
  return { tool: 'dsh-pick', anchor, asOf, total: Object.keys(packages).length, packages }
}

/** 一个干净的 DSH_HOME（每个测试自己的） */
export async function tempHome() {
  return mkdtemp(join(tmpdir(), 'dsh-pick-test-'))
}

/** 假 fetch：按 URL 关键字返回固定内容；记录调用过哪些 URL */
export function fakeFetch(routes) {
  const calls = []
  const fn = async (url) => {
    calls.push(String(url))
    for (const [key, value] of Object.entries(routes)) {
      if (String(url).includes(key)) {
        if (value instanceof Error) throw value
        if (typeof value === 'number') return new Response('', { status: value })
        return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200 })
      }
    }
    return new Response('', { status: 404 })
  }
  fn.calls = calls
  return fn
}
