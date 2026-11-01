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
    if (String(url).endsWith('/models')) return jsonResponse({ data: [{ id: 'deepseek-flash' }] })
    const body = init?.body ? JSON.parse(init.body) : {}
    const payload = body.max_tokens === 64
      ? { verdict: 'yes' }
      : body.max_tokens === 512
        ? { points: [], semantic: 40 }
        : { title: '测试之杯', body: ['小明走进房间。'] }
    return jsonResponse({
      model: 'deepseek-flash',
      choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }],
    })
  }
}

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
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

/**
 * 回归：Koishi 4.18.11 里用 `/` 注册层级指令只会写叶子名，
 * 导致所有子指令静默落到父指令上。这里逐个验证每个叶子真的能命中。
 */
const ROUTES = [
  { input: '海龟汤 汤库 列表', expect: /汤库（共 1 条/ },
  { input: '海龟汤 汤库 列表 -a', expect: /汤库（共 1 条/ },
  { input: '海龟汤 汤库 查看 测试之杯', expect: /要素：3 条/ },
  { input: '海龟汤 汤库 查看 不存在的汤', expect: /没有找到/ },
  { input: '海龟汤 渲染', expect: /渲染后端/ },
  { input: '海龟汤 渲染 状态', expect: /渲染后端/ },
  { input: '海龟汤 主人', expect: /尚未绑定主人|主人：/ },
  { input: '海龟汤 战绩', expect: /没有进行中/ },
]

test('指令路由：三个层级都能命中，不落到父指令', async (t) => {
  stubFetch()
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('router', 'route-room')
  for (const route of ROUTES) {
    await client.shouldReply(route.input, route.expect)
  }
})

test('指令路由：场次内指令', async (t) => {
  stubFetch()
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('router2', 'route-room-2')
  // 开局 = 汤面 + 规则两条
  await client.shouldReply('海龟汤 开局', [/测试之杯/, /本场规则/])
  // 汤面 = 汤面 + 规则两条
  await client.shouldReply('海龟汤 汤面', [/测试之杯/, /本场规则/])
  await client.shouldReply('海龟汤 状态', /进行中/)
  await client.shouldReply('海龟汤 结束', /提前结束/)
  await client.shouldReply('海龟汤 汤底', /汤底/)
})

test('指令路由：主指令只给摘要，不吞子指令', async (t) => {
  stubFetch()
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('router3', 'route-room-3')
  await client.shouldReply('海龟汤', /没有进行中/)
  await client.shouldReply('海龟汤 开局', [/测试之杯/, /本场规则/])
  const [summary] = await client.receive('海龟汤')
  assert.match(String(summary), /测试之杯/)
  assert.ok(!String(summary).includes('本版须知'), '主指令不应输出子指令的内容')
})
