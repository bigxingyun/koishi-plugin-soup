import { promises as fs } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { Context, Logger } from 'koishi'
import type { Config } from './config'
import { TABLES } from './db'
import type { Difficulty, Tale, TaleKey } from './types'
import { cleanSurface, findLeak, sha1 } from './util'

export interface RawTale {
  taleId?: unknown
  title?: unknown
  difficulty?: unknown
  surface?: unknown
  answer?: unknown
  keys?: unknown
  tags?: unknown
  author?: unknown
  newspaper?: unknown
}

export interface TaleDraft {
  taleId: string
  title: string
  difficulty: Difficulty
  surface: string
  answer: string
  keys: TaleKey[]
  tags: string[]
  author: string
  newspaper: object
  checksum: string
  source: string
}

export interface ImportReport {
  added: number
  updated: number
  skipped: number
  failed: number
  errors: string[]
}

const TALE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/
const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard']

export function checksumOf(draft: Pick<TaleDraft, 'title' | 'surface' | 'answer' | 'keys'>): string {
  return sha1([draft.title, draft.surface, draft.answer, JSON.stringify(draft.keys)].join('\u0000'))
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 单条汤的校验 + 清洗。返回字符串表示失败原因。 */
export function buildTaleDraft(raw: RawTale, source: string, ignoreLeak: boolean): TaleDraft | string {
  const taleId = text(raw.taleId).trim()
  if (!TALE_ID.test(taleId)) return `taleId 非法（需小写字母/数字/连字符，3~64 位）：${taleId || '(空)'}`

  const title = text(raw.title).trim()
  if (!title) return '缺少 title'
  if (title.length > 40) return 'title 超过 40 字'

  const surface = cleanSurface(text(raw.surface))
  if (surface.length < 10) return 'surface 过短（< 10 字）'
  if (surface.length > 8000) return 'surface 超过 8000 字'

  const answer = cleanSurface(text(raw.answer))
  if (answer.length < 10) return 'answer 过短（< 10 字）或缺失'
  if (answer.length > 10000) return 'answer 超过 10000 字'

  const difficulty = DIFFICULTIES.includes(raw.difficulty as Difficulty)
    ? (raw.difficulty as Difficulty)
    : 'normal'

  const keys: TaleKey[] = []
  if (Array.isArray(raw.keys)) {
    for (const [index, item] of raw.keys.entries()) {
      const entry = typeof item === 'string' ? { text: item } : (item as { text?: unknown; weight?: unknown })
      const piece = text(entry?.text).trim()
      if (piece.length < 2 || piece.length > 120) continue
      const weight = Number(entry?.weight)
      keys.push({
        id: index + 1,
        text: piece,
        weight: Number.isFinite(weight) ? Math.min(Math.max(weight, 0.1), 5) : 1,
      })
      if (keys.length >= 8) break
    }
  }

  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((t) => text(t).trim()).filter((t) => t && t.length <= 16).slice(0, 8)
    : []

  const author = text(raw.author).trim().slice(0, 64)

  if (!ignoreLeak) {
    const leak = findLeak(surface, answer)
    if (leak) return `汤面疑似泄底，包含汤底片段：「${leak}」`
  }

  return {
    taleId,
    title,
    difficulty,
    surface,
    answer,
    keys,
    tags,
    author,
    newspaper: raw.newspaper && typeof raw.newspaper === 'object' ? (raw.newspaper as object) : {},
    checksum: checksumOf({ title, surface, answer, keys }),
    source,
  }
}

export function resolveTalesDir(ctx: Context, config: Config): string {
  return resolve(ctx.baseDir, config.talesDir)
}

async function readTaleFiles(dir: string): Promise<Array<{ file: string; raw: unknown }>> {
  const out: Array<{ file: string; raw: unknown }> = []
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.json')) continue
    const file = join(dir, entry)
    try {
      out.push({ file, raw: JSON.parse(await fs.readFile(file, 'utf8')) })
    } catch (error) {
      out.push({ file, raw: { __error: (error as Error).message } })
    }
  }
  return out
}

export async function importTales(
  ctx: Context,
  config: Config,
  logger: Logger,
  options: { only?: string } = {},
): Promise<ImportReport> {
  const report: ImportReport = { added: 0, updated: 0, skipped: 0, failed: 0, errors: [] }
  const dir = resolveTalesDir(ctx, config)

  try {
    await fs.mkdir(dir, { recursive: true })
  } catch (error) {
    logger.warn('汤库目录创建失败：%s', (error as Error).message)
  }

  let files = await readTaleFiles(dir)
  if (options.only) files = files.filter((item) => basename(item.file).includes(options.only!))
  if (!files.length) {
    logger.info('汤库目录为空或不存在：%s', dir)
    return report
  }

  for (const { file, raw } of files) {
    const name = basename(file)
    if (raw && typeof raw === 'object' && '__error' in (raw as object)) {
      report.failed++
      report.errors.push(`${name}：JSON 语法错误（${(raw as { __error: string }).__error}）`)
      continue
    }

    const items: unknown[] = Array.isArray(raw) ? raw : [raw]
    for (const item of items) {
      if (!item || typeof item !== 'object') {
        report.failed++
        report.errors.push(`${name}：条目不是对象`)
        continue
      }
      const draft = buildTaleDraft(item as RawTale, file, config.ignoreLeakWarning)
      if (typeof draft === 'string') {
        report.failed++
        report.errors.push(`${name}：${draft}`)
        continue
      }

      const existing = await ctx.database.get(TABLES.tale, { taleId: draft.taleId })
      if (!existing.length) {
        await ctx.database.create(TABLES.tale, {
          ...draft,
          enabled: config.autoEnable,
          playedCount: 0,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        report.added++
        continue
      }

      const row = existing[0]
      if (row.checksum === draft.checksum) {
        report.skipped++
        continue
      }
      await ctx.database.set(TABLES.tale, row.id, {
        ...draft,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      report.updated++
    }
  }

  if (report.errors.length) {
    for (const message of report.errors) logger.warn('汤库导入失败 · %s', message)
  }
  logger.info('汤库导入完成：新增 %d，更新 %d，跳过 %d，失败 %d', report.added, report.updated, report.skipped, report.failed)
  return report
}

export async function listTales(
  ctx: Context,
  options: { keyword?: string; all?: boolean } = {},
): Promise<Tale[]> {
  const query: Record<string, unknown> = {}
  if (!options.all) query.enabled = true
  const rows = await ctx.database.get(TABLES.tale, query)
  const keyword = options.keyword?.trim().toLowerCase()
  if (!keyword) return rows
  return rows.filter((row) =>
    row.title.toLowerCase().includes(keyword)
    || row.taleId.includes(keyword)
    || row.tags.some((tag) => tag.toLowerCase().includes(keyword)),
  )
}

export function tellableTale(tale: Tale): string | null {
  if (!tale.enabled) return '该汤已停用，不能开局。'
  if (!tale.answer || tale.answer.length < 10) return '该汤缺少汤底，不能开局。'
  if (!tale.surface || tale.surface.length < 10) return '该汤缺少汤面，不能开局。'
  return null
}
