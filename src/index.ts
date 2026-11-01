import { Context, h, Session } from 'koishi'
import { AIClient } from './ai'
import type { Config } from './config'
import { TABLES, setupModel } from './db'
import { Game, GameError, channelKeyOf, defaultPlan, userKeyOf } from './game'
import enUS from './locales/en-US'
import zhCN from './locales/zh-CN'
import {
  bindMaster, consumeCode, getMaster, issueCode, pendingKey, unbindMaster,
} from './master'
import { Renderer, buildNewspaperHTML, TEMPLATE_VERSION } from './render'
import { importTales, listTales, resolveTalesDir, seedBundledTales, tellableTale } from './tale'
import type { GameSession, Tale } from './types'
import { formatDuration, splitMessage } from './util'

export { Config, name } from './config'

export const inject = {
  // 注意：puppeteer 不能写在这里。声明成 optional 之后，cordis 会把该服务在本插件
  // 作用域里遮罩成 undefined（连 ctx.root 都取不到），导致渲染永远走降级。
  // 可选依赖的正确写法是下面的 ctx.inject(['puppeteer'], ...)。
  required: ['database'],
}

export const usage = `把 bot 变成 AI 海龟汤主持人。

1. 放汤：把 JSON 汤文件放进 \`data/situation-puzzle/tales/\`，或用「海龟汤 汤库 重载」重扫。
2. 配 Key：在插件配置里填 apiKey（或设环境变量 DEEPSEEK_API_KEY）。
3. 绑主人：发送「海龟汤 主人 绑定」，到控制台日志里取 6 位密钥再发一次。
4. 开局：「海龟汤 开局」，之后「海龟汤 问 …」「海龟汤 提交 …」。

出图需要额外安装 koishi-plugin-puppeteer；没装也能玩，只发纯文本。`

interface ChannelRules {
  questionQuota: number
  guessQuota: number
  personalGuessQuota: number
  passThreshold: number
  maxDuration: number
  joinWindow: number
  renderMode: 'image-first' | 'text'
}

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh-CN', zhCN)
  ctx.i18n.define('en-US', enUS)
  setupModel(ctx)

  const logger = ctx.logger('soup')
  const ai = new AIClient(ctx, config, logger)
  const game = new Game(ctx, config, logger, ai)
  // puppeteer 是可选服务：不能直接写进 inject.optional（那样会被 cordis 遮罩成 undefined），
  // 必须用 ctx.inject 包成子插件——服务存在时才实例化渲染器，不存在就永远走纯文本。
  let renderer: Renderer | null = null
  ctx.inject(['puppeteer'], (ctx) => {
    renderer = new Renderer(ctx, config, logger)
    logger.info('已检测到 puppeteer 服务，汤面默认发送报纸图（可用「海龟汤 渲染 关闭」切回纯文本）')
    ctx.on('dispose', () => { renderer = null })
  })
  const pending = new Map<string, { code: string; expires: number }>()

  ctx.on('dispose', () => game.dispose())

  // ---------------------------------------------------------------- 工具
  const t = (session: Session, key: string, args?: unknown[]) =>
    session.text(`situation-puzzle.${key}`, args as string[])

  const num = (value: string | undefined, fallback: number): number => {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }

  async function channelRules(channelKey: string): Promise<ChannelRules> {
    const rows = await ctx.database.get(TABLES.override, { channelKey })
    const map = new Map(rows.map((row) => [row.field, row.value]))
    const mode = map.get('renderMode')
    return {
      questionQuota: num(map.get('questionQuota'), config.defaultQuestionQuota),
      guessQuota: num(map.get('guessQuota'), config.defaultGuessQuota),
      personalGuessQuota: num(map.get('personalGuessQuota'), config.personalGuessQuota),
      passThreshold: num(map.get('passThreshold'), config.passThreshold),
      maxDuration: num(map.get('maxDuration'), config.maxDuration),
      joinWindow: num(map.get('joinWindow'), config.joinWindow),
      renderMode: mode === 'text' || mode === 'image-first' ? mode : config.renderMode,
    }
  }

  async function setOverride(channelKey: string, field: string, value: string) {
    const now = new Date()
    const existing = await ctx.database.get(TABLES.override, { channelKey, field })
    if (existing.length) {
      await ctx.database.set(TABLES.override, existing[0].id, { value, updatedAt: now })
    } else {
      await ctx.database.create(TABLES.override, { channelKey, field, value, updatedAt: now })
    }
  }

  async function requireMaster(session: Session): Promise<void> {
    const master = await getMaster(ctx, session.platform, session.selfId)
    if (!master) throw new GameError('no-master')
    if (master.userId !== userKeyOf(session)) throw new GameError('no-permission')
  }

  function mapError(session: Session, error: GameError): string {
    const data = error.data || {}
    switch (error.code) {
      case 'busy': return t(session, 'busy', [String(data.title ?? '')])
      case 'no-session': return t(session, 'noSession')
      case 'not-running': return t(session, 'joinClosed')
      case 'not-joining': return t(session, 'ended')
      case 'not-joined': return t(session, 'notJoined')
      case 'full': return t(session, 'joinFull', [config.maxPlayers])
      case 'already-joined': return t(session, 'joinDuplicate')
      case 'quota-question': return t(session, 'quotaQuestion', [String(data.remaining ?? 0)])
      case 'quota-guess': return t(session, 'quotaGuess')
      case 'cooldown': return t(session, 'cooldown', [String(data.seconds ?? 0)])
      case 'not-found': return t(session, 'taleNotFound', [String(data.title ?? '')])
      case 'disabled': return t(session, 'taleDisabled')
      case 'incomplete': return t(session, 'taleIncomplete')
      case 'no-permission': return t(session, 'noPermission')
      case 'no-master': return t(session, 'noMaster')
      case 'ai-unavailable':
        return String(data.reason) === 'daily-limit'
          ? t(session, 'aiDailyLimit')
          : t(session, 'aiNotConfigured')
      case 'ai-error': {
        const reason = String(data.reason || '')
        if (reason === 'auth') return t(session, 'aiAuthFailed')
        if (reason === 'model') return t(session, 'aiModelInvalid')
        if (reason === 'empty-question') return t(session, 'aiEmptyQuestion')
        return t(session, 'aiUnreachable')
      }
      default:
        return t(session, 'aiUnreachable')
    }
  }

  /** 统一把 GameError 转成文案，其他异常交给框架 */
  async function run<T>(session: Session, fn: () => Promise<T>): Promise<T | string> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof GameError) return mapError(session, error)
      throw error
    }
  }

  async function sendText(session: Session, text: string) {
    for (const chunk of splitMessage(text, config.maxMessageLength)) {
      await session.send(chunk)
    }
  }

  async function pickTale(session: Session, keyword?: string): Promise<Tale> {
    if (keyword) {
      const exact = await ctx.database.get(TABLES.tale, { taleId: keyword.trim() })
      const found = exact.length ? exact : (await listTales(ctx, { keyword, all: true })).slice(0, 10)
      if (!found.length) throw new GameError('not-found', { title: keyword })
      const tale = found[0]
      const problem = tellableTale(tale)
      if (problem) throw new GameError(tale.enabled ? 'incomplete' : 'disabled')
      return tale
    }

    const pool = (await listTales(ctx)).filter((tale) => !tellableTale(tale))
    if (!pool.length) throw new GameError('not-found', { title: '' })
    const fresh = pool.filter((tale) => !tale.playedCount)
    const candidates = fresh.length ? fresh : pool
    return candidates[Math.floor(Math.random() * candidates.length)]
  }

  /** 发送汤面：优先图片，失败降级文本 */
  async function sendSheet(
    session: Session,
    sessionRow: GameSession,
    tale: Tale,
    rules: ChannelRules,
    forceText = false,
  ): Promise<void> {
    const plan = await game.ensurePlan(tale)
    const useImage = !forceText && rules.renderMode !== 'text'

    if (useImage && renderer) {
      const sheet = {
        plan,
        paperName: plan.masthead?.name || config.paperName,
        issue: tale.id,
        date: new Date(),
        difficulty: difficultyLabel(tale.difficulty),
        tags: tale.tags ?? [],
        questionQuota: sessionRow.questionQuota,
        guessQuota: sessionRow.guessQuota,
        passThreshold: sessionRow.passThreshold,
        personalGuessQuota: sessionRow.personalGuessQuota,
        footerHint: config.renderFooterHint,
      }
      const output = await renderer.render(sheet)
      if (output.ok && output.image) {
        try {
          await session.send(h.image(`data:${output.mime};base64,${output.image.toString('base64')}`))
          if (config.renderCaption) await session.send(t(session, 'renderCaption'))
          await ctx.database.set(TABLES.session, sessionRow.id, { renderMode: 'image' })
          return
        } catch (error) {
          renderer?.reportSendFailure()
          logger.warn('图片发送失败，降级文本：%s', (error as Error).message)
        }
      }
    }

    await ctx.database.set(TABLES.session, sessionRow.id, { renderMode: 'text' })
    await sendText(session, t(session, 'opened', [tale.title, difficultyLabel(tale.difficulty), tale.surface]))
    await sendText(session, rulesText(session, sessionRow))
  }

  function difficultyLabel(difficulty: string): string {
    return difficulty === 'easy' ? '简单' : difficulty === 'hard' ? '困难' : '普通'
  }

  function rulesText(session: Session, row: GameSession): string {
    const quota = row.questionQuota > 0
      ? t(session, 'quotaLimited', [row.questionQuota])
      : t(session, 'quotaUnlimited')
    const personal = row.personalGuessQuota > 0 ? ` · 个人 ${row.personalGuessQuota} 次` : ''
    return t(session, 'openedRules', [
      quota,
      row.guessQuota,
      personal,
      Math.round(row.passThreshold * 100),
    ])
  }

  function verdictText(session: Session, verdict: string): string {
    switch (verdict) {
      case 'yes': return t(session, 'verdictYes')
      case 'no': return t(session, 'verdictNo')
      case 'partial': return t(session, 'verdictPartial')
      default: return t(session, 'verdictIrrelevant')
    }
  }

  // ---------------------------------------------------------------- 生命周期
  ctx.on('ready', async () => {
    if (config.autoImport) {
      // 先铺内置样例汤（只在汤库为空时铺），再扫库——否则新装用户一开局就是「汤库为空」
      if (config.seedBundled) await seedBundledTales(ctx, config, logger)
      const report = await importTales(ctx, config, logger)
      if (report.errors.length) logger.warn('汤库有 %d 条失败记录', report.failed)
    }
    await renderer?.pruneCache()

    if (config.modelCheck && ai.available) {
      fetch(`${config.baseURL.replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${ai.apiKey}` },
      }).then(async (response) => {
        if (!response.ok) return
        const payload = await response.json() as { data?: Array<{ id: string }> }
        const ids = payload.data?.map((item) => item.id) ?? []
        if (ids.length && !ids.includes(config.model)) {
          logger.warn('模型 %s 不在服务端列表中（可用：%s），请检查配置', config.model, ids.slice(0, 8).join(', '))
        }
      }).catch(() => undefined)
    }
  })

  // ---------------------------------------------------------------- 旧语法迁移
  // 不能靠 L1 的 text 参数来兜，那会把「海龟汤 汤库」这类合法子指令一并吞掉，
  // 所以放在中间件里，只拦 v0 文档里那几个两段式写法。
  ctx.middleware((session, next) => {
    const content = session.content?.trim()
    if (!content?.startsWith('海龟汤 ')) return next()
    const legacy = content.slice(4).trim()
    const map: Record<string, string> = {
      绑定: '主人 绑定',
      解绑: '主人 解绑',
      设置: '主人 设置',
      导入: '汤库 重载',
    }
    const target = map[legacy]
    return target ? t(session, 'legacyCommand', [legacy, target]) : next()
  }, true)

  // ---------------------------------------------------------------- L1
  ctx.command('海龟汤', { authority: 1 })
    .usage('海龟汤 开局 → 海龟汤 问 <问题> → 海龟汤 提交 <推理>')
    .action(async ({ session }) => {
      if (!session) return

      const row = await game.active(channelKeyOf(session))
      if (!row) return t(session, 'noSession')

      return t(session, 'status', [
        row.taleSnapshot.title,
        row.status === 'joining' ? '集结中' : '进行中',
        row.questionsUsed,
        row.questionQuota > 0 ? String(row.questionQuota) : '∞',
        row.guessesUsed,
        row.guessQuota,
        Math.round(row.passThreshold * 100),
        formatDuration(Date.now() - new Date(row.startedAt).getTime()),
      ])
    })

  // ---------------------------------------------------------------- 开局
  ctx.command('海龟汤.开局 [tale:text]', { authority: 1 })
    .option('text', '-t, --text 本场强制纯文本')
    .action(async ({ session, options }, keyword) => {
      if (!session) return
      return run(session, async () => {
        const key = channelKeyOf(session)
        const rules = await channelRules(key)
        const tale = await pickTale(session, keyword)
        const row = await game.open(key, tale, userKeyOf(session), session.guildId || '', {
          questionQuota: rules.questionQuota,
          guessQuota: rules.guessQuota,
          personalGuessQuota: rules.personalGuessQuota,
          passThreshold: rules.passThreshold,
          maxDuration: rules.maxDuration,
          joinWindow: rules.joinWindow,
        })

        await sendSheet(session, row, tale, rules, !!options?.text)

        if (row.status === 'joining') {
          await sendText(session, t(session, 'joining', [rules.joinWindow, row.personalGuessQuota]))
        }
      })
    })

  // ---------------------------------------------------------------- 加入 / 开始
  ctx.command('海龟汤.加入', { authority: 1 }).action(async ({ session }) => {
    if (!session) return
    return run(session, async () => {
      const row = await game.active(channelKeyOf(session))
      if (!row) throw new GameError('no-session')
      const result = await game.join(row, userKeyOf(session))
      return t(session, 'joined', [session.username || '玩家', result.joined, result.max])
    })
  })

  ctx.command('海龟汤.开始', { authority: 1 }).action(async ({ session }) => {
    if (!session) return
    return run(session, async () => {
      const row = await game.active(channelKeyOf(session))
      if (!row) throw new GameError('no-session')
      const master = await getMaster(ctx, session.platform, session.selfId)
      const allowed = row.openerId === userKeyOf(session) || master?.userId === userKeyOf(session)
      if (!allowed) throw new GameError('no-permission')
      await game.startEarly(row)
      return t(session, 'joinStarted')
    })
  })

  // ---------------------------------------------------------------- 问
  ctx.command('海龟汤.问 <content:text>', { authority: 1 }).action(async ({ session }, content) => {
    if (!session) return
    return run(session, async () => {
      const row = await game.requireRunning(channelKeyOf(session))
      const result = await game.ask(row, userKeyOf(session), content || '')

      const pieces: string[] = []
      if (config.verdictWithAt) pieces.push(t(session, 'verdictAtPrefix', [h.at(session.userId).toString()]))
      pieces.push(verdictText(session, result.verdict))

      if (result.duplicated) {
        return t(session, 'duplicateQuestion', [pieces.join('')])
      }
      if (config.verdictWithQuota && result.remaining >= 0 && result.remaining <= 3) {
        pieces.push(t(session, 'verdictQuotaSuffix', [result.remaining]))
      }
      return pieces.join('')
    })
  })

  // ---------------------------------------------------------------- 提交
  ctx.command('海龟汤.提交 <content:text>', { authority: 1 }).action(async ({ session }, content) => {
    if (!session) return
    return run(session, async () => {
      const row = await game.requireRunning(channelKeyOf(session))
      const outcome = await game.guess(row, userKeyOf(session), content || '')
      const threshold = Math.round(row.passThreshold * 100)

      if (outcome.passed) {
        const lines = [
          t(session, 'guessPassed', [outcome.score, threshold]),
          t(session, 'settleWin', [session.username || '玩家', outcome.score]),
          t(session, 'answerTitle'),
          row.taleSnapshot.answer,
          t(session, 'sessionStats', [
            row.questionsUsed + 1,
            row.guessesUsed + 1,
            formatDuration(Date.now() - new Date(row.startedAt).getTime()),
            '1',
          ]),
        ]
        await sendText(session, lines.join('\n'))
        return
      }

      const comment = outcome.score >= 60
        ? t(session, 'commentNear')
        : outcome.score >= 30 ? t(session, 'commentPart') : t(session, 'commentFar')

      let text = t(session, 'guessScore', [
        outcome.score,
        threshold,
        comment,
        outcome.remainingPersonal,
        outcome.remainingPublic,
      ])

      if (config.showScoreDetail && outcome.detail.length) {
        const marks = outcome.detail
          .map((item) => `${item.id}${item.hit === 'yes' ? '✅' : item.hit === 'partial' ? '⚠️' : '❌'}`)
          .join(' ')
        text += '\n' + t(session, 'scoreDetail', [marks])
      }
      return text
    })
  })

  // ---------------------------------------------------------------- 汤面 / 汤底 / 状态 / 结束
  ctx.command('海龟汤.汤面', { authority: 1 })
    .option('text', '-t, --text 纯文本发送')
    .action(async ({ session, options }) => {
      if (!session) return
      return run(session, async () => {
        const row = await game.active(channelKeyOf(session))
        if (!row) throw new GameError('no-session')
        const tale = (await ctx.database.get(TABLES.tale, row.taleRowId))[0]
        const rules = await channelRules(channelKeyOf(session))
        if (!tale) throw new GameError('not-found', { title: row.taleSnapshot.title })
        await sendSheet(session, row, tale, rules, !!options?.text)
      })
    })

  ctx.command('海龟汤.汤底', { authority: 1 }).action(async ({ session }) => {
    if (!session) return
    const rows = await ctx.database.get(TABLES.session, { channelKey: channelKeyOf(session), status: 'settled' })
    if (!rows.length) return t(session, 'noActiveSession')
    const latest = rows.sort((a, b) => +new Date(b.settledAt) - +new Date(a.settledAt))[0]
    await sendText(session, `${t(session, 'answerTitle')}\n${latest.taleSnapshot.answer}`)
  })

  ctx.command('海龟汤.状态', { authority: 1 }).action(async ({ session }) => {
    if (!session) return
    const row = await game.active(channelKeyOf(session))
    if (!row) return t(session, 'noSession')
    return t(session, 'status', [
      row.taleSnapshot.title,
      row.status === 'joining' ? '集结中' : '进行中',
      row.questionsUsed,
      row.questionQuota > 0 ? String(row.questionQuota) : '∞',
      row.guessesUsed,
      row.guessQuota,
      Math.round(row.passThreshold * 100),
      formatDuration(Date.now() - new Date(row.startedAt).getTime()),
    ])
  })

  ctx.command('海龟汤.结束', { authority: 1 }).action(async ({ session }) => {
    if (!session) return
    return run(session, async () => {
      const row = await game.active(channelKeyOf(session))
      if (!row) throw new GameError('no-session')
      const master = await getMaster(ctx, session.platform, session.selfId)
      const mine = row.openerId === userKeyOf(session) && config.hostCanEnd
      if (!mine && master?.userId !== userKeyOf(session)) throw new GameError('no-permission')

      const settled = await game.settle(row.id, 'manual')
      if (!settled) return t(session, 'ended')
      await sendText(session, [
        t(session, 'settleManual', [session.username || '玩家']),
        t(session, 'answerTitle'),
        row.taleSnapshot.answer,
      ].join('\n'))
    })
  })

  // ---------------------------------------------------------------- 战绩
  ctx.command('海龟汤.战绩', { authority: 1 })
    .option('self', '-s, --self 只看自己的数据')
    .action(async ({ session, options }) => {
      if (!session) return
      const rows = await ctx.database.get(TABLES.session, { channelKey: channelKeyOf(session), status: 'settled' })
      if (!rows.length) return t(session, 'noActiveSession')
      const recent = rows.sort((a, b) => +new Date(b.settledAt) - +new Date(a.settledAt)).slice(0, 10)
      const lines = recent.map((row) => {
        const flag = row.winnerId ? '✅' : '—'
        return `${flag} 《${row.taleSnapshot.title}》 提问 ${row.questionsUsed} / 提交 ${row.guessesUsed}`
      })
      if (options?.self) {
        const mine = rows.filter((row) => row.winnerId === userKeyOf(session))
        lines.unshift(`你猜中过 ${mine.length} 锅。`)
      }
      return lines.join('\n')
    })

  // ---------------------------------------------------------------- 汤库
  ctx.command('海龟汤.汤库', { authority: 1 }).action(async ({ session }) => {
    if (!session) return
    const rows = await listTales(ctx, {})
    if (!rows.length) return t(session, 'libraryEmpty', [resolveTalesDir(ctx, config)])
    return t(session, 'libraryHeader', [rows.length, 1, 1]) + '\n'
      + rows.slice(0, 20).map((tale, index) =>
        t(session, 'libraryItem', [index + 1, tale.title, difficultyLabel(tale.difficulty), tale.playedCount]),
      ).join('\n')
  })

  ctx.command('海龟汤.汤库.列表', { authority: 1 })
    .option('keyword', '-k <keyword:string> 按汤名或标签筛选')
    .option('all', '-a 包含已停用')
    .action(async ({ session, options }) => {
      if (!session) return
      const rows = await listTales(ctx, { keyword: options?.keyword as string, all: !!options?.all })
      if (!rows.length) return t(session, 'libraryEmpty', [resolveTalesDir(ctx, config)])
      return t(session, 'libraryHeader', [rows.length, 1, 1]) + '\n'
        + rows.slice(0, 20).map((tale, index) =>
          t(session, 'libraryItem', [index + 1, tale.title, difficultyLabel(tale.difficulty), tale.playedCount])
          + (tale.enabled ? '' : t(session, 'libraryItemDisabled')),
        ).join('\n')
    })

  ctx.command('海龟汤.汤库.查看 <target:string>', { authority: 1 }).action(async ({ session }, target) => {
    if (!session) return
    const rows = await findTaleRows(target)
    if (!rows.length) return t(session, 'taleNotFound', [target])
    const tale = rows[0]
    return t(session, 'taleDetail', [
      tale.title,
      difficultyLabel(tale.difficulty),
      (tale.tags ?? []).join(' / ') || '无',
      (tale.keys ?? []).length,
      tale.surface.slice(0, 500),
    ])
  })

  async function findTaleRows(target: string): Promise<Tale[]> {
    if (!target) return []
    const byId = await ctx.database.get(TABLES.tale, { taleId: target.trim() })
    if (byId.length) return byId
    return (await listTales(ctx, { keyword: target, all: true })).slice(0, 5)
  }

  for (const action of ['启用', '停用', '删除'] as const) {
    ctx.command(`海龟汤.汤库.${action} <target:string>`, { authority: 1 }).action(async ({ session }, target) => {
      if (!session) return
      return run(session, async () => {
        await requireMaster(session)
        const rows = await findTaleRows(target)
        if (!rows.length) throw new GameError('not-found', { title: target })
        const tale = rows[0]
        if (action === '删除') {
          await ctx.database.set(TABLES.tale, tale.id, { enabled: false, updatedAt: new Date() })
          return t(session, 'taleRemoved', [tale.title])
        }
        const enabled = action === '启用'
        await ctx.database.set(TABLES.tale, tale.id, { enabled, updatedAt: new Date() })
        return enabled ? t(session, 'taleEnabled', [tale.title]) : t(session, 'taleDisabledDone', [tale.title])
      })
    })
  }

  const reload = async (session: Session, only?: string) => run(session, async () => {
    await requireMaster(session)
    const report = await importTales(ctx, config, logger, { only })
    const text = t(session, 'libraryUpdated', [report.added, report.updated, report.skipped, report.failed])
    return report.errors.length
      ? text + '\n' + t(session, 'libraryImportFailed', [report.errors.slice(0, 5).join('\n')])
      : text
  })

  ctx.command('海龟汤.汤库.重载', { authority: 1 }).action(async ({ session }) => {
    if (!session) return
    return reload(session)
  })

  ctx.command('海龟汤.汤库.导入 [path:string]', { authority: 1 }).action(async ({ session }, path) => {
    if (!session) return
    return reload(session, path)
  })

  // ---------------------------------------------------------------- 主人
  ctx.command('海龟汤.主人', { authority: 1 }).action(async ({ session }) => {
    if (!session) return
    const master = await getMaster(ctx, session.platform, session.selfId)
    return master ? t(session, 'masterInfo', [master.userId]) : t(session, 'masterNone')
  })

  ctx.command('海龟汤.主人.绑定 [code:string]', { authority: 1 }).action(async ({ session }, code) => {
    if (!session) return
    const key = pendingKey(session.platform, session.selfId, userKeyOf(session))

    if (!code) {
      if (await getMaster(ctx, session.platform, session.selfId)) return t(session, 'bindExists')
      const issued = issueCode(pending, key, config.masterAuthTTL)
      logger.info('主人绑定密钥（%s / %s）：%s，%d 秒内有效', session.selfId, userKeyOf(session), issued, config.masterAuthTTL)
      return t(session, 'bindRequested', [Math.round(config.masterAuthTTL / 60)])
    }

    if (!consumeCode(pending, key, code)) return t(session, 'bindFailed')
    const ok = await bindMaster(ctx, session.platform, session.selfId, userKeyOf(session))
    return ok ? t(session, 'bindSuccess') : t(session, 'bindExists')
  })

  ctx.command('海龟汤.主人.解绑', { authority: 1 }).action(async ({ session }) => {
    if (!session) return
    return run(session, async () => {
      await requireMaster(session)
      await unbindMaster(ctx, session.platform, session.selfId)
      return t(session, 'unbound')
    })
  })

  // ---------------------------------------------------------------- 设置
  const SETTINGS: Record<string, { field: string; min: number; max: number; label: string }> = {
    提问次数: { field: 'questionQuota', min: 0, max: 999, label: '提问次数' },
    提交次数: { field: 'guessQuota', min: 1, max: 20, label: '提交次数' },
    个人次数: { field: 'personalGuessQuota', min: 0, max: 10, label: '个人次数' },
    阈值: { field: 'passThreshold', min: 50, max: 100, label: '阈值' },
    加入时长: { field: 'joinWindow', min: 10, max: 600, label: '加入时长' },
    时长: { field: 'maxDuration', min: 0, max: 86400, label: '时长' },
    出图: { field: 'renderMode', min: 0, max: 1, label: '出图' },
  }

  ctx.command('海龟汤.主人.设置 [key:string] [value:string]', { authority: 1 }).action(async ({ session }, key, value) => {
    if (!session) return
    return run(session, async () => {
      await requireMaster(session)
      const channelKey = channelKeyOf(session)
      const rules = await channelRules(channelKey)

      if (!key) {
        const lines = Object.entries(SETTINGS).map(([name, meta]) => {
          const current = meta.field === 'renderMode'
            ? rules.renderMode
            : (rules as any)[meta.field]
          return t(session, 'settingItem', [name, String(current), t(session, 'settingScopeChannel')])
        })
        return t(session, 'settingList', [lines.join('\n')])
      }

      const meta = SETTINGS[key]
      if (!meta) return t(session, 'settingUnknown')

      if (meta.field === 'renderMode') {
        const normalized = (value || '').trim()
        if (!['开', '关', 'image-first', 'text'].includes(normalized)) {
          return t(session, 'settingInvalid', [key, '开 / 关'])
        }
        const mode = normalized === '开' || normalized === 'image-first' ? 'image-first' : 'text'
        await setOverride(channelKey, 'renderMode', mode)
        return t(session, mode === 'text' ? 'renderOff' : 'renderOn')
      }

      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric < meta.min || numeric > meta.max) {
        return t(session, 'settingInvalid', [key, `${meta.min} ~ ${meta.max}`])
      }
      const stored = meta.field === 'passThreshold' ? numeric / 100 : numeric
      await setOverride(channelKey, meta.field, String(stored))
      return t(session, 'settingUpdated', [meta.label, value])
    })
  })

  // ---------------------------------------------------------------- 渲染
  ctx.command('海龟汤.渲染', { authority: 1 }).action(async ({ session }) => {
    if (!session) return
    const rules = await channelRules(channelKeyOf(session))
    return t(session, 'renderStatus', [
      renderer?.available ? t(session, 'renderBackendPuppeteer') : t(session, 'renderBackendText'),
      config.renderTheme,
      config.renderCacheMaxMB,
      rules.renderMode,
    ])
  })

  ctx.command('海龟汤.渲染.状态', { authority: 1 }).action(async ({ session }) => {
    if (!session) return
    const rules = await channelRules(channelKeyOf(session))
    return t(session, 'renderStatus', [
      renderer?.available ? t(session, 'renderBackendPuppeteer') : t(session, 'renderBackendText'),
      config.renderTheme,
      config.renderCacheMaxMB,
      rules.renderMode,
    ])
  })

  ctx.command('海龟汤.渲染.测试', { authority: 1 }).action(async ({ session }) => {
    if (!session) return
    return run(session, async () => {
      await requireMaster(session)
      if (!renderer?.available) return t(session, 'renderNeedsBackend')

      const rows = await listTales(ctx, { all: true })
      const tale = rows[0]
      if (!tale) return t(session, 'libraryEmpty', [resolveTalesDir(ctx, config)])
      const plan = await game.ensurePlan(tale)
      const started = Date.now()
      const output = await renderer.render({
        plan,
        paperName: plan.masthead?.name || config.paperName,
        issue: tale.id,
        date: new Date(),
        difficulty: difficultyLabel(tale.difficulty),
        tags: tale.tags ?? [],
        questionQuota: config.defaultQuestionQuota,
        guessQuota: config.defaultGuessQuota,
        passThreshold: config.passThreshold,
        personalGuessQuota: config.personalGuessQuota,
        footerHint: config.renderFooterHint,
      })
      if (!output.ok || !output.image) return t(session, 'renderTestFailed')
      await session.send(h.image(`data:${output.mime};base64,${output.image.toString('base64')}`))
      return t(session, 'renderTestOk', [Date.now() - started])
    })
  })

  for (const action of ['开启', '关闭'] as const) {
    ctx.command(`海龟汤.渲染.${action}`, { authority: 1 }).action(async ({ session }) => {
      if (!session) return
      return run(session, async () => {
        await requireMaster(session)
        await setOverride(channelKeyOf(session), 'renderMode', action === '开启' ? 'image-first' : 'text')
        return t(session, action === '开启' ? 'renderOn' : 'renderOff')
      })
    })
  }

  ctx.command('海龟汤.渲染.主题 [theme:string]', { authority: 1 }).action(async ({ session }, theme) => {
    if (!session) return
    return run(session, async () => {
      await requireMaster(session)
      if (!theme) return t(session, 'renderThemeSet', [config.renderTheme])
      if (!['newspaper', 'plain'].includes(theme)) {
        return t(session, 'renderThemeInvalid', ['newspaper / plain'])
      }
      await setOverride(channelKeyOf(session), 'renderTheme', theme)
      return t(session, 'renderThemeSet', [theme])
    })
  })

  // ---------------------------------------------------------------- 站点诊断
  ctx.command('海龟汤.诊断', { authority: 1 })
    .usage('检查 AI 站点连通性：Key、/models、模型名、能否真正跑通一次推理')
    .option('fast', '-f, --fast 只测站点与模型列表，不做推理调用')
    .action(async ({ session, options }) => {
      if (!session) return
      const report = await ai.diagnose({ skipProbe: !!options?.fast })

      if (!report.configured) return t(session, 'diagNotConfigured')

      const lines: string[] = [t(session, 'diagHeader', [report.baseURL, report.model])]

      lines.push(report.endpoint.ok
        ? t(session, 'diagEndpointOk', [report.endpoint.status ?? 200, report.endpoint.latencyMs])
        : t(session, 'diagEndpointFail', [report.endpoint.error || 'unknown', report.endpoint.latencyMs]))

      if (report.models.ok) {
        lines.push(report.models.found
          ? t(session, 'diagModelOk', [report.model])
          : t(session, 'diagModelMissing', [report.models.sample || '—']))
      } else if (!report.endpoint.ok) {
        lines.push(t(session, 'diagModelsSkipped'))
      }

      if ('skipped' in report.probe) {
        lines.push(t(session, 'diagProbeSkipped'))
      } else {
        lines.push(report.probe.ok
          ? t(session, 'diagProbeOk', [report.probe.latencyMs])
          : t(session, 'diagProbeFail', [report.probe.error || 'unknown']))
      }

      lines.push(t(session, 'diagQuota', [
        report.callsToday,
        report.dailyCallLimit > 0 ? String(report.dailyCallLimit) : '∞',
      ]))
      return lines.join('\n')
    })
}
