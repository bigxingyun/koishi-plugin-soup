const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

const { Context } = require('koishi')
const mockPlugin = require('@koishijs/plugin-mock')
const memoryPlugin = require('@koishijs/plugin-database-memory')
const plugin = require('../lib/index.js')

const mock = mockPlugin.default ?? mockPlugin
const memory = memoryPlugin.default ?? memoryPlugin

const TMP = 'tests/.seed-tmp'

/** 开局现在要求配好 AI，这里给个假站点，只验证样例汤能开局 */
function stubFetch() {
  globalThis.fetch = async (url, init) => {
    const payload = String(url).endsWith('/models')
      ? { data: [{ id: 'deepseek-flash' }] }
      : { verdict: 'yes' }
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }
  }
}

async function createApp(overrides = {}) {
  const app = new Context()
  app.plugin(mock)
  app.plugin(memory)
  app.plugin(plugin, {
    apiKey: '',
    modelCheck: false,
    renderMode: 'text',
    autoImport: true,
    talesDir: TMP,
    ...overrides,
  })
  await app.start()
  return app
}

async function reset() {
  await fs.rm(TMP, { recursive: true, force: true })
}

test('内置样例汤：汤库为空时自动铺入并导入', async (t) => {
  await reset()
  stubFetch()
  const app = await createApp({ seedBundled: true, apiKey: 'sk-seed' })
  t.after(async () => {
    await app.stop()
    await reset()
  })

  const tales = await app.database.get('situation_puzzle_tale', {})
  assert.equal(tales.length, 3, '应导入 3 锅内置样例汤')

  const files = (await fs.readdir(TMP)).filter((f) => f.endsWith('.json'))
  assert.equal(files.length, 3, '应把 3 个 json 铺到用户汤库目录')
  assert.ok(files.includes('additive-harm.json'))

  const client = app.mock.client('u1', 'seed-room')
  await client.shouldReply('海龟汤 开局', [/难度：/, /本场规则/])
})

test('内置样例汤：用户已有汤时不再铺入', async (t) => {
  await reset()
  await fs.mkdir(TMP, { recursive: true })
  await fs.writeFile(path.join(TMP, 'my-own.json'), JSON.stringify({
    taleId: 'my-own',
    title: '我自己的汤',
    surface: '这是一段足够长的汤面，用来占位。',
    answer: '这是一段足够长的汤底，用来占位，确保不被覆盖。',
  }))

  const app = await createApp({ seedBundled: true })
  t.after(async () => {
    await app.stop()
    await reset()
  })

  const files = (await fs.readdir(TMP)).filter((f) => f.endsWith('.json'))
  assert.deepEqual(files, ['my-own.json'], '不得往非空汤库里塞文件')

  const tales = await app.database.get('situation_puzzle_tale', {})
  assert.equal(tales.length, 1)
  assert.equal(tales[0].title, '我自己的汤')
})

test('内置样例汤：seedBundled 关闭时不铺入', async (t) => {
  await reset()
  const app = await createApp({ seedBundled: false })
  t.after(async () => {
    await app.stop()
    await reset()
  })

  const tales = await app.database.get('situation_puzzle_tale', {})
  assert.equal(tales.length, 0)
  const leftover = await fs.readdir(TMP).catch(() => [])
  assert.equal(leftover.length, 0, '不应铺入任何汤文件')
})

test('内置样例汤：三锅都能通过泄底检测与字段校验', async (t) => {
  await reset()
  const app = await createApp({ seedBundled: true })
  t.after(async () => {
    await app.stop()
    await reset()
  })

  const tales = await app.database.get('situation_puzzle_tale', {})
  for (const tale of tales) {
    assert.ok(tale.surface.length >= 10, `${tale.taleId} 汤面过短`)
    assert.ok(tale.answer.length >= 10, `${tale.taleId} 汤底过短`)
    assert.ok(Array.isArray(tale.keys) && tale.keys.length > 0, `${tale.taleId} 应带关键要素`)
  }
})
