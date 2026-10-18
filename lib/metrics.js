// lib/metrics.js — 去噪指标
//
// 为什么要有这一层：npm 下载量是噪声极大的指标。我们自己的 5 个包统计里，
// 单日峰值全部落在版本发布日（dsh-vps 于 10-02 连发 7 个版本，单日 1,068）。
// 按原始下载量排序，排出来的是「发版本最勤的那个」，不是「最值得装的那个」。
//
// 所以结论要建立在去噪后的指标上。

export function median(arr) {
  if (!arr || !arr.length) return 0
  const a = [...arr].sort((x, y) => x - y)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2)
}

export function mean(arr) {
  if (!arr || !arr.length) return 0
  return Math.round(arr.reduce((x, y) => x + y, 0) / arr.length)
}

export function sum(arr) {
  if (!arr || !arr.length) return 0
  return arr.reduce((x, y) => x + y, 0)
}

const dayMs = 86400000
const toDay = iso => Math.floor(new Date(iso + 'T00:00:00Z').getTime() / dayMs)

/**
 * 日常基线：扣掉发布日影响后的每日中位数
 * 发布日当天 + 后一天很可能是拉取安装产生的虚高，剔除后再取中位数。
 * 中位数本身对尖峰不敏感，再剔一次发布日就更接近真实使用量。
 * @param {number[]} daily 近 30 天每日下载
 * @param {string[]} releaseDates 该窗口内发布过版本的日期（ISO）
 * @param {string} startISO 窗口首日（ISO）
 * @returns {number}
 */
export function baselineWithStart(daily = [], releaseDates = [], startISO = '') {
  if (!daily.length) return 0
  if (!releaseDates.length || !startISO) return median(daily)

  const spikes = new Set()
  const s = toDay(startISO)
  for (const d of releaseDates) {
    const n = toDay(d)
    if (n >= s && n <= s + daily.length) {
      spikes.add(n - s)        // 发布当天
      spikes.add(n - s + 1)    // 发布次日
    }
  }
  const kept = daily.filter((_, i) => !spikes.has(i))
  return kept.length >= 5 ? median(kept) : median(daily)
}

/**
 * 增速：最近 7 天 ÷ 之前 7 天 - 1
 * 序列长度不足 14 天返回 null（发布时间太短，增速没意义）
 * @returns {number|null}
 */
export function growth(daily = []) {
  if (daily.length < 14) return null
  const last7 = sum(daily.slice(-7))
  const prev7 = sum(daily.slice(-14, -7))
  if (prev7 === 0) return last7 > 0 ? 1 : null
  return (last7 - prev7) / prev7
}

/**
 * 版本节奏：平均几天发一个版本
 * @param {string[]} versionDates 已按时间排序的版本发布时间（ISO 日期）
 * @returns {number|null}
 */
export function cadence(versionDates = []) {
  if (!versionDates || versionDates.length < 2) return null
  const first = toDay(versionDates[0])
  const last = toDay(versionDates[versionDates.length - 1])
  const span = last - first
  if (span <= 0) return 0.1 // 同一天发多个
  return Math.round((span / (versionDates.length - 1)) * 10) / 10
}

/** 距今天数 */
export function ageDays(iso = '', todayISO = '') {
  if (!iso) return null
  const ref = todayISO || new Date().toISOString().slice(0, 10)
  return toDay(ref) - toDay(iso)
}

/**
 * 综合评分 0~100，用于「首选 / 备选」的默认排序依据
 * 权重：日常基线 40% + 增速 25% + 新鲜度 20% + 版本节奏 15%
 * 注意：这是给面板用的默认口径，AI 拿到同样的字段可以自行调整权重并解释
 */
export function score({ baseline: b = 0, growth: g = null, age = null, cadence: c = null }) {
  const baselinePart = clamp01(Math.log10(Math.max(b, 1)) / 4)                    // 1 → 0, 1万 → 1
  const growthPart = g === null ? 0.5 : clamp01((g + 0.5) / 1.5)                  // -50% → 0, +100% → 1
  const agePart = age === null ? 0.4 : clamp01(1 - age / 180)                     // 今天 → 1, 180 天前 → 0
  const cadencePart = c === null ? 0.4 : clamp01(1 - (c - 1) / 21)                // 1天/版 → 1, 22天/版 → 0

  return Math.round(
    baselinePart * 40 + growthPart * 25 + agePart * 20 + cadencePart * 15
  )
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x }
