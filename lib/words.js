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

// 整句话里的口头词：「我想装个数据库」要先去掉「我想」「装个」，剩下的才是要找的东西
const FILLER = /我想|我要|想要|帮我|给我|有没有|能不能|有什么|一个|一款|装个|装一个|安装|需要|什么|怎么|如何|可以|插件|工具|东西|功能|哪个|哪些|好用|推荐|的|吗|呢/g

/**
 * @param {string} need 用户原话
 * @returns {{w:string, weight:number}[]}
 */
export function expandWords(need) {
  const raw = String(need || '').toLowerCase()
    .split(/[\s,，、。？?！!/；;：:()（）"'《》【】\[\]+]+/)
    // 中文整句：去掉口头词再切开
    .flatMap(w => (/[\u4e00-\u9fa5]/.test(w) ? w.replace(FILLER, ' ').split(/\s+/) : [w]))
    .map(w => w.trim())
    .filter(w => w.length >= 2 && !STOP.has(w))

  const best = new Map() // 同一个词只留最高权重
  const add = (w, weight) => { if ((best.get(w) || 0) < weight) best.set(w, weight) }
  for (const w of raw) {
    add(w, 3)
    const syn = SYNONYMS[w]
    if (syn) for (const s of syn) add(s, 2)
    if (/[\u4e00-\u9fa5]/.test(w)) {
      // 词典里的词藏在长一点的说法里（「数据库管理」里的「数据库」）：照样认出来
      for (const key of Object.keys(SYNONYMS)) {
        if (key !== w && w.includes(key)) {
          add(key, 3)
          for (const s of SYNONYMS[key]) add(s, 2)
        }
      }
      // 长中文词切二元，兜底同义词词典没覆盖的说法
      if (w.length >= 4) for (let i = 0; i + 2 <= w.length; i++) add(w.slice(i, i + 2), 1)
    }
  }
  return [...best].map(([w, weight]) => ({ w, weight }))
}
