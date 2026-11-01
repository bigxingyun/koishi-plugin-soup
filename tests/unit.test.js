const test = require('node:test')
const assert = require('node:assert/strict')

const { computeScore, sanitizePlan, parseJSON } = require('../lib/ai.js')
const { cleanSurface, findLeak, splitMessage, normalizeQuestion, clamp } = require('../lib/util.js')

test('computeScore：要素命中占 60%，语义分占 40%', () => {
  const keys = [
    { id: 1, text: 'a', weight: 1 },
    { id: 2, text: 'b', weight: 1 },
  ]
  // 全命中 + 语义 100 → 100
  assert.equal(computeScore([{ id: 1, hit: 'yes' }, { id: 2, hit: 'yes' }], 100, keys).score, 100)
  // 全未命中 + 语义 0 → 0
  assert.equal(computeScore([{ id: 1, hit: 'no' }, { id: 2, hit: 'no' }], 0, keys).score, 0)
  // 命中一半 + 语义 50 → 0.6*0.5 + 0.4*0.5 = 0.5 → 50
  assert.equal(computeScore([{ id: 1, hit: 'yes' }, { id: 2, hit: 'no' }], 50, keys).score, 50)
  // partial 计半分：命中率 0.25 → 0.6 × 0.25 = 15
  assert.equal(computeScore([{ id: 1, hit: 'partial' }, { id: 2, hit: 'no' }], 0, keys).score, 15)
})

test('computeScore：没有关键要素时退化为纯语义分', () => {
  assert.equal(computeScore([], 73, []).score, 73)
  assert.equal(computeScore([], 120, []).score, 100)
})

test('sanitizePlan：丢弃非法字段并夹紧枚举', () => {
  const plan = sanitizePlan({
    title: '一二三四五六七八九十一二三四五',
    kicker: '短引题',
    style: { accent: 'neon', columns: 3, dropCap: true },
    stamp: { text: '六个字的印章' },
    evil: '<script>alert(1)</script>',
  }, { title: '兜底', difficulty: 'normal', tags: [], surface: '汤面' })

  assert.equal(plan.title.length, 14)
  assert.equal(plan.style.accent, undefined, '未知 accent 必须被丢弃')
  assert.equal(plan.style.columns, 2, '非法栏数回退 2')
  assert.equal(plan.stamp.text.length, 4, '印章最多 4 字')
  assert.equal(plan.evil, undefined, '白名单外字段必须消失')
})

test('parseJSON：能吃代码块与前后噪音', () => {
  assert.deepEqual(parseJSON('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseJSON('好的：{"a":1} 以上'), { a: 1 })
  assert.throws(() => parseJSON('完全不是 json'), /无法解析|空/)
})

test('cleanSurface：剥 HTML、留内容、压空行', () => {
  const raw = '<b>第一周</b>：我们上了年糕<br>街坊都说好吃\n\n\n\n<span style="color:red">我很害怕</span>'
  const text = cleanSurface(raw)
  assert.match(text, /第一周/)
  assert.match(text, /我很害怕/)
  assert.ok(!text.includes('<'), '不得残留 HTML 标签')
  assert.ok(!/\n{3,}/.test(text), '连续空行必须压缩')
})

test('findLeak：汤面含汤底原句时必须报警', () => {
  const answer = '凶手把尸体藏进冰柜后面的储物间，并且把现场打扫得干干净净'
  assert.equal(findLeak('冰柜里什么都没有', answer), null)
  assert.equal(findLeak('警察打开了尸体藏进冰柜后面的储物间', answer), '尸体藏进冰柜后面的储物间')
})

test('splitMessage：切段后不丢正文', () => {
  const text = '第一段。'.repeat(50) + '\n\n' + '第二段。'.repeat(50)
  const chunks = splitMessage(text, 120)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(chunk.length <= 200)
  assert.equal(
    chunks.join('').replace(/\s/g, ''),
    text.replace(/\s/g, ''),
    '切段只允许丢空白，不允许丢字',
  )
})

test('normalizeQuestion：全角转半角并去首尾标点', () => {
  assert.equal(normalizeQuestion('　她是不是死了？！ '), '她是不是死了')
})

test('clamp：越界夹紧，非数字回退', () => {
  assert.equal(clamp(40, 12, 16.5, 14.5), 16.5)
  assert.equal(clamp('abc', 12, 16.5, 14.5), 14.5)
  assert.equal(clamp(14, 12, 16.5, 14.5), 14)
})
