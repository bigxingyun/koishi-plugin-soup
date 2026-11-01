const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const { Context } = require('koishi')
const mockPlugin = require('@koishijs/plugin-mock')
const memoryPlugin = require('@koishijs/plugin-database-memory')
const plugin = require('../lib/index.js')
const { AIClient } = require('../lib/ai.js')

const mock = mockPlugin.default ?? mockPlugin
const memory = memoryPlugin.default ?? memoryPlugin

/** 起一个本地假站点，行为由 handler 决定；返回 { baseURL, server, requests } */
async function startFakeSite(handler) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const parsed = body ? JSON.parse(body) : null
    const record = { method: req.method, url: req.url, headers: req.headers, body: parsed }
    requests.push(record)

    const reply = await handler(record, { count: requests.length })
    res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(reply.body ?? {}))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseURL: `http://127.0.0.1:${port}`, server, requests }
}

function chatBody(content, extra = {}) {
  return {
    model: 'deepseek-flash',
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }],
    ...extra,
  }
}

async function createApp(config) {
  const app = new Context()
  app.plugin(mock)
  app.plugin(memory)
  app.plugin(plugin, {
    talesDir: 'tests/fixtures/tales',
    modelCheck: false,
    renderMode: 'text',
    autoImport: true,
    seedBundled: false,
    ...config,
  })
  await app.start()
  return app
}

test('DeepSeek 契约：判词请求体符合官方 JSON Output 规范', async (t) => {
  const site = await startFakeSite((req) => {
    if (req.url === '/models') return { body: { data: [{ id: 'deepseek-flash' }] } }
    return { body: chatBody({ verdict: 'yes' }) }
  })
  t.after(() => site.server.close())

  const app = await createApp({ apiKey: 'sk-contract', baseURL: site.baseURL })
  t.after(() => app.stop())

  const client = app.mock.client('c1', 'contract-room')
  await client.shouldReply('海龟汤 开局', [/测试之杯/, /本场规则/])
  await client.shouldReply('海龟汤 问 杯子里的水有问题吗', /是/)

  const judge = site.requests.find((r) => r.body?.max_tokens === 64)
  assert.ok(judge, '必须发出判词请求')
  assert.equal(judge.headers.authorization, 'Bearer sk-contract', '必须带 Bearer 鉴权')
  assert.deepEqual(judge.body.response_format, { type: 'json_object' }, '必须启用 JSON Output')
  assert.deepEqual(judge.body.thinking, { type: 'disabled' }, '默认必须关闭思考模式')
  assert.equal(typeof judge.body.temperature, 'number', '非思考模式下必须带 temperature')
  assert.ok(!('reasoning_effort' in judge.body), '非思考模式不应带 reasoning_effort')

  const system = judge.body.messages[0].content
  assert.match(system, /汤底/, '系统提示必须包含汤底')
  assert.match(system, /json/i, 'JSON Output 要求 prompt 里出现 json 字样')
  assert.match(system, /yes \/ no \/ irrelevant/, '必须写明判词枚举')

  const user = judge.body.messages[1].content
  assert.match(user, /<<<Q[\s\S]*Q>>>/, '玩家输入必须被定界符包裹')
})

test('DeepSeek 契约：开启思考模式时去掉 temperature、带上 reasoning_effort', async (t) => {
  const site = await startFakeSite((req) => {
    if (req.url === '/models') return { body: { data: [{ id: 'deepseek-flash' }] } }
    return { body: chatBody({ verdict: 'no' }) }
  })
  t.after(() => site.server.close())

  const app = await createApp({
    apiKey: 'sk-thinking',
    baseURL: site.baseURL,
    thinkingMode: true,
    reasoningEffort: 'max',
  })
  t.after(() => app.stop())

  const client = app.mock.client('t1', 'thinking-room')
  await client.shouldReply('海龟汤 开局', [/测试之杯/, /本场规则/])
  await client.shouldReply('海龟汤 问 她哭了吗', /不是/)

  const judge = site.requests.find((r) => r.body?.max_tokens === 64)
  assert.deepEqual(judge.body.thinking, { type: 'enabled' })
  assert.equal(judge.body.reasoning_effort, 'max')
  assert.ok(!('temperature' in judge.body), '思考模式下 temperature 不生效，必须省略')
})

test('DeepSeek 契约：评分请求体带关键要素与 JSON 样例', async (t) => {
  const site = await startFakeSite((req) => {
    if (req.url === '/models') return { body: { data: [{ id: 'deepseek-flash' }] } }
    if (req.body?.max_tokens === 512) {
      return { body: chatBody({ points: [{ id: 1, hit: 'yes' }, { id: 2, hit: 'yes' }, { id: 3, hit: 'partial' }], semantic: 90 }) }
    }
    return { body: chatBody({ verdict: 'yes' }) }
  })
  t.after(() => site.server.close())

  const app = await createApp({ apiKey: 'sk-score', baseURL: site.baseURL })
  t.after(() => app.stop())

  const client = app.mock.client('s1', 'score-room')
  await client.shouldReply('海龟汤 开局', [/测试之杯/, /本场规则/])
  const [reply] = await client.receive('海龟汤 提交 杯子是母亲的遗物，纸条是遗言')

  assert.match(String(reply), /相似度/)

  const score = site.requests.find((r) => r.body?.max_tokens === 512)
  assert.ok(score, '必须发出评分请求')
  assert.match(score.body.messages[0].content, /1\. 杯子里装的不是普通的水/, '关键要素必须带编号塞进 prompt')
  assert.match(score.body.messages[0].content, /json/i, 'JSON Output 要求 prompt 里出现 json 字样')
  assert.deepEqual(score.body.thinking, { type: 'disabled' })
})

test('DeepSeek 容错：401 给出鉴权提示且不扣配额', async (t) => {
  const site = await startFakeSite(() => ({ status: 401, body: { error: { message: 'invalid api key' } } }))
  t.after(() => site.server.close())

  const app = await createApp({ apiKey: 'sk-bad', baseURL: site.baseURL })
  t.after(() => app.stop())

  const client = app.mock.client('a1', 'auth-room')
  await client.shouldReply('海龟汤 开局', [/测试之杯/, /本场规则/])
  await client.shouldReply('海龟汤 问 有人吗', /鉴权失败/)

  const rows = await app.database.get('situation_puzzle_session', { channelKey: 'mock:auth-room' })
  assert.equal(rows[0].questionsUsed, 0, '鉴权失败不得扣配额')
})

test('DeepSeek 容错：429 自动重试后成功', async (t) => {
  const site = await startFakeSite((req, { count }) => {
    if (req.url === '/models') return { body: { data: [{ id: 'deepseek-flash' }] } }
    if (count === 1) return { status: 429, body: { error: { message: 'rate limited' } } }
    return { body: chatBody({ verdict: 'yes' }) }
  })
  t.after(() => site.server.close())

  const app = await createApp({ apiKey: 'sk-retry', baseURL: site.baseURL })
  t.after(() => app.stop())

  const client = app.mock.client('r1', 'retry-room')
  await client.shouldReply('海龟汤 开局', [/测试之杯/, /本场规则/])
  await client.shouldReply('海龟汤 问 她哭了吗', /是/)
})

test('DeepSeek 容错：空 content 视为失败并重试', async (t) => {
  const site = await startFakeSite((req, { count }) => {
    if (req.url === '/models') return { body: { data: [{ id: 'deepseek-flash' }] } }
    if (count === 1) return { body: chatBody('') }
    return { body: chatBody({ verdict: 'no' }) }
  })
  t.after(() => site.server.close())

  const app = await createApp({ apiKey: 'sk-empty', baseURL: site.baseURL })
  t.after(() => app.stop())

  const client = app.mock.client('e1', 'empty-room')
  await client.shouldReply('海龟汤 开局', [/测试之杯/, /本场规则/])
  await client.shouldReply('海龟汤 问 她笑过吗', /不是/)
})

test('DeepSeek 容错：返回非 JSON 时散场并交底，不扣配额', async (t) => {
  const site = await startFakeSite((req) => {
    if (req.url === '/models') return { body: { data: [{ id: 'deepseek-flash' }] } }
    return { body: chatBody('我觉得答案是肯定的，因为……') }
  })
  t.after(() => site.server.close())

  const app = await createApp({ apiKey: 'sk-text', baseURL: site.baseURL, maxRetries: 0 })
  t.after(() => app.stop())

  const client = app.mock.client('n1', 'nonjson-room')
  await client.shouldReply('海龟汤 开局', [/测试之杯/, /本场规则/])
  await client.shouldReply('海龟汤 问 她哭了吗', /AI 没连通[\s\S]*汤底/)

  const rows = await app.database.get('situation_puzzle_session', { channelKey: 'mock:nonjson-room' })
  assert.equal(rows[0].questionsUsed, 0)
  assert.equal(rows[0].status, 'settled', '判定器不可用时不该留着一个开着的场次')
})

test('诊断：站点可达 / 模型命中 / 推理通过', async (t) => {
  const site = await startFakeSite((req) => {
    if (req.url === '/models') return { body: { data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] } }
    return { body: chatBody({ ok: true }) }
  })
  t.after(() => site.server.close())

  const app = await createApp({ apiKey: 'sk-diag', baseURL: site.baseURL })
  t.after(() => app.stop())

  const client = app.mock.client('d1', 'diag-room')
  const [reply] = await client.receive('海龟汤 诊断')
  const text = String(reply)

  assert.match(text, /站点可达/)
  assert.match(text, /模型在列表中：deepseek-flash/)
  assert.match(text, /推理正常/)
  assert.match(text, /今日调用：/)
})

test('诊断：站点不可达时给出可读原因', async (t) => {
  // 指向一个必然拒绝连接的端口
  const app = await createApp({ apiKey: 'sk-dead', baseURL: 'http://127.0.0.1:9', timeout: 3 })
  t.after(() => app.stop())

  const client = app.mock.client('d2', 'diag-dead')
  const [reply] = await client.receive('海龟汤 诊断')
  assert.match(String(reply), /站点不可达/)
})

test('诊断：未配置 Key 时直接提示', async (t) => {
  const previous = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  t.after(() => {
    if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous
  })

  const app = await createApp({ apiKey: '' })
  t.after(() => app.stop())

  const client = app.mock.client('d3', 'diag-nokey')
  await client.shouldReply('海龟汤 诊断', /尚未配置 apiKey/)
})

test('AIClient.diagnose：-f 跳过推理调用', async (t) => {
  const site = await startFakeSite((req) => {
    if (req.url === '/models') return { body: { data: [{ id: 'deepseek-flash' }] } }
    return { body: chatBody({ ok: true }) }
  })
  t.after(() => site.server.close())

  const app = await createApp({ apiKey: 'sk-fast', baseURL: site.baseURL })
  t.after(() => app.stop())

  const ai = new AIClient(app, {
    apiKey: 'sk-fast',
    baseURL: site.baseURL,
    model: 'deepseek-flash',
    timeout: 5,
    dailyCallLimit: 0,
  }, app.logger('soup-test'))

  const report = await ai.diagnose({ skipProbe: true })
  assert.equal(report.endpoint.ok, true)
  assert.equal(report.models.found, true)
  assert.ok('skipped' in report.probe, 'skipProbe 时不应发起推理请求')
  assert.ok(!site.requests.some((r) => r.body?.max_tokens === 16), '不应有探针请求')
})
