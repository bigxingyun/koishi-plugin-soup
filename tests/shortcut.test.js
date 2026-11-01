const test = require('node:test')
const assert = require('node:assert/strict')

const { Context } = require('koishi')
const mockPlugin = require('@koishijs/plugin-mock')
const memoryPlugin = require('@koishijs/plugin-database-memory')
const plugin = require('../lib/index.js')

const mock = mockPlugin.default ?? mockPlugin
const memory = memoryPlugin.default ?? memoryPlugin

function stubFetch() {
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/models')) return json({ data: [{ id: 'deepseek-flash' }] })
    const body = init?.body ? JSON.parse(init.body) : {}
    const payload = body.max_tokens === 64 ? { verdict: 'yes' } : { points: [], semantic: 50 }
    return json({
      model: 'deepseek-flash',
      choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }],
    })
  }
}

function json(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
}

async function createApp(overrides = {}) {
  const app = new Context()
  app.plugin(mock)
  app.plugin(memory)
  app.plugin(plugin, {
    talesDir: 'tests/fixtures/tales',
    apiKey: 'sk-short',
    modelCheck: false,
    renderMode: 'text',
    autoImport: true,
    seedBundled: false,
    ...overrides,
  })
  await app.start()
  return app
}

const OPEN = [/测试之杯/, /本场规则/]

test('短别名：汤 / 开局 / 问 / 提交 都能用', async (t) => {
  stubFetch()
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('a1', 'alias-room')

  await client.shouldReply('汤 开局', OPEN)
  await client.shouldReply('问 她哭了吗', /是/)

  const [guess] = await client.receive('提交 杯子是母亲的遗物')
  assert.match(String(guess), /相似度/)

  await client.shouldReply('汤 状态', /测试之杯/)
})

test('短别名：单独一个「开局」也能开局', async (t) => {
  stubFetch()
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('a2', 'alias-room-2')
  await client.shouldReply('开局', OPEN)
})

test('引用即提问：引用 bot 消息时普通文本直接当提问', async (t) => {
  stubFetch()
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('q1', 'quote-room')
  await client.shouldReply('汤 开局', OPEN)

  // mock 支持以 <quote id="x"/> 前缀构造引用消息
  const replies = await client.receive('<quote id="m1"/>她是不是死了')
  assert.equal(replies.length, 1)
  assert.match(String(replies[0]), /^是|^不是|^无关/)
})

test('引用即提问：没有进行中场次时不触发', async (t) => {
  stubFetch()
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('q2', 'quote-room-2')
  await client.shouldNotReply('<quote id="m1"/>她是不是死了')
})

test('引用即提问：指令优先，引用状态下发指令仍走指令', async (t) => {
  stubFetch()
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('q3', 'quote-room-3')
  await client.shouldReply('汤 开局', OPEN)

  const [status] = await client.receive('<quote id="m1"/>海龟汤 状态')
  assert.match(String(status), /测试之杯/)
  assert.doesNotMatch(String(status), /^是$|^不是$|^无关$/)
})

test('引用即提问：quoteAsk 关闭时普通文本不触发', async (t) => {
  stubFetch()
  const app = await createApp({ quoteAsk: false })
  t.after(() => app.stop())

  const client = app.mock.client('q4', 'quote-room-4')
  await client.shouldReply('汤 开局', OPEN)
  await client.shouldNotReply('<quote id="m1"/>她是不是死了')
})

test('短别名：shortCommands 关闭时别名不生效', async (t) => {
  stubFetch()
  const app = await createApp({ shortCommands: false })
  t.after(() => app.stop())

  const client = app.mock.client('a3', 'alias-room-3')
  await client.shouldNotReply('汤 开局')
  await client.shouldNotReply('问 她哭了吗')
  // 正式写法仍然可用
  await client.shouldReply('海龟汤 开局', OPEN)
})

test('短别名：启动「开始」不抢占「结束」的语义', async (t) => {
  stubFetch()
  const app = await createApp({ personalGuessQuota: 2, joinWindow: 10 })
  t.after(() => app.stop())

  const host = app.mock.client('a4', 'alias-room-4')
  const guest = app.mock.client('a5', 'alias-room-4')

  await host.shouldReply('汤 开局', [/测试之杯/, /本场规则/, /限时/])
  await guest.shouldReply('海龟汤 加入', /已加入/)
  await host.shouldReply('汤 开始', /已开始/)
  await host.shouldReply('汤 结束', /提前结束|本场由/)
})
