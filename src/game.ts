import { $, Context, Logger, Session } from 'koishi'
import type { AIClient, ScoreResult } from './ai'
import { AIError } from './ai'
import type { Config } from './config'
import { TABLES } from './db'
import type { LayoutPlan, Tale, TaleSnapshot, GameSession, Verdict } from './types'
import { normalizeQuestion } from './util'

export type GameErrorCode =
  | 'busy'
  | 'no-session'
  | 'not-running'
  | 'not-joining'
  | 'not-joined'
  | 'full'
  | 'already-joined'
  | 'quota-question'
  | 'quota-guess'
  | 'cooldown'
  | 'duplicate'
  | 'not-found'
  | 'disabled'
  | 'incomplete'
  | 'ai-unavailable'
  | 'ai-error'
  | 'no-permission'
  | 'no-master'

export class GameError extends Error {
  constructor(public code: GameErrorCode, public data: Record<string, unknown> = {}) {
    super(code)
    this.name = 'GameError'
  }
}

export function channelKeyOf(session: Session): string {
  return `${session.platform}:${session.channelId}`
}

export function userKeyOf(session: Session): string {
  return `${session.platform}:${session.userId}`
}

/** 默认版面：AI 不可用时的兜底，保证玩家总能看到一张报纸 */
export function defaultPlan(tale: Pick<Tale, 'title' | 'surface' | 'difficulty' | 'tags'>): LayoutPlan {
  const paragraphs = tale.surface
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)

  return {
    version: 1,
    title: tale.title.slice(0, 14),
    body: paragraphs.length ? paragraphs.slice(0, 6) : [tale.surface],
    style: {
      accent: tale.tags.some((t) => /恐怖|血腥|暴/.test(t)) ? 'blood' : 'rust',
      columns: 2,
      dropCap: true,
    },
    stamp: { text: '本报独家' },
  }
}

export interface GuessOutcome {
  score: number
  passed: boolean
  quotaSource: 'personal' | 'public'
  remainingPersonal: number
  remainingPublic: number
  detail: ScoreResult['points']
  settled: boolean
}

export interface OpenRules {
  questionQuota: number
  guessQuota: number
  personalGuessQuota: number
  passThreshold: number
  maxDuration: number
  joinWindow: number
}

export class Game {
  private timers = new Map<number, Array<() => void>>()
  private cooldowns = new Map<string, number>()
  private judged = new Map<number, Map<string, Verdict>>()

  constructor(
    private ctx: Context,
    private config: Config,
    private logger: Logger,
    private ai: AIClient,
  ) {}

  // ------------------------------------------------------------------ 查询
  async active(channelKey: string): Promise<GameSession | undefined> {
    const rows = await this.ctx.database.get(TABLES.session, {
      channelKey,
      status: { $in: ['joining', 'running'] },
    } as any)
    return rows[0]
  }

  async requireRunning(channelKey: string): Promise<GameSession> {
    const row = await this.active(channelKey)
    if (!row) throw new GameError('no-session')
    if (row.status !== 'running') throw new GameError('not-running')
    return row
  }

  // ------------------------------------------------------------------ 开局
  async open(channelKey: string, tale: Tale, openerId: string, guildId: string, rules: OpenRules): Promise<GameSession> {
    const busy = await this.active(channelKey)
    if (busy) throw new GameError('busy', { title: busy.taleSnapshot?.title ?? '' })

    const snapshot: TaleSnapshot = {
      taleId: tale.taleId,
      title: tale.title,
      difficulty: tale.difficulty,
      surface: tale.surface,
      answer: tale.answer,
      keys: tale.keys ?? [],
    }

    const joining = rules.personalGuessQuota > 0
    const now = new Date()

    const row = await this.ctx.database.create(TABLES.session, {
      channelKey,
      platform: channelKey.split(':')[0],
      channelId: channelKey.split(':').slice(1).join(':'),
      guildId,
      taleRowId: tale.id,
      taleSnapshot: snapshot,
      status: joining ? 'joining' : 'running',
      endReason: '',
      renderMode: 'text',
      openerId,
      winnerId: '',
      questionQuota: rules.questionQuota,
      questionsUsed: 0,
      guessQuota: rules.guessQuota,
      guessesUsed: 0,
      personalGuessQuota: rules.personalGuessQuota,
      passThreshold: rules.passThreshold,
      maxDuration: rules.maxDuration,
      startedAt: now,
      settledAt: new Date(0),
    })

    await this.ctx.database.set(TABLES.tale, tale.id, (row2) => ({
      playedCount: $.add(row2.playedCount, 1),
    }))

    if (joining) {
      this.schedule(row.id, rules.joinWindow * 1000, () => this.finishJoining(row.id))
    }
    if (rules.maxDuration > 0) {
      this.schedule(row.id, rules.maxDuration * 1000, () => this.settle(row.id, 'timeout'))
    }

    return row
  }

  // ------------------------------------------------------------------ 加入
  async join(session: GameSession, userId: string): Promise<{ joined: number; max: number }> {
    if (session.status !== 'joining') throw new GameError('not-joining')

    const existing = await this.ctx.database.get(TABLES.player, { sessionId: session.id, userId })
    if (existing.length) throw new GameError('already-joined')

    const players = await this.ctx.database.get(TABLES.player, { sessionId: session.id })
    if (players.length >= this.config.maxPlayers) throw new GameError('full')

    await this.ctx.database.create(TABLES.player, {
      sessionId: session.id,
      userId,
      personalGuessUsed: 0,
      guesses: 0,
      joinedAt: new Date(),
    })

    return { joined: players.length + 1, max: this.config.maxPlayers }
  }

  private async finishJoining(sessionId: number): Promise<void> {
    const [row] = await this.ctx.database.get(TABLES.session, sessionId)
    if (!row || row.status !== 'joining') return

    const players = await this.ctx.database.get(TABLES.player, { sessionId })
    if (!players.length) {
      await this.settle(sessionId, 'cancel')
      return
    }
    await this.ctx.database.set(TABLES.session, { id: sessionId, status: 'joining' }, { status: 'running' })
  }

  /** 发起人在窗口内提前开始 */
  async startEarly(session: GameSession): Promise<void> {
    if (session.status !== 'joining') throw new GameError('not-running')
    const players = await this.ctx.database.get(TABLES.player, { sessionId: session.id })
    if (!players.length) throw new GameError('not-joined')
    await this.ctx.database.set(TABLES.session, { id: session.id, status: 'joining' }, { status: 'running' })
    this.clearTimers(session.id)
  }

  // ------------------------------------------------------------------ 提问
  async ask(
    session: GameSession,
    userId: string,
    question: string,
  ): Promise<{ verdict: Verdict; remaining: number; duplicated: boolean }> {
    if (session.status !== 'running') throw new GameError('not-running')

    const cooldownKey = `${session.id}:${userId}:q`
    this.checkCooldown(cooldownKey, this.config.questionCooldown)

    const normalized = normalizeQuestion(question)
    if (!normalized) throw new GameError('ai-error', { reason: 'empty-question' })

    const cache = this.judged.get(session.id) ?? new Map<string, Verdict>()
    this.judged.set(session.id, cache)
    const cachedVerdict = cache.get(normalized)
    if (cachedVerdict) {
      return { verdict: cachedVerdict, remaining: this.questionRemaining(session), duplicated: true }
    }

    if (session.questionQuota > 0 && session.questionsUsed >= session.questionQuota) {
      throw new GameError('quota-question', { remaining: 0 })
    }

    let judged
    try {
      judged = await this.ai.judge(question, session.taleSnapshot.answer)
    } catch (error) {
      throw this.aiError(error)
    }

    if (!this.config.allowPartialAnswer && judged.verdict === 'partial') {
      judged.verdict = 'irrelevant'
    }

    await this.consumeQuestion(session)
    cache.set(normalized, judged.verdict as Verdict)
    this.touchCooldown(cooldownKey)

    try {
      await this.ctx.database.create(TABLES.question, {
        sessionId: session.id,
        userId,
        content: question.slice(0, 500),
        verdict: judged.verdict,
        cached: false,
        model: judged.model,
        latencyMs: judged.latencyMs,
        createdAt: new Date(),
      })
    } catch (error) {
      this.logger.debug('提问落库失败：%s', (error as Error).message)
    }

    return {
      verdict: judged.verdict as Verdict,
      remaining: session.questionQuota > 0 ? Math.max(session.questionQuota - session.questionsUsed - 1, 0) : -1,
      duplicated: false,
    }
  }

  private questionRemaining(session: GameSession): number {
    if (session.questionQuota <= 0) return -1
    return Math.max(session.questionQuota - session.questionsUsed, 0)
  }

  private async consumeQuestion(session: GameSession): Promise<void> {
    const query: Record<string, unknown> = { id: session.id, status: 'running' }
    if (session.questionQuota > 0) query.questionsUsed = { $lt: session.questionQuota }
    const result = await this.ctx.database.set(TABLES.session, query, (row) => ({
      questionsUsed: $.add(row.questionsUsed, 1),
    }))
    if (!result.matched) throw new GameError('quota-question', { remaining: 0 })
  }

  // ------------------------------------------------------------------ 提交
  async guess(
    session: GameSession,
    userId: string,
    content: string,
  ): Promise<GuessOutcome> {
    if (session.status !== 'running') throw new GameError('not-running')

    const cooldownKey = `${session.id}:${userId}:g`
    this.checkCooldown(cooldownKey, this.config.guessCooldown)

    let quotaSource: 'personal' | 'public' = 'public'
    if (session.personalGuessQuota > 0) {
      const player = await this.ctx.database.get(TABLES.player, { sessionId: session.id, userId })
      if (!player.length) throw new GameError('not-joined')
      if (player[0].personalGuessUsed < session.personalGuessQuota) quotaSource = 'personal'
    }

    const publicExhausted = session.guessesUsed >= session.guessQuota
    if (quotaSource === 'public' && publicExhausted) {
      await this.settle(session.id, 'empty')
      throw new GameError('quota-guess', { settled: true })
    }

    let scored: ScoreResult
    try {
      scored = await this.ai.score(content, session.taleSnapshot.answer, session.taleSnapshot.keys ?? [])
    } catch (error) {
      throw this.aiError(error)
    }

    const threshold = Math.round(session.passThreshold * 100)
    const passed = scored.score >= threshold

    const consumed = await this.consumeGuess(session, userId, quotaSource)
    if (!consumed) {
      await this.settle(session.id, 'empty')
      throw new GameError('quota-guess', { settled: true })
    }
    this.touchCooldown(cooldownKey)

    try {
      await this.ctx.database.create(TABLES.guess, {
        sessionId: session.id,
        userId,
        content: content.slice(0, 1000),
        score: scored.score,
        points: scored.points,
        passed,
        quotaSource,
        model: scored.model,
        latencyMs: scored.latencyMs,
        createdAt: new Date(),
      })
    } catch (error) {
      this.logger.debug('提交落库失败：%s', (error as Error).message)
    }

    let settled = false
    if (passed) settled = await this.settle(session.id, 'win', userId)

    const players = await this.ctx.database.get(TABLES.player, { sessionId: session.id, userId })
    const personalUsed = players[0]?.personalGuessUsed ?? 0

    return {
      score: scored.score,
      passed,
      quotaSource,
      remainingPersonal: Math.max(session.personalGuessQuota - personalUsed, 0),
      remainingPublic: Math.max(session.guessQuota - session.guessesUsed - (quotaSource === 'public' ? 1 : 0), 0),
      detail: scored.points,
      settled,
    }
  }

  private async consumeGuess(session: GameSession, userId: string, source: 'personal' | 'public'): Promise<boolean> {
    if (source === 'personal') {
      const result = await this.ctx.database.set(
        TABLES.player,
        { sessionId: session.id, userId, personalGuessUsed: { $lt: session.personalGuessQuota } },
        (row) => ({ personalGuessUsed: $.add(row.personalGuessUsed, 1), guesses: $.add(row.guesses, 1) }),
      )
      if (result.matched) return true
    }

    const result = await this.ctx.database.set(
      TABLES.session,
      { id: session.id, status: 'running', guessesUsed: { $lt: session.guessQuota } },
      (row) => ({ guessesUsed: $.add(row.guessesUsed, 1) }),
    )
    if (!result.matched) return false

    if (source === 'personal') {
      await this.ctx.database.set(TABLES.player, { sessionId: session.id, userId }, (row) => ({
        personalGuessUsed: $.add(row.personalGuessUsed, 1),
        guesses: $.add(row.guesses, 1),
      }))
    }
    return true
  }

  // ------------------------------------------------------------------ 结算
  async settle(sessionId: number, reason: 'win' | 'empty' | 'manual' | 'timeout' | 'cancel', winnerId = ''): Promise<boolean> {
    const result = await this.ctx.database.set(
      TABLES.session,
      { id: sessionId, status: { $ne: 'settled' } },
      { status: 'settled', endReason: reason, winnerId, settledAt: new Date() },
    )
    if (!result.matched) return false

    this.clearTimers(sessionId)
    this.judged.delete(sessionId)
    return true
  }

  // ------------------------------------------------------------------ 版面
  async ensurePlan(tale: Tale): Promise<LayoutPlan> {
    const stored = tale.newspaper
    if (stored && (stored as LayoutPlan).title && (stored as LayoutPlan).body?.length) {
      return stored as LayoutPlan
    }
    if (this.config.layoutPlanMode === 'default' || !this.ai.available) return defaultPlan(tale)

    try {
      const plan = await this.ai.plan({
        title: tale.title,
        difficulty: tale.difficulty,
        tags: tale.tags ?? [],
        surface: tale.surface,
      })
      if (plan.title && plan.body?.length) {
        await this.ctx.database.set(TABLES.tale, tale.id, { newspaper: plan })
        return plan
      }
    } catch (error) {
      this.logger.warn('版面规划生成失败，使用默认版面：%s', (error as Error).message)
    }
    return defaultPlan(tale)
  }

  // ------------------------------------------------------------------ 工具
  private schedule(sessionId: number, delay: number, callback: () => unknown): void {
    const dispose = this.ctx.setTimeout(() => {
      Promise.resolve(callback()).catch((error) => this.logger.warn('定时任务失败：%s', (error as Error).message))
    }, delay)
    const list = this.timers.get(sessionId) ?? []
    list.push(dispose)
    this.timers.set(sessionId, list)
  }

  private clearTimers(sessionId: number): void {
    const list = this.timers.get(sessionId)
    if (!list) return
    for (const dispose of list) dispose()
    this.timers.delete(sessionId)
  }

  dispose(): void {
    for (const id of [...this.timers.keys()]) this.clearTimers(id)
    this.cooldowns.clear()
    this.judged.clear()
  }

  private checkCooldown(key: string, seconds: number): void {
    if (seconds <= 0) return
    const until = this.cooldowns.get(key) ?? 0
    if (Date.now() < until) {
      throw new GameError('cooldown', { seconds: Math.ceil((until - Date.now()) / 1000) })
    }
  }

  private touchCooldown(key: string): void {
    const seconds = key.endsWith(':q') ? this.config.questionCooldown : this.config.guessCooldown
    if (seconds > 0) this.cooldowns.set(key, Date.now() + seconds * 1000)
  }

  private aiError(error: unknown): GameError {
    if (error instanceof GameError) return error
    if (error instanceof AIError) {
      switch (error.code) {
        case 'not-configured': return new GameError('ai-unavailable', { reason: 'not-configured' })
        case 'quota': return new GameError('ai-unavailable', { reason: 'daily-limit' })
        case 'auth': return new GameError('ai-error', { reason: 'auth' })
        case 'model': return new GameError('ai-error', { reason: 'model' })
        case 'leak': return new GameError('ai-error', { reason: 'leak' })
        default: return new GameError('ai-error', { reason: 'unreachable' })
      }
    }
    this.logger.warn('AI 调用异常：%s', (error as Error)?.message)
    return new GameError('ai-error', { reason: 'unreachable' })
  }
}
