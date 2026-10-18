// lib/classify.js — DSH 插件分类
//
// 三级判定：关键词命中（权重 3） > 包名命中（2） > 描述命中（1）。
// 得分低于阈值归「其他」。
// 这套规则是兜底；P2 会由宿主端批量跑语义分类覆盖（准确率 65% → 90%+）。

export const CATEGORIES = [
  { label: '界面与主题',      keys: ['web-ui', 'theme', 'skin', 'ui', 'sidebar', 'wallpaper', 'appearance', 'visual', 'font', 'layout', 'render', 'css', 'design', 'widget', 'pet', 'dafeiyu', 'screenshot'] },
  { label: '记忆与上下文',    keys: ['memory', 'context', 'session', 'rewind', 'palimpsest', 'mnemon', 'recall', 'archive', 'compact'] },
  { label: '模型与网关',      keys: ['model-provider', 'llm-gateway', 'provider', 'llm', 'codex', 'claude-code', 'chatgpt', 'openai', 'model', 'gateway', 'router', 'proxy', 'subscription', 'token'] },
  { label: '搜索与检索',      keys: ['web-search', 'search', 'retrieval', 'rag', 'find', 'index', 'crawl'] },
  { label: '用量与计费',      keys: ['cost', 'usage', 'balance', 'quota', 'billing', 'price', 'credit', 'billing'] },
  { label: '自动化与多智能体', keys: ['automation', 'agent', 'subagent', 'agent-teams', 'agent-preset', 'workflow', 'schedule', 'task', 'orchestr', 'team', 'cron'] },
  { label: '远程与部署',      keys: ['vps', 'ssh', 'remote', 'deploy', 'tunnel', 'mobile', 'pocket', 'bridge', 'self-hosted', 'server', 'docker', 'home'] },
  { label: '文档与办公',      keys: ['markdown', 'office', 'univer', 'tiddlywiki', 'doc', 'note', 'pdf', 'excel', 'paper', 'ocr', 'reader', 'write'] },
  { label: '媒体与生成',      keys: ['image', 'vision', 'voice', 'video', 'audio', 'generation', 'tts', 'live', 'camera', 'draw', 'music'] },
  { label: '集成与连接',      keys: ['mcp', 'im', 'feishu', 'wechat', 'wecom', 'github', 'connector', 'telegram', 'slack', 'discord', 'messenger', 'bot', 'notify', 'notification', 'message'] },
  { label: '插件市场与工具链', keys: ['marketplace', 'market', 'plugin-manager', 'plugin-update', 'updates', 'bundle', 'cli', 'plugin-console', 'install', 'shop', 'share'] },
  { label: '安全与权限',      keys: ['approval', 'gate', 'verify', 'permission', 'safety', 'sandbox', 'auth', 'secret', 'security', 'pentest'] },
  { label: '代码与开发',      keys: ['git', 'code', 'review', 'test', 'lint', 'refactor', 'build', 'typescript', 'file', 'edit', 'patch', 'diff', 'repo', 'worktree'] },
]

export const OTHER = '其他'

/**
 * 分类单个插件
 * @param {string} name 包名
 * @param {string[]} kws 关键词
 * @param {string} desc 描述
 * @returns {string}
 */
export function classify(name, kws = [], desc = '') {
  const kwLower = new Set(kws.map(k => String(k).toLowerCase()))
  const text = (name + ' ' + (desc || '')).toLowerCase()
  const scores = new Map()

  for (const cat of CATEGORIES) {
    let s = 0
    for (const k of cat.keys) {
      if (kwLower.has(k)) s += 3
      if (text.includes(k)) s += 1
    }
    if (s > 0) scores.set(cat.label, s)
  }

  if (scores.size === 0) return OTHER
  let best = null, bestScore = 0
  for (const [label, s] of scores) {
    if (s > bestScore) { best = label; bestScore = s }
  }
  return bestScore >= 2 ? best : OTHER
}

export function allCategories() {
  return CATEGORIES.map(c => c.label).concat([OTHER])
}
