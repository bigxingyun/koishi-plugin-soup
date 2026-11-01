const test = require('node:test')
const assert = require('node:assert/strict')

const { buildNewspaperHTML, TEMPLATE_VERSION, decodeImage } = require('../lib/render.js')
const { defaultPlan } = require('../lib/game.js')

const baseSheet = (plan) => ({
  plan,
  paperName: '海龟汤晚报',
  issue: 7,
  date: new Date('2026-11-01T10:00:00+08:00'),
  difficulty: 'normal',
  tags: ['测试'],
  questionQuota: 0,
  guessQuota: 3,
  passThreshold: 0.8,
  personalGuessQuota: 0,
  footerHint: true,
})

test('buildNewspaperHTML：汤面里的脚本与标签必须被转义', () => {
  const html = buildNewspaperHTML(baseSheet({
    title: '注入测试',
    body: ['<script>alert(1)</script>', '<img src="http://evil.example/x.png">'],
  }))

  assert.ok(!html.includes('<script>alert(1)</script>'), '脚本标签必须被转义')
  assert.ok(html.includes('&lt;'), '尖括号应转义为实体')
  assert.ok(!html.includes('<script'), '不得残留原始 script 标签')
  assert.ok(!/src="http:\/\//.test(html), '不得出现外链图片')
})

test('buildNewspaperHTML：不引用任何外部资源', () => {
  const html = buildNewspaperHTML(baseSheet({ title: '资源检查', body: ['正文'] }))
  assert.ok(!/(src|href)=["']?https?:/i.test(html), '不得引入远程图片/样式')
  assert.ok(!/url\(\s*['"]?https?:/i.test(html), 'CSS 不得引用远程资源')
  assert.ok(html.includes('data:image/svg+xml'), '纸纹应内联为 SVG data URI')
})

test('buildNewspaperHTML：版式参数被夹紧到合法范围', () => {
  const html = buildNewspaperHTML(baseSheet({
    title: '夹紧',
    body: ['正文', '第二段'],
    style: { fontPx: 40, columns: 2 },
  }))
  const match = /\.body-text\{[^}]*font-size:([\d.]+)px/.exec(html)
  assert.ok(match, '应输出字号')
  const size = Number(match[1])
  assert.ok(size >= 12 && size <= 16.5, `字号被夹紧，实际 ${size}`)
})

test('buildNewspaperHTML：缺 plan 字段时仍能出完整页面', () => {
  const html = buildNewspaperHTML(baseSheet({}))
  assert.ok(html.includes('<!DOCTYPE html>'))
  assert.ok(html.includes('</html>'))
  assert.ok(!html.includes('{{'), '不得残留未替换的占位符')
})

test('defaultPlan：从汤数据推导出可用版面', () => {
  const plan = defaultPlan({
    title: '某某汤',
    surface: '第一段。\n\n第二段。\n\n第三段。',
    difficulty: 'hard',
    tags: ['恐怖'],
  })
  assert.equal(plan.title, '某某汤')
  assert.equal(plan.body.length, 3)
  assert.equal(plan.style.accent, 'blood', '恐怖标签应映射到暗红')
})

test('decodeImage：dataURL 与裸 base64 都能解码', () => {
  const buffer = Buffer.from('hello world')
  const base64 = buffer.toString('base64')
  assert.equal(decodeImage(`data:image/jpeg;base64,${base64}`).toString(), 'hello world')
  assert.equal(decodeImage(base64).toString(), 'hello world')
  assert.equal(decodeImage(''), null)
})

test('buildNewspaperHTML：plain 主题去噪点、去印章', () => {
  const html = buildNewspaperHTML({ ...baseSheet({ title: '干净版', body: ['正文'] }), theme: 'plain' })
  assert.ok(html.includes('class="paper plain"'), '必须挂上 plain 类')
  assert.ok(html.includes('.paper.plain:before{opacity:0}'), 'plain 不画纸纹')
  assert.ok(html.includes('.paper.plain .seal{display:none}'), 'plain 不盖印章')
})

test('buildNewspaperHTML：renderWidth 真的作用到版面上', () => {
  const html = buildNewspaperHTML({ ...baseSheet({ title: '窄版', body: ['正文'] }), width: 520 })
  assert.ok(html.includes('body{width:520px'), 'body 宽度应跟随配置')
  assert.ok(html.includes('.paper{position:relative;width:500px'), '纸张宽度应跟随配置')
  assert.ok(/column-count:1/.test(html), '窄版必须退成单栏，否则两栏挤成一条线')
})

test('TEMPLATE_VERSION：模板改动必须递增版本号以让缓存失效', () => {
  assert.equal(typeof TEMPLATE_VERSION, 'number')
  assert.ok(TEMPLATE_VERSION >= 1)
})
