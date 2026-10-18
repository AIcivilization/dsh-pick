// lib/words.js — 需求 → 搜索词
//
// 这一层是纯函数，不依赖 Node，所以 lib/engine.js（CLI/宿主端）和
// web/panel.js（浏览器）都能 import 同一份，避免两套实现各自漂移。
//
// 三层展开，否则中文需求在英文关键词面前命中率极低：
//   1) 用户原词（权重 3）
//   2) 同义词词典：「数据库」→ sql/database/postgres…（权重 2）
//   3) 长中文词二元切分：「数据库管理」→ 数据/据库/管理（权重 1，兜底词典没覆盖的说法）

export const STOP = new Set(['什么', '怎么', '如何', '可以', '一个', '我想', '我要', '需要', '有没有',
  'what', 'how', 'the', 'and', 'for', 'with', 'can', 'you', 'help', 'please', '插件', '东西', '工具', '功能'])

export const SYNONYMS = {
  '数据库': ['sql', 'database', 'db', 'postgres', 'mysql', 'sqlite', 'redis', 'mongo'],
  '微信': ['wechat', 'wecom', 'weixin'],
  '企业微信': ['wecom', 'wechat'],
  '飞书': ['feishu', 'lark'],
  '通知': ['notify', 'notification', 'message', 'im'],
  '记忆': ['memory', 'context', 'recall', 'session'],
  '搜索': ['search', 'web-search', 'retrieval'],
  '远程': ['remote', 'ssh', 'vps', 'server'],
  '服务器': ['server', 'vps', 'ssh', 'host'],
  '部署': ['deploy', 'install', 'setup', 'self-hosted'],
  '美化': ['theme', 'skin', 'wallpaper', 'appearance', 'ui'],
  '界面': ['web-ui', 'ui', 'sidebar', 'theme', 'appearance'],
  '终端': ['terminal', 'tui', 'shell', 'cli'],
  '费用': ['cost', 'billing', 'usage', 'price', 'quota'],
  '统计': ['stats', 'meter', 'usage', 'audit'],
  '图片': ['image', 'vision', 'generation'],
  '视频': ['video', 'live', 'camera'],
  '语音': ['voice', 'audio', 'tts'],
  '安全': ['security', 'sandbox', 'auth', 'permission', 'safety'],
  '权限': ['permission', 'auth', 'approval'],
  '审查': ['review', 'audit', 'lint', 'diff'],
  '代码': ['code', 'git', 'diff', 'review', 'repo'],
  '文档': ['markdown', 'office', 'pdf', 'doc', 'note'],
  '模型': ['model', 'llm', 'provider', 'gateway'],
  '网关': ['gateway', 'router', 'proxy'],
  '插件': ['plugin', 'marketplace', 'install'],
  '智能体': ['agent', 'subagent', 'team'],
  '自动化': ['automation', 'workflow', 'schedule', 'task'],
  '备份': ['backup', 'archive', 'restore'],
  '导入': ['import', 'export', 'migrate'],
  '翻译': ['translate', 'i18n', 'lang'],
  '墙纸': ['wallpaper', 'background', 'skin'],
  '文件': ['file', 'fs', 'edit'],
  '管理': ['manager', 'manage', 'admin'],
}

/**
 * @param {string} need 用户原话
 * @returns {{w:string, weight:number}[]}
 */
export function expandWords(need) {
  const raw = String(need || '').toLowerCase()
    .split(/[\s,，、。？?！!/；;：:()（）"'《》【】\[\]+]+/).map(w => w.trim())
    .filter(w => w.length >= 2 && !STOP.has(w))

  const out = []
  for (const w of raw) {
    out.push({ w, weight: 3 })
    const syn = SYNONYMS[w]
    if (syn) for (const s of syn) out.push({ w: s, weight: 2 })
    // 长中文词切二元，兜底同义词词典没覆盖的说法
    if (/[\u4e00-\u9fa5]/.test(w) && w.length >= 4) {
      for (let i = 0; i + 2 <= w.length; i++) out.push({ w: w.slice(i, i + 2), weight: 1 })
    }
  }
  return out
}
