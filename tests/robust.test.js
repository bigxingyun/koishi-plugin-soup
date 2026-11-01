const test = require('node:test')
const assert = require('node:assert/strict')

const { Context } = require('koishi')
const mockPlugin = require('@koishijs/plugin-mock')
const memoryPlugin = require('@koishijs/plugin-database-memory')
const plugin = require('../lib/index.js')
const { normalizeVerdict } = require('../lib/ai.js')

const mock = mockPlugin.default ?? mockPlugin
const memory = memoryPlugin.default ?? memoryPlugin

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

/** 可控的假 AI：mode=ok 正常判词；mode=down 一律连不上 */
function stubFetch(mode = 'ok', state = {}) {
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/models')) return jsonResponse({ data: [{ id: 'deepseek-flash' }] })
    if (mode === 'down') throw new TypeError('fetch failed')

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

async function createApp(overrides = {}) {
  const app = new Context()
  app.plugin(mock)
  app.plugin(memory)
  app.plugin(plugin, {
    talesDir: 'tests/fixtures/tales',
    apiKey: 'sk-robust',
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
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('AI 断线：提问即收场，说明原因并交出汤底', async (t) => {
  stubFetch('down')
  const app = await createApp({ maxRetries: 0 })
  t.after(() => app.stop())

  const client = app.mock.client('n1', 'net-room')
  await client.shouldReply('海龟汤 开局', OPEN)

  const [reply] = await client.receive('海龟汤 问 她哭了吗')
  const text = String(reply)
  assert.match(text, /AI 没连通/, '必须直说 AI 没连上，不能只说稍后重试')
  assert.match(text, /汤底/, '散场时必须交底')
  assert.match(text, /妈妈|遗物|杯子/, '汤底正文要真的发出来')

  await client.shouldReply('海龟汤 状态', /没有进行中/)

  const rows = await app.database.get('situation_puzzle_session', { channelKey: 'mock:net-room' })
  assert.equal(rows[0].status, 'settled')
  assert.equal(rows[0].endReason, 'error')
  assert.equal(rows[0].questionsUsed, 0, 'AI 失败不得扣提问次数')
})

test('AI 断线：提交阶段同样收场，不吞提交次数', async (t) => {
  stubFetch('down')
  const app = await createApp({ maxRetries: 0 })
  t.after(() => app.stop())

  const client = app.mock.client('n2', 'net-submit')
  await client.shouldReply('海龟汤 开局', OPEN)
  const [reply] = await client.receive('海龟汤 提交 她是被冻死的')
  assert.match(String(reply), /AI 没连通/)

  const rows = await app.database.get('situation_puzzle_session', { channelKey: 'mock:net-submit' })
  assert.equal(rows[0].guessesUsed, 0, 'AI 失败不得扣提交次数')
  assert.equal(rows[0].endReason, 'error')
})

test('quoteAsk: 引用别人的消息时 bot 不插话', async (t) => {
  stubFetch()
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('q1', 'quote-foreign')
  await client.shouldReply('海龟汤 开局', OPEN)

  const bot = app.mock.bots[0]
  const original = bot.getMessage
  bot.getMessage = async (channelId, id) => ({ id, content: '', user: { id: 'someone-else' } })
  t.after(() => { bot.getMessage = original })

  await client.shouldNotReply('<quote id="m9"/>她是不是死了')
})

test('quoteAsk: 引用 bot 的消息才当提问', async (t) => {
  stubFetch()
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('q2', 'quote-self')
  await client.shouldReply('海龟汤 开局', OPEN)

  const bot = app.mock.bots[0]
  const original = bot.getMessage
  bot.getMessage = async (channelId, id) => ({ id, content: '', user: { id: bot.selfId } })
  t.after(() => { bot.getMessage = original })

  const [reply] = await client.receive('<quote id="m1"/>她是不是死了')
  assert.match(String(reply), /^(是|不是|无关)/)
})

test('quoteAsk: 引用 bot 但没写文字（只有图）不触发', async (t) => {
  stubFetch()
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('q3', 'quote-image')
  await client.shouldReply('海龟汤 开局', OPEN)
  await client.shouldNotReply('<quote id="m1"/><img src="https://example.com/a.png"/>')
})

test('quoteAsk: 集结阶段不抢答', async (t) => {
  stubFetch()
  const app = await createApp({ personalGuessQuota: 2, joinWindow: 30 })
  t.after(() => app.stop())

  const client = app.mock.client('q4', 'quote-joining')
  await client.shouldReply('海龟汤 开局', [/测试之杯/, /本场规则/, /限时/])
  await client.shouldNotReply('<quote id="m1"/>她是不是死了')
})

test('提前开始不能把超时计时器一起撤掉', async (t) => {
  stubFetch()
  const app = await createApp({ personalGuessQuota: 2, joinWindow: 10, maxDuration: 1 })
  t.after(() => app.stop())

  const host = app.mock.client('h1', 'duration-room')
  const guest = app.mock.client('h2', 'duration-room')
  await host.shouldReply('汤 开局', [/测试之杯/, /本场规则/, /限时/])
  await guest.shouldReply('海龟汤 加入', /已加入/)
  await host.shouldReply('汤 开始', /已开始/)

  await wait(1500)

  const rows = await app.database.get('situation_puzzle_session', { channelKey: 'mock:duration-room' })
  assert.equal(rows[0].status, 'settled', '提前开局后仍应按时长收场')
  assert.equal(rows[0].endReason, 'timeout')

  const said = host.replies.join('\n')
  assert.match(said, /超时/, '超时必须在频道里说一声')
  assert.match(said, /汤底/, '超时也要交底，不能悄悄结束')

  const probe = app.mock.client('h3', 'duration-room')
  await probe.shouldReply('海龟汤 状态', /没有进行中/)
})

test('开场提示里的判词说明可以关掉', async (t) => {
  stubFetch()
  const app = await createApp({ answeringHint: false })
  t.after(() => app.stop())

  const client = app.mock.client('h5', 'hint-room')
  const replies = await client.receive('海龟汤 开局')
  const rules = String(replies[1] ?? '')
  assert.match(rules, /本场规则/)
  assert.doesNotMatch(rules, /主持人只回答/)
})

test('战绩里的参与人数按真实用户统计', async (t) => {
  stubFetch('ok', {
    score: { points: [{ id: 1, hit: 'yes' }, { id: 2, hit: 'yes' }, { id: 3, hit: 'yes' }], semantic: 99 },
  })
  const app = await createApp({ questionCooldown: 0 })
  t.after(() => app.stop())

  const a = app.mock.client('p1', 'people-room')
  const b = app.mock.client('p2', 'people-room')
  await a.shouldReply('海龟汤 开局', OPEN)
  await b.shouldReply('海龟汤 问 杯子是她的吗', /是/)

  const replies = await b.receive('海龟汤 提交 杯子里的水是母亲的眼泪')
  const text = replies.join('\n')
  assert.match(text, /2 人参与/, `应统计到 2 个玩家，实际：${text}`)
})

test('汤库列表不再谎报页码', async (t) => {
  stubFetch()
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('p3', 'lib-room')
  const [reply] = await client.receive('海龟汤 汤库')
  assert.match(String(reply), /共 \d+ 条/)
  assert.doesNotMatch(String(reply), /第 1\/1 页/)
})

test('非房间模式发「加入」：给引导，不说「本场已结束」', async (t) => {
  stubFetch()
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('j1', 'join-room')
  await client.shouldReply('海龟汤 开局', OPEN)
  await client.shouldReply('海龟汤 加入', /不用加入/)
})

test('提问用尽：提示里的剩余提交次数要真实', async (t) => {
  stubFetch()
  const app = await createApp({ defaultQuestionQuota: 1, defaultGuessQuota: 3, questionCooldown: 0 })
  t.after(() => app.stop())

  const client = app.mock.client('j2', 'quota-room')
  await client.shouldReply('海龟汤 开局', OPEN)
  await client.shouldReply('海龟汤 问 第一次', /是/)
  await client.shouldReply('海龟汤 问 第二次', /剩余 3 次/)
})

test('normalizeVerdict：中文判词也能认', () => {
  assert.equal(normalizeVerdict('是'), 'yes')
  assert.equal(normalizeVerdict('是的。'), 'yes')
  assert.equal(normalizeVerdict('No'), 'no')
  assert.equal(normalizeVerdict(' 无关 '), 'irrelevant')
  assert.equal(normalizeVerdict('是也不是'), 'partial')
  assert.equal(normalizeVerdict('也许吧'), null)
  assert.equal(normalizeVerdict(undefined), null)
})
