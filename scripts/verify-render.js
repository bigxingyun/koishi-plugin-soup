/**
 * 真实出图验证：用本机 Chrome + koishi-plugin-puppeteer 跑一遍开局，
 * 把插件实际发出的图片落到 docs/verify/ 供人工核对。
 *
 * 用法：
 *   node scripts/verify-render.js
 *   $env:CHROME_PATH="D:\chrome\chrome.exe"; node scripts/verify-render.js
 */

const fs = require('node:fs')
const path = require('node:path')
const { Context } = require('koishi')

const mockModule = require('@koishijs/plugin-mock')
const memoryModule = require('@koishijs/plugin-database-memory')
const httpModule = require('@koishijs/plugin-http')
const puppeteerModule = require('koishi-plugin-puppeteer')
const plugin = require('../lib/index.js')

const mock = mockModule.default ?? mockModule
const memory = memoryModule.default ?? memoryModule
const httpPlugin = httpModule.default ?? httpModule
const puppeteerPlugin = puppeteerModule.default ?? puppeteerModule

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

const chrome = CANDIDATES.find((file) => fs.existsSync(file))
if (!chrome) {
  console.error('找不到 Chrome/Edge，可设置 CHROME_PATH 环境变量后重试')
  process.exit(2)
}

const OUT_DIR = path.join(__dirname, '..', 'docs', 'verify')

function extractImage(replies) {
  for (const reply of replies) {
    const match = /data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)/.exec(reply)
    if (match) {
      return { mime: match[1], buffer: Buffer.from(match[2], 'base64') }
    }
  }
  return null
}

function createApp(overrides = {}) {
  const app = new Context()
  app.plugin(mock)
  app.plugin(memory)
  // puppeteer 服务声明了 inject = ['http']，裸 Context 里必须先把 http 装上
  app.plugin(httpPlugin)
  app.plugin(puppeteerPlugin, {
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--font-render-hinting=none'],
  })
  app.plugin(plugin, {
    talesDir: 'data/soup/tales',
    // 开局要求配好 AI；版面走 default，所以这条假 key 不会真的发请求
    apiKey: 'sk-verify',
    modelCheck: false,
    autoImport: true,
    renderMode: 'image-first',
    renderFormat: 'jpg',
    renderScale: 2,
    renderWidth: 720,
    renderCacheMaxMB: 0,
    layoutPlanMode: 'default',
    masterAuthTTL: 600,
    ...overrides,
  })
  return app
}

async function waitPuppeteer(app) {
  const deadline = Date.now() + 15000
  while (!app.puppeteer && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  return !!app.puppeteer
}

/** 跑一局，把汤面图存下来；返回 { file, second } */
async function renderOnce(options) {
  const { theme, room, outFile, secondShot } = options
  const app = createApp(theme ? { renderTheme: theme } : {})
  const started = Date.now()
  await app.start()

  // puppeteer 服务在 app ready 之后才真正 ready，我们的 ctx.inject 子插件随之挂载。
  // 这里等它就绪再发消息，否则会走纯文本降级（真机上人不会这么快打字）。
  const ready = await waitPuppeteer(app)
  console.log(`[verify] ${theme || 'newspaper'}：app started in ${Date.now() - started}ms, puppeteer=${ready}`)

  const client = app.mock.client('verify', room)
  const replies = await client.receive('海龟汤 开局')
  console.log(`[verify] 开局收到 ${replies.length} 条消息`)
  for (const reply of replies) {
    const preview = reply.slice(0, 80).replace(/\n/g, '\\n')
    console.log(`  - ${preview}${reply.length > 80 ? '…' : ''}`)
  }

  const image = extractImage(replies)
  if (!image) {
    await app.stop()
    throw new Error('没有收到图片，渲染走了降级路径')
  }

  const file = path.join(OUT_DIR, outFile)
  fs.writeFileSync(file, image.buffer)
  console.log(`[verify] 图片已保存：${file}（${image.mime}，${(image.buffer.length / 1024).toFixed(0)} KB）`)

  const rows = await app.database.get('situation_puzzle_session', { channelKey: `mock:${room}` })
  console.log(`[verify] 场次 renderMode = ${rows[0]?.renderMode}`)

  let second = null
  if (secondShot) {
    // 再发一次汤面，验证缓存/二次渲染路径不报错
    const again = await client.receive('海龟汤 汤面')
    second = extractImage(again)
    console.log(`[verify] 汤面二次出图：${second ? `${(second.buffer.length / 1024).toFixed(0)} KB` : '失败'}`)
  }

  await app.stop()
  if (rows[0]?.renderMode !== 'image') throw new Error('场次没有记录成 image 模式')
  return { file, second }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  await renderOnce({ room: 'verify-room', outFile: 'real-render.jpg', secondShot: true })
  await renderOnce({ theme: 'plain', room: 'verify-plain', outFile: 'plain-render.jpg' })

  console.log('[verify] 通过')
}

main().catch(async (error) => {
  console.error('[verify] 失败：', error.message)
  process.exit(1)
})
