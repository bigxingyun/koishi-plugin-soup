const test = require('node:test')
const assert = require('node:assert/strict')

const { Context } = require('koishi')
const mockPlugin = require('@koishijs/plugin-mock')
const memoryPlugin = require('@koishijs/plugin-database-memory')
const plugin = require('../lib/index.js')

const mock = mockPlugin.default ?? mockPlugin
const memory = memoryPlugin.default ?? memoryPlugin

/** 可编程的假 fetch：判词/评分/版面规划走完整链路，但不真的联网 */
function stubFetch(state) {
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/models')) {
      return jsonResponse({ data: [{ id: 'deepseek-flash' }] })
    }
    const body = init?.body ? JSON.parse(init.body) : {}
    let payload
    if (body.max_tokens === 64) payload = { verdict: state.verdict ?? 'yes' }
    else if (body.max_tokens === 512) payload = state.score ?? { points: [], semantic: 90 }
    else payload = { title: '测试之杯', body: ['小明走进房间，看到桌上有一杯水。'] }

    state.calls = (state.calls ?? 0) + 1
    return jsonResponse({
      model: 'deepseek-flash',
      choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }],
    })
  }
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

async function createApp(overrides = {}) {
  const app = new Context()
  app.plugin(mock)
  app.plugin(memory)
  app.plugin(plugin, {
    talesDir: 'tests/fixtures/tales',
    apiKey: 'sk-test',
    modelCheck: false,
    renderMode: 'text',
    autoImport: true,
    ...overrides,
  })
  await app.start()
  return app
}

/** 开局固定两条消息：汤面 + 规则。断言时必须两条一起收，否则会串到下一条断言 */
const OPEN = [/测试之杯/, /本场规则/]

test('开局：汤面与规则分两条发出', async (t) => {
  stubFetch({})
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('u1')
  await client.shouldReply('海龟汤 开局', OPEN)
  await client.shouldReply('海龟汤 状态', /测试之杯/)
})

test('提问：只回判词，不夹带解释', async (t) => {
  stubFetch({ verdict: 'yes' })
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('u2')
  await client.shouldReply('海龟汤 开局', OPEN)
  const reply = await client.shouldReply('海龟汤 问 杯子里装的是普通的水吗', /是/)
  assert.ok(!String(reply).includes('因为'), '判词不得夹带解释')
})

test('提交：过线即结算并公布汤底', async (t) => {
  stubFetch({
    score: { points: [{ id: 1, hit: 'yes' }, { id: 2, hit: 'yes' }, { id: 3, hit: 'yes' }], semantic: 96 },
  })
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('u3')
  await client.shouldReply('海龟汤 开局', OPEN)
  await client.shouldReply('海龟汤 提交 杯子里是母亲的遗物，纸条是她留的遗言', /通过/)
  await client.shouldReply('海龟汤 问 还在吗', /已结束|没有进行中/)
})

test('提交：未过线时给出相似度与剩余次数', async (t) => {
  stubFetch({ score: { points: [{ id: 1, hit: 'no' }, { id: 2, hit: 'no' }, { id: 3, hit: 'no' }], semantic: 10 } })
  const app = await createApp({ defaultGuessQuota: 3 })
  t.after(() => app.stop())

  const client = app.mock.client('u4')
  await client.shouldReply('海龟汤 开局', OPEN)
  const [reply] = await client.receive('海龟汤 提交 他渴了')
  assert.match(String(reply), /相似度/)
  assert.match(String(reply), /剩余提交/)
})

test('开局：同一频道不能双开', async (t) => {
  stubFetch({})
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('u5')
  await client.shouldReply('海龟汤 开局', OPEN)
  await client.shouldReply('海龟汤 开局', /正在进行/)
})

test('配额：公共提交次数用尽后自动结算', async (t) => {
  stubFetch({ score: { points: [], semantic: 5 } })
  const app = await createApp({ defaultGuessQuota: 1, passThreshold: 0.8, guessCooldown: 0 })
  t.after(() => app.stop())

  const client = app.mock.client('u6')
  await client.shouldReply('海龟汤 开局', OPEN)
  await client.shouldReply('海龟汤 提交 第一次', /相似度/)
  await client.shouldReply('海龟汤 提交 第二次', /提交次数已用完/)
  await client.shouldReply('海龟汤 状态', /没有进行中/)
})

test('未配置 API Key：提问给出明确提示', async (t) => {
  const previous = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  t.after(() => {
    if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous
  })
  stubFetch({})
  const app = await createApp({ apiKey: '' })
  t.after(() => app.stop())

  const client = app.mock.client('u7')
  await client.shouldReply('海龟汤 开局', OPEN)
  await client.shouldReply('海龟汤 问 她是死了吗', /尚未配置 AI 服务/)
})

test('主人：未绑定时管理指令被拒绝', async (t) => {
  stubFetch({})
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('u8')
  await client.shouldReply('海龟汤 汤库', /测试之杯/)
  await client.shouldReply('海龟汤 主人 设置 阈值 90', /尚未绑定主人/)
  await client.shouldReply('海龟汤 汤库 停用 测试之杯', /尚未绑定主人/)
})

test('旧语法：两段式写法给出迁移提示', async (t) => {
  stubFetch({})
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('u9')
  await client.shouldReply('海龟汤 绑定', /已调整为/)
})

test('无进行中场次时提问被拒绝', async (t) => {
  stubFetch({})
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('u10')
  await client.shouldReply('海龟汤 问 有人吗', /没有进行中/)
})
