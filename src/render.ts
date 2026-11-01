import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { Context, Logger } from 'koishi'
import type { Config } from './config'
import type { Accent } from './config'
import type { LayoutPlan } from './types'
import { clamp, escapeHtml, findLeak, sha1 } from './util'

/** 模板版本号：改模板必须改它，否则旧缓存不会失效（FR-17 规则 9） */
export const TEMPLATE_VERSION = 1

const ACCENTS: Record<Accent, { hex: string; tint: string; shadow: string }> = {
  rust: { hex: '#8c2318', tint: 'rgba(140,35,24,.16)', shadow: 'rgba(140,35,24,.55)' },
  blood: { hex: '#7a1010', tint: 'rgba(122,16,16,.18)', shadow: 'rgba(122,16,16,.6)' },
  ink: { hex: '#2f2a22', tint: 'rgba(47,42,34,.14)', shadow: 'rgba(47,42,34,.5)' },
  steel: { hex: '#2f4858', tint: 'rgba(47,72,88,.15)', shadow: 'rgba(47,72,88,.5)' },
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

const GRAIN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='240' height='240' filter='url(%23n)' opacity='0.42'/%3E%3C/svg%3E")`

export interface SheetContext {
  plan: LayoutPlan
  paperName: string
  issue: number
  date: Date
  difficulty: string
  tags: string[]
  questionQuota: number
  guessQuota: number
  passThreshold: number
  personalGuessQuota: number
  footerHint: boolean
}

function mastheadSize(name: string): { px: number; ls: number } {
  const n = name.length
  const px = n <= 3 ? 54 : n === 4 ? 46 : n === 5 ? 40 : 34
  return { px, ls: Math.max(4, Math.round(px * 0.15)) }
}

function titleSize(title: string): number {
  const n = title.length
  return n <= 4 ? 44 : n <= 6 ? 40 : n <= 8 ? 34 : 29
}

function autoStyle(bodyLength: number, plan: LayoutPlan) {
  const style = plan.style || {}
  let fontPx = clamp(style.fontPx, 12, 16.5, 14.5)
  let lineHeight = clamp(style.lineHeight, 1.65, 2.1, 1.95)

  if (bodyLength < 280) {
    fontPx = Math.min(fontPx + 1.3, 16.5)
    lineHeight = Math.min(lineHeight + 0.05, 2.1)
  } else if (bodyLength > 800) {
    fontPx = Math.max(fontPx - 1.4, 12)
    lineHeight = Math.max(lineHeight - 0.12, 1.65)
  }
  if (bodyLength > 1500) {
    fontPx = Math.max(fontPx - 2.4, 12)
    lineHeight = 1.75
  }

  return {
    columns: style.columns === 1 ? 1 : 2,
    fontPx: Number(fontPx.toFixed(2)),
    lineHeight: Number(lineHeight.toFixed(2)),
    dropCap: style.dropCap !== false,
    accent: (style.accent && ACCENTS[style.accent] ? style.accent : 'rust') as Accent,
    grain: clamp(style.grain, 0.3, 1, 0.9),
  }
}

/** 把 plan 渲染成完整 HTML。所有用户文本都必须经过 escapeHtml。 */
export function buildNewspaperHTML(ctx: SheetContext): string {
  const { plan } = ctx
  const body = (plan.body?.length ? plan.body : ['（汤面缺失）']).map((p) => String(p).trim()).filter(Boolean)
  const bodyLength = body.reduce((sum, p) => sum + p.length, 0)
  const style = autoStyle(bodyLength, plan)
  const accent = ACCENTS[style.accent]

  const date = ctx.date
  const dateLine = `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`
  const weekday = WEEKDAYS[date.getDay()]

  const masthead = (plan.masthead?.name || ctx.paperName || '海龟汤晚报').slice(0, 16)
  const mast = mastheadSize(masthead)

  const title = (plan.title || '无题').slice(0, 14)
  const kicker = (plan.kicker || '').slice(0, 18)
  const deck = (plan.deck || '').slice(0, 48)
  const stampText = (plan.stamp?.text || '本报独家').slice(0, 4)
  const stampAngle = clamp(plan.stamp?.angle, -12, 0, -8)
  const stampOpacity = clamp(plan.stamp?.opacity, 0.35, 0.75, 0.6)

  const dropChar = style.dropCap && body.length ? [...body[0]][0] : ''
  const paragraphs = body.map((text, index) => {
    let html = escapeHtml(text)
    html = html.replace(/^(第[一二三四五六七八九十百]+[周天])([：:])/, '<b>$1</b>$2')
    if (index === 0 && dropChar) {
      html = `<span class="drop">${escapeHtml(dropChar)}</span>` + html.slice(escapeHtml(dropChar).length)
    }
    return `<p>${html}</p>`
  }).join('\n')

  const quotaLine = ctx.questionQuota > 0 ? `提问 ${ctx.questionQuota} 次` : '提问不限'
  const personalLine = ctx.personalGuessQuota > 0 ? `· 个人 ${ctx.personalGuessQuota} 次` : ''

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
:root{--ink:#241a10;--ink2:#4a3a26;--accent:${accent.hex};--accent-shadow:${accent.shadow};--accent-tint:${accent.tint};
--serif:"SimSun","宋体","Songti SC",serif;--hei:"SimHei","黑体","Microsoft YaHei",sans-serif;--kai:"KaiTi","楷体",serif;--li:"LiSu","隶书","STLiti",serif}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#cfbc95}
body{width:720px;font-family:var(--serif);-webkit-font-smoothing:antialiased}
.paper{position:relative;width:700px;margin:14px 10px;padding:30px 38px 22px;color:var(--ink);
background:radial-gradient(140% 90% at 18% -10%,#f7f0da 0%,#efe4c6 42%,#e6d7b4 74%,#ddcaa3 100%);
box-shadow:0 2px 20px rgba(57,38,12,.34),0 0 0 1px rgba(96,68,28,.2),inset 0 0 70px rgba(120,84,30,.2),inset 0 0 14px rgba(90,60,20,.18);overflow:hidden}
.paper:before{content:"";position:absolute;inset:0;background:${GRAIN};background-size:240px 240px;mix-blend-mode:multiply;opacity:${style.grain};pointer-events:none;z-index:5}
.paper:after{content:"";position:absolute;inset:0;mix-blend-mode:multiply;pointer-events:none;z-index:5;background:
radial-gradient(38% 30% at 88% 6%,rgba(118,82,34,.4),transparent 70%),
radial-gradient(30% 26% at 4% 62%,rgba(120,84,36,.34),transparent 72%),
radial-gradient(26% 22% at 62% 99%,rgba(112,76,30,.32),transparent 70%)}
.content{position:relative;z-index:6}
.rule-thick{border-top:3px solid var(--ink)}.rule-thin{border-top:1px solid rgba(36,26,16,.55)}
.masthead{display:flex;align-items:flex-end;justify-content:space-between;padding:7px 0 6px}
.masthead .side{font-family:var(--kai);font-size:11px;line-height:1.5;color:var(--ink2);width:96px}
.masthead .side.right{text-align:right}
.masthead h1{font-family:var(--li);font-size:${mast.px}px;line-height:1;font-weight:400;letter-spacing:${mast.ls}px;text-indent:${mast.ls}px;color:#1c140b}
.masthead .en{display:block;text-align:center;font-family:Georgia,serif;font-size:9px;letter-spacing:3.6px;text-indent:3.6px;color:var(--ink2);margin-top:6px;text-transform:uppercase}
.dateline{display:flex;justify-content:space-between;font-family:var(--kai);font-size:10.5px;color:var(--ink2);padding:4px 0 3px}
.headline-wrap{text-align:center;padding:14px 0 10px}
.kicker{font-family:var(--hei);font-size:13px;letter-spacing:2.5px;color:var(--accent);margin-bottom:9px}
h2.title{font-family:var(--hei);font-size:${titleSize(title)}px;line-height:1.14;letter-spacing:6px;text-indent:6px;font-weight:700;color:#170f07;
text-shadow:1.2px 0 0 var(--accent-tint),-1.2px 0 0 rgba(46,66,96,.12),0 0 .6px rgba(36,26,16,.45)}
.deck{font-family:var(--kai);font-size:13px;color:var(--ink2);letter-spacing:.6px;margin-top:9px}
.rule-dot{display:flex;align-items:center;gap:8px;justify-content:center;margin-top:12px;color:rgba(36,26,16,.45)}
.rule-dot i{flex:1;height:1px;background:currentColor}.rule-dot b{font-size:8px;font-weight:400;letter-spacing:2px}
.body-text{margin-top:14px;column-count:${style.columns};column-gap:30px;column-rule:1px solid rgba(36,26,16,.28);
font-size:${style.fontPx}px;line-height:${style.lineHeight};text-align:justify;text-justify:inter-ideograph;color:#2a1e12}
.body-text p{text-indent:2em;margin-bottom:.55em}
.body-text p:first-child{text-indent:0}
.body-text p:last-child{margin-bottom:0}
.drop{float:left;font-family:var(--hei);font-size:${Math.round(style.fontPx * 3.05)}px;line-height:.94;padding:2px 5px 0 0;color:#170f07}
.sign-row{display:flex;align-items:center;justify-content:space-between;margin-top:10px}
.byline{font-family:var(--kai);font-size:10.5px;color:var(--ink2)}
.seal{flex:0 0 auto;width:74px;height:74px;border:3px solid var(--accent);border-radius:3px;color:var(--accent);
display:grid;grid-template-columns:1fr 1fr;align-content:center;justify-items:center;font-family:var(--hei);font-size:19px;line-height:1.15;
opacity:${stampOpacity};transform:rotate(${stampAngle}deg);mix-blend-mode:multiply;padding:5px;box-shadow:inset 0 0 0 1px var(--accent-shadow)}
.bottom{display:grid;grid-template-columns:1fr 1fr;margin-top:14px;border-top:1px solid rgba(36,26,16,.5)}
.box{padding:11px 14px 4px}.box+.box{border-left:1px solid rgba(36,26,16,.32)}
.box h3{font-family:var(--hei);font-size:11px;letter-spacing:2px;color:var(--accent);margin-bottom:6px}
.box p{font-size:11.5px;line-height:1.85;color:#33261a}
.foot{display:flex;justify-content:space-between;margin-top:12px;padding-top:6px;border-top:1px solid rgba(36,26,16,.5);
font-family:var(--kai);font-size:9.5px;color:var(--ink2)}
</style></head><body><div class="paper"><div class="content">
<div class="rule-thick"></div>
<div class="masthead">
<div class="side">第 ${String(ctx.issue).padStart(4, '0')} 期<br>共 1 版</div>
<div><h1>${escapeHtml(masthead)}</h1><span class="en">Situation Puzzle Post</span></div>
<div class="side right">${dateLine}<br>${weekday}</div>
</div>
<div class="rule-thick"></div><div class="rule-thin" style="margin-top:2px"></div>
<div class="dateline"><div>本报讯　·　本报编辑部</div><div>难度 ${escapeHtml(ctx.difficulty)}${ctx.tags.length ? `　·　${escapeHtml(ctx.tags.join(' / '))}` : ''}</div></div>
<div class="headline-wrap">
${kicker ? `<div class="kicker">${escapeHtml(kicker)}</div>` : ''}
<h2 class="title">${escapeHtml(title)}</h2>
${deck ? `<div class="deck">${escapeHtml(deck)}</div>` : ''}
<div class="rule-dot"><i></i><b>◆</b><i></i></div>
</div>
<div class="body-text">
${paragraphs}
</div>
<div class="sign-row">
<div class="byline">${escapeHtml((plan.byline || '本文仅据当事人口述整理，真相待解。').slice(0, 40))}</div>
<div class="seal">${[...stampText].map((c) => `<span>${escapeHtml(c)}</span>`).join('')}</div>
</div>
<div class="bottom">
<div class="box"><h3>本版须知</h3><p>主持人只回答「是」「不是」「无关」。<br>${quotaLine} · 提交 ${ctx.guessQuota} 次${personalLine} · 通过线 ${Math.round(ctx.passThreshold * 100)}%</p></div>
<div class="box"><h3>提问方式</h3><p>海龟汤 问 你的问题<br>海龟汤 提交 你的推理</p></div>
</div>
<div class="foot"><div>汤号 No.${String(ctx.issue).padStart(4, '0')}${ctx.footerHint ? '　·　只能问：是 / 不是 / 无关' : ''}</div><div>第 1 版</div></div>
</div></div></body></html>`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export interface RenderOutput {
  ok: boolean
  image?: Buffer
  mime?: string
  cacheKey?: string
}

/**
 * 渲染器：puppeteer 可用时出图，否则返回 ok=false 由调用方降级文本。
 * 所有失败都必须被吃掉——渲染失败绝不能让场次创建失败（FR-16 规则 3）。
 */
export class Renderer {
  private failures = 0
  private blockedUntil = 0
  private memory = new Map<string, Buffer>()

  constructor(
    private ctx: Context,
    private config: Config,
    private logger: Logger,
  ) {}

  /**
   * 取 puppeteer 服务。
   * 注意：本插件把 puppeteer 声明为 optional，作用域里的 `ctx.puppeteer` 在 apply 阶段
   * 是 undefined（服务晚于插件加载）；服务本体挂在 root 上，所以这里回退到 `ctx.root`。
   */
  private get service(): any {
    const ctx = this.ctx as any
    return ctx.puppeteer ?? ctx.root?.puppeteer
  }

  get available(): boolean {
    if (this.config.renderMode === 'text') return false
    if (this.config.renderBackend === 'text') return false
    return !!this.service
  }

  get circuitOpen(): boolean {
    return Date.now() < this.blockedUntil
  }

  get cacheDir(): string {
    return resolve(this.ctx.baseDir, this.config.renderCacheDir)
  }

  private cacheKey(sheet: SheetContext): string {
    return sha1([
      sheet.plan.title,
      sheet.plan.body?.join('|') || '',
      sheet.paperName,
      sheet.difficulty,
      sheet.questionQuota,
      sheet.guessQuota,
      sheet.passThreshold,
      this.config.renderTheme,
      this.config.renderWidth,
      this.config.renderScale,
      this.config.renderFormat,
      String(TEMPLATE_VERSION),
    ].join('\u0000'))
  }

  private async readCache(key: string): Promise<Buffer | null> {
    const hit = this.memory.get(key)
    if (hit) return hit
    if (this.config.renderCacheMaxMB <= 0) return null
    try {
      return await fs.readFile(join(this.cacheDir, `${key}.${this.config.renderFormat}`))
    } catch {
      return null
    }
  }

  private async writeCache(key: string, buffer: Buffer): Promise<void> {
    this.memory.set(key, buffer)
    if (this.memory.size > 40) this.memory.delete(this.memory.keys().next().value as string)
    if (this.config.renderCacheMaxMB <= 0) return
    try {
      await fs.mkdir(this.cacheDir, { recursive: true })
      await fs.writeFile(join(this.cacheDir, `${key}.${this.config.renderFormat}`), buffer)
    } catch (error) {
      this.logger.debug('渲染缓存写入失败：%s', (error as Error).message)
    }
  }

  /** 清理过期缓存，按总量裁到上限以内 */
  async pruneCache(): Promise<void> {
    if (this.config.renderCacheMaxMB <= 0) return
    try {
      const dir = this.cacheDir
      const entries = await fs.readdir(dir)
      const files: Array<{ path: string; size: number; mtime: number }> = []
      for (const entry of entries) {
        try {
          const stat = await fs.stat(join(dir, entry))
          if (stat.isFile()) files.push({ path: join(dir, entry), size: stat.size, mtime: stat.mtimeMs })
        } catch { /* ignore */ }
      }
      const maxBytes = this.config.renderCacheMaxMB * 1024 * 1024
      const total = files.reduce((sum, f) => sum + f.size, 0)
      if (total <= maxBytes) return
      files.sort((a, b) => a.mtime - b.mtime)
      let current = total
      for (const file of files) {
        if (current <= maxBytes) break
        await fs.unlink(file.path).catch(() => undefined)
        current -= file.size
      }
    } catch { /* 目录不存在等情况忽略 */ }
  }

  /**
   * 渲染一张报纸。返回 ok=false 表示应当降级为纯文本。
   * 注意：返回的 Buffer 已经是目标编码（jpg/png/webp）。
   */
  async render(sheet: SheetContext): Promise<RenderOutput> {
    if (!this.available || this.circuitOpen) return { ok: false }

    const key = this.cacheKey(sheet)
    const cached = await this.readCache(key)
    if (cached) return { ok: true, image: cached, mime: this.mime, cacheKey: key }

    const html = buildNewspaperHTML(sheet)
    const started = Date.now()
    try {
      const raw = await this.renderWithBackend(html)
      const image = extractImage(raw)
      if (!image) throw new Error('渲染结果无法解析')
      if (image.buffer.length < 1024) throw new Error('渲染结果为空')
      if (image.buffer.length > 5 * 1024 * 1024) {
        throw new Error(`渲染结果过大：${(image.buffer.length / 1024 / 1024).toFixed(1)}MB`)
      }

      await this.writeCache(key, image.buffer)
      this.failures = 0
      this.logger.debug('渲染完成：%d KB / %d ms', Math.round(image.buffer.length / 1024), Date.now() - started)
      return { ok: true, image: image.buffer, mime: image.mime, cacheKey: key }
    } catch (error) {
      this.failures++
      this.logger.warn('渲染失败（第 %d 次）：%s', this.failures, (error as Error).message)
      if (this.failures >= this.config.renderCircuitThreshold) {
        this.blockedUntil = Date.now() + this.config.renderCooldown * 1000
        this.failures = 0
        this.logger.warn('渲染熔断 %d 秒，期间直接发文本', this.config.renderCooldown)
      }
      return { ok: false }
    }
  }

  /**
   * 调 puppeteer 出图。
   *
   * 关键：`koishi-plugin-puppeteer` 的 `render(content, callback?)` 默认只截 body 并返回
   * `<img src="data:image/png;base64,..."/>` 字符串；想控制 viewport 与 jpg/webp 编码，
   * 必须在 callback 里自己截图并返回我们的 data URL。
   */
  private async renderWithBackend(html: string): Promise<string> {
    const service = this.service
    const format = this.config.renderFormat
    const type = format === 'jpg' ? 'jpeg' : format
    const mime = this.mime

    try {
      return await service.render(html, async (page: any) => {
        await page.setViewport({
          width: this.config.renderWidth,
          height: 240,
          deviceScaleFactor: this.config.renderScale,
        })
        const handle = await page.$('body')
        const clip = handle ? await handle.boundingBox() : null
        const options: Record<string, unknown> = clip ? { clip, type } : { fullPage: true, type }
        if (type === 'jpeg') options.quality = 86
        const buffer = await page.screenshot(options)
        return `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`
      })
    } catch (error) {
      // 兼容只实现 render(html) 的后端，或 callback 签名不同的旧版本
      this.logger.debug('带 callback 渲染失败，回退默认截图：%s', (error as Error).message)
      return await service.render(html)
    }
  }

  private get mime(): string {
    return this.config.renderFormat === 'png' ? 'image/png'
      : this.config.renderFormat === 'webp' ? 'image/webp'
        : 'image/jpeg'
  }

  /** 记录发送失败，用于频道熔断（FR-16 规则 7） */
  reportSendFailure(): void {
    this.failures++
    if (this.failures >= this.config.renderCircuitThreshold) {
      this.blockedUntil = Date.now() + this.config.renderCooldown * 1000
      this.failures = 0
    }
  }
}

export interface ExtractedImage {
  buffer: Buffer
  mime: string
}

/**
 * 从后端返回值里取出图片。三种形态都要吃：
 * 1. `<img src="data:image/png;base64,..."/>` —— koishi-plugin-puppeteer 的默认返回
 * 2. `data:image/jpeg;base64,...` —— 我们自己在 callback 里返回的
 * 3. 裸 base64
 */
export function extractImage(raw: string): ExtractedImage | null {
  if (!raw || typeof raw !== 'string') return null

  const element = /src="(data:([^;"]+);base64,([^"]+))"/.exec(raw)
  if (element) return { buffer: Buffer.from(element[3], 'base64'), mime: element[2] }

  if (raw.startsWith('data:')) {
    const comma = raw.indexOf(',')
    if (comma < 0) return null
    const mime = /^data:([^;]+)/.exec(raw)?.[1] || 'image/png'
    return { buffer: Buffer.from(raw.slice(comma + 1), 'base64'), mime }
  }

  if (/^[A-Za-z0-9+/=\s]+$/.test(raw)) {
    return { buffer: Buffer.from(raw, 'base64'), mime: 'image/png' }
  }
  return null
}

/** 兼容旧调用：只要 Buffer */
export function decodeImage(raw: string): Buffer | null {
  return extractImage(raw)?.buffer ?? null
}

/** 防御性检查：渲染出来的 plan 不得夹带汤底片段 */
export function planLeaksAnswer(plan: LayoutPlan, answer: string): boolean {
  const text = [plan.kicker, plan.deck, plan.title, ...(plan.body || [])].filter(Boolean).join('\n')
  return !!findLeak(text, answer, 12)
}
