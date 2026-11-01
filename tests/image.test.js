const fs = require('node:fs/promises')

const test = require('node:test')
const assert = require('node:assert/strict')

const { Context } = require('koishi')
const mockPlugin = require('@koishijs/plugin-mock')
const memoryPlugin = require('@koishijs/plugin-database-memory')
const plugin = require('../lib/index.js')
const { TABLES } = require('../lib/db.js')

const mock = mockPlugin.default ?? mockPlugin
const memory = memoryPlugin.default ?? memoryPlugin

function stubFetch() {
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/models')) return jsonResponse({ data: [{ id: 'deepseek-flash' }] })
    const body = init?.body ? JSON.parse(init.body) : {}
    const payload = body.max_tokens === 64 ? { verdict: 'yes' } : { points: [], semantic: 50 }
    return jsonResponse({
      model: 'deepseek-flash',
      choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }],
    })
  }
}

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
}

/** 4KB 假图：足够通过「渲染结果不能小于 1KB」的校验 */
const FAKE_IMAGE = Buffer.alloc(4096, 0x7f).toString('base64')

async function createApp(overrides = {}, withRenderer = true) {
  const app = new Context()
  app.plugin(mock)
  app.plugin(memory)
  if (withRenderer) {
    app.set('puppeteer', {
      render: async () => FAKE_IMAGE,
      calls: (withRenderer.calls = (withRenderer.calls ?? 0) + 1),
    })
  }
  app.plugin(plugin, {
    talesDir: 'tests/fixtures/tales',
    apiKey: 'sk-test',
    modelCheck: false,
    autoImport: true,
    renderCacheMaxMB: 0,
    renderMode: 'image-first',
    ...overrides,
  })
  await app.start()
  return app
}

test('出图：有渲染后端时开局发图片，并记录 renderMode=image', async (t) => {
  stubFetch()
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('img1', 'img-room')
  const replies = await client.receive('海龟汤 开局')

  assert.ok(replies.length >= 1, '必须至少发出一条消息')
  const joined = replies.join('\n')
  assert.match(joined, /base64|img|image/i, `应包含图片元素，实际：${joined.slice(0, 200)}`)

  const rows = await app.database.get(TABLES.session, { channelKey: 'mock:img-room' })
  assert.equal(rows[0].renderMode, 'image', '场次应记录为 image 模式')
})

test('出图失败：渲染后端抛错时自动降级文本', async (t) => {
  stubFetch()
  const app = new Context()
  app.plugin(mock)
  app.plugin(memory)
  app.set('puppeteer', {
    render: async () => {
      throw new Error('chrome crashed')
    },
  })
  app.plugin(plugin, {
    talesDir: 'tests/fixtures/tales',
    apiKey: 'sk-test',
    modelCheck: false,
    autoImport: true,
    renderCacheMaxMB: 0,
    renderMode: 'image-first',
  })
  await app.start()
  t.after(() => app.stop())

  const client = app.mock.client('img2', 'img-room-2')
  const replies = await client.receive('海龟汤 开局')
  const joined = replies.join('\n')

  assert.ok(joined.includes('测试之杯'), '必须降级成包含汤名的文本')
  assert.ok(!/base64/i.test(joined), '降级后不应再含图片数据')

  const rows = await app.database.get(TABLES.session, { channelKey: 'mock:img-room-2' })
  assert.equal(rows[0].renderMode, 'text')
})

test('出图：-t 选项强制纯文本', async (t) => {
  stubFetch()
  const app = await createApp()
  t.after(() => app.stop())

  const client = app.mock.client('img3', 'img-room-3')
  const replies = await client.receive('海龟汤 开局 -t')
  const joined = replies.join('\n')

  assert.ok(joined.includes('测试之杯'))
  assert.ok(!/base64/i.test(joined), '-t 不应出图')
})

test('出图：同一锅汤第二次渲染命中缓存，不再调用后端', async (t) => {
  stubFetch()
  const app = new Context()
  app.plugin(mock)
  app.plugin(memory)

  let renders = 0
  app.set('puppeteer', {
    render: async () => {
      renders++
      return FAKE_IMAGE
    },
  })
  app.plugin(plugin, {
    talesDir: 'tests/fixtures/tales',
    apiKey: 'sk-test',
    modelCheck: false,
    autoImport: true,
    renderCacheDir: 'tests/.cache',
    renderCacheMaxMB: 50,
    renderMode: 'image-first',
  })
  await app.start()
  t.after(async () => {
    await app.stop()
    await fs.rm('tests/.cache', { recursive: true, force: true })
  })

  const client = app.mock.client('img4', 'img-room-4')
  await client.receive('海龟汤 开局')
  assert.equal(renders, 1, '首次开局应渲染一次')

  await client.receive('海龟汤 汤面')
  assert.equal(renders, 1, '第二次应命中缓存，不再渲染')
  assert.ok(await fs.stat('tests/.cache').catch(() => null), '缓存目录应已写入')
})