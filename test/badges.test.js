import { test } from 'node:test'
import assert from 'node:assert/strict'
import { badgePath, badgeJson, badgeMarkdown, overallRanks, buildBadges } from '../lib/badges.js'

const catalog = {
  packages: {
    a: { n: 'a', w: 10, oa: [0.9, null, null, null, null, null] },
    b: { n: 'b', w: 50, oa: [0.5, null, null, null, null, null] },
    '@s/c': { n: '@s/c', w: 5, oa: [0.5, null, null, null, null, null] },
    d: { n: 'd', w: 1 }, // 收录了但没排名
  },
  boards: {
    overall: {
      total: 5,
      angles: ['rec', 'use', 'rep', 'stable', 'rise', 'new'],
      rows: [
        { k: 'a', n: 'a', a: { rec: 0.9 } },
        { k: 'gh:o/r', a: { rec: 0.7 }, w: 0 },
      ],
    },
  },
}

test('徽章路径：npm 包名原样，GitHub-only 放 gh/ 下', () => {
  assert.equal(badgePath('dsh-pet'), 'dsh-pet.json')
  assert.equal(badgePath('@s/c'), '@s/c.json')
  assert.equal(badgePath('gh:o/r'), 'gh/o/r.json')
  assert.match(badgeMarkdown('dsh-pet'), /img\.shields\.io\/endpoint\?url=.*badge%2Fdsh-pet\.json\)\]\(https:\/\/github\.com\/AIcivilization\/dsh-pick\)$/)
})

test('名次：头部行加 oa 分数一起排，同分按周下载', () => {
  const { ranks, total } = overallRanks(catalog)
  assert.deepEqual([...ranks], [['a', 1], ['gh:o/r', 2], ['b', 3], ['@s/c', 4]])
  assert.equal(total, 5)
})

test('徽章文字和颜色', () => {
  assert.equal(badgeJson(3, 20000).message, '#3 of 20,000')
  assert.equal(badgeJson(3, 20000).color, 'brightgreen')
  assert.equal(badgeJson(100, 20000).color, 'green')
  assert.equal(badgeJson(500, 20000).message, 'top 3%')
  assert.equal(badgeJson(500, 20000).color, 'yellowgreen')
  assert.equal(badgeJson(9000, 20000).message, 'top 45%')
  assert.equal(badgeJson(0, 20000).message, 'listed')
  assert.equal(badgeJson(3, 20000).schemaVersion, 1)
})

test('整个目录：有名次的加上收录了没排名的', () => {
  const files = Object.fromEntries(buildBadges(catalog))
  assert.equal(Object.keys(files).length, 5)
  assert.equal(files['gh/o/r.json'].message, '#2 of 5')
  assert.equal(files['d.json'].message, 'listed')
})
