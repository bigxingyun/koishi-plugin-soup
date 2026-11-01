const test = require('node:test')
const assert = require('node:assert/strict')

const { Context } = require('koishi')
const mockPlugin = require('@koishijs/plugin-mock')
const memoryPlugin = require('@koishijs/plugin-database-memory')
const plugin = require('../lib/index.js')
const { issueCode, consumeCode, bindMaster, getMaster, isMaster, pendingKey } = require('../lib/master.js')

const mock = mockPlugin.default ?? mockPlugin
const memory = memoryPlugin.default ?? memoryPlugin

function stubFetch(state = {}) {
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/models')) return jsonResponse({ data: [{ id: 'deepseek-flash' }] })
    const body = init?.body ? JSON.parse(init.body) : {}
    let payload
    if (body.max_tokens === 64) payload = { verdict: state.verdict ?? 'yes' }
    else if (body.max_tokens === 512) payload = state.score ?? { points: [], semantic: 60 }
    else payload = { title: '测试之杯', body: ['小明走进房间，看到桌上有一杯水。'] }
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

// 房间模式开局会多发一条「限时加入」提示，所以是三条
const OPEN_JOINING = [/测试之杯/, /本场规则/, /限时 \d+ 秒/]

test('房间模式：加入 → 发起人开始 → 提问', async (t) => {
  stubFetch({ verdict: 'yes' })
  const app = await createApp({ personalGuessQuota: 2, joinWindow: 10 })
  t.after(() => app.stop())

  const host = app.mock.client('u1', 'room-a')
  const guest = app.mock.client('u2', 'room-a')

  await host.shouldReply('海龟汤 开局', OPEN_JOINING)
  await guest.shouldReply('海龟汤 加入', /已加入（1\/20）/)
  await guest.shouldReply('海龟汤 加入', /已经在本场中/)
  await host.shouldReply('海龟汤 开始', /已开始/)
  await guest.shouldReply('海龟汤 问 杯子里是水吗', /是/)
})

test('房间模式：未加入的玩家不能提交', async (t) => {
  stubFetch({ score: { points: [], semantic: 10 } })
  const app = await createApp({ personalGuessQuota: 2, joinWindow: 10 })
  t.after(() => app.stop())

  const host = app.mock.client('u1', 'room-b')
  const guest = app.mock.client('u2', 'room-b')
  const stranger = app.mock.client('u3', 'room-b')

  await host.shouldReply('海龟汤 开局', OPEN_JOINING)
  await guest.shouldReply('海龟汤 加入', /已加入/)
  await host.shouldReply('海龟汤 开始', /已开始/)
  await stranger.shouldReply('海龟汤 提交 我觉得是水', /请先发送「海龟汤 加入」/)
})

test('房间模式：个人配额用完后回落到公共配额', async (t) => {
  stubFetch({ score: { points: [], semantic: 10 } })
  const app = await createApp({
    personalGuessQuota: 1,
    defaultGuessQuota: 5,
    guessCooldown: 0,
    joinWindow: 10,
  })
  t.after(() => app.stop())

  const host = app.mock.client('u1', 'room-c')
  const guest = app.mock.client('u2', 'room-c')

  await host.shouldReply('海龟汤 开局', OPEN_JOINING)
  await guest.shouldReply('海龟汤 加入', /已加入/)
  await host.shouldReply('海龟汤 开始', /已开始/)

  const [first] = await guest.receive('海龟汤 提交 第一次')
  assert.match(String(first), /个人 0 次 \/ 公共 5 次/, `首次应扣个人配额，实际：${first}`)

  const [second] = await guest.receive('海龟汤 提交 第二次')
  assert.match(String(second), /个人 0 次 \/ 公共 4 次/, `第二次应回落扣公共配额，实际：${second}`)
})

test('房间模式：没有人加入时不能开始', async (t) => {
  stubFetch({})
  const app = await createApp({ personalGuessQuota: 2, joinWindow: 10 })
  t.after(() => app.stop())

  const host = app.mock.client('u1', 'room-d')
  await host.shouldReply('海龟汤 开局', OPEN_JOINING)
  await host.shouldReply('海龟汤 开始', /没人加入|请先|已截止/i)
})

test('主人：绑定密钥只能消费一次', () => {
  const pending = new Map()
  const key = pendingKey('mock', 'bot', 'mock:u1')
  const code = issueCode(pending, key, 600)

  assert.match(code, /^\d{6}$/, '密钥必须是 6 位数字')
  assert.equal(consumeCode(pending, key, '000000' === code ? '111111' : '000000'), false, '错误密钥必须失败')
  assert.equal(consumeCode(pending, key, code), true, '正确密钥应当通过')
  assert.equal(consumeCode(pending, key, code), false, '同一密钥不能二次使用')
})

test('主人：过期的密钥必须失效', () => {
  const pending = new Map()
  const key = pendingKey('mock', 'bot', 'mock:u1')
  const code = issueCode(pending, key, -1) // 直接构造一个已过期项
  assert.equal(consumeCode(pending, key, code), false)
})

test('主人：绑定后可以改设置，换人则被拒绝', async (t) => {
  stubFetch({})
  const app = await createApp()
  t.after(() => app.stop())

  const bot = app.bots[0]
  assert.ok(bot, '应有 mock bot')
  const masterUserId = `${bot.platform}:alice`

  await bindMaster(app, bot.platform, bot.selfId, masterUserId)
  assert.equal(await isMaster(app, bot.platform, bot.selfId, masterUserId), true)
  const row = await getMaster(app, bot.platform, bot.selfId)
  assert.equal(row.userId, masterUserId)

  const alice = app.mock.client('alice', 'master-room')
  const bob = app.mock.client('bob', 'master-room')

  await alice.shouldReply('海龟汤 主人', /alice/)
  await alice.shouldReply('海龟汤 主人 设置 阈值 90', /已设为 90/)
  await bob.shouldReply('海龟汤 主人 设置 阈值 70', /没有权限/)
  await alice.shouldReply('海龟汤 主人 解绑', /已解绑/)
  await alice.shouldReply('海龟汤 主人 设置 阈值 70', /尚未绑定主人/)
})

test('主人：已有主人时不能再绑定第二次', async (t) => {
  stubFetch({})
  const app = await createApp()
  t.after(() => app.stop())

  const bot = app.bots[0]
  await bindMaster(app, bot.platform, bot.selfId, `${bot.platform}:alice`)
  assert.equal(await bindMaster(app, bot.platform, bot.selfId, `${bot.platform}:bob`), false)

  const bob = app.mock.client('bob', 'master-room-2')
  await bob.shouldReply('海龟汤 主人 绑定', /已有主人/)
})
