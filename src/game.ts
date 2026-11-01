import { $, Context, Logger, Session } from 'koishi'
import type { AIClient, ScoreResult } from './ai'
import { AIError } from './ai'
import type { Config } from './config'
import { TABLES } from './db'
import { planLeaksAnswer } from './render'
import type { LayoutPlan, Tale, TaleSnapshot, GameSession, Verdict } from './types'
import { normalizeQuestion, looksLikeChitchat, looksLikeAnswerProbe, tooShortToJudge } from './util'

export type GameErrorCode =
  | 'busy'
  | 'no-session'
  | 'not-running'
  | 'not-joining'
  | 'no-room'
  | 'not-joined'
  | 'full'
  | 'already-joined'
  | 'quota-question'
  | 'quota-guess'
  | 'ai-busy'
  | 'chitchat'
  | 'answer-probe'
  | 'guess-too-short'
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
  /** 本场提交次数就此用尽并已结算：调用方要补发汤底 */
  exhausted: boolean
}

export interface OpenRules {
  questionQuota: number
  guessQuota: number
  personalGuessQuota: number
  passThreshold: number
  maxDuration: number
  joinWindow: number
  idleTimeout: number
}

type TimerKind = 'join' | 'duration' | 'idle'

export class Game {
  private timers = new Map<number, Array<{ kind: TimerKind; dispose: () => void }>>()
  private cooldowns = new Map<string, number>()
  private judged = new Map<number, Map<string, Verdict>>()
  /** 每个频道最近一次会话：定时器（超时/流局）要靠它把结果播出去 */
  private senders = new Map<string, Session>()
  /** 开局串行化：先查后建之间有空档，两个并发开局会同时建出两场 */
  private queue = new Map<string, Promise<unknown>>()
  /** 同一个人还在等判定的请求：防止连发把配额和模型都压满 */
  private pending = new Set<string>()

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

  /** 记下频道里最近一个会话，供定时任务回话 */
  remember(session: Session): void {
    if (!session.channelId) return
    const key = channelKeyOf(session)
    this.senders.set(key, session)
    if (this.senders.size > 200) {
      const oldest = this.senders.keys().next().value
      if (oldest) this.senders.delete(oldest)
    }
  }

  // ------------------------------------------------------------------ 开局
  async open(channelKey: string, tale: Tale, openerId: string, guildId: string, rules: OpenRules): Promise<GameSession> {
    return this.withLock(channelKey, async () => {
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
        joinWindow: rules.joinWindow,
        idleTimeout: rules.idleTimeout,
        startedAt: now,
        lastActiveAt: now,
        settledAt: new Date(0),
      })

      await this.ctx.database.set(TABLES.tale, tale.id, (row2) => ({
        playedCount: $.add(row2.playedCount, 1),
      }))

      if (joining) {
        this.schedule(row.id, 'join', rules.joinWindow * 1000, () => this.finishJoining(row.id))
      } else {
        this.startClock(row)
      }

      return row
    })
  }

  /**
   * 开打：把「时长」和「空闲」两个钟挂上。
   * 时长从**开打**算，不含集结窗口——集结可以等，开局后没人玩才是真问题。
   */
  private startClock(row: GameSession): void {
    if (row.maxDuration > 0) {
      this.schedule(row.id, 'duration', row.maxDuration * 1000, () => this.expire(row.id))
    }
    this.resetIdleTimer(row)
  }

  /**
   * 空闲计时：每次有效动作（提问/提交/加入/发车）重置。
   * 这是「开局后没人说话」的兜底——时长不设限时也不会永远挂着。
   */
  private resetIdleTimer(row: { id: number; idleTimeout: number }): void {
    this.clearTimers(row.id, 'idle')
    const seconds = row.idleTimeout || this.config.idleTimeout
    if (seconds <= 0) return
    this.schedule(row.id, 'idle', seconds * 1000, () => this.expireIdle(row.id))
  }

  private async expireIdle(sessionId: number): Promise<void> {
    const [row] = await this.ctx.database.get(TABLES.session, sessionId)
    if (!row || row.status !== 'running') return
    const seconds = row.idleTimeout || this.config.idleTimeout
    if (seconds <= 0) return

    // 定时器可能比最后一次动作早触发（重置失败/时钟漂移），以库里的 lastActiveAt 为准
    const last = new Date(row.lastActiveAt || row.startedAt).getTime()
    const remaining = last + seconds * 1000 - Date.now()
    if (remaining > 1000) {
      this.schedule(sessionId, 'idle', remaining, () => this.expireIdle(sessionId))
      return
    }
    await this.closeIdle(row, seconds)
  }

  private async closeIdle(row: GameSession, seconds: number): Promise<void> {
    const settled = await this.settle(row.id, 'idle')
    if (!settled) return
    await this.notify(row.channelKey, this.text('settleIdle', [String(Math.max(1, Math.round(seconds / 60)))]))
    await this.notify(row.channelKey, this.answerText(row.taleSnapshot.answer))
  }

  /** 记一次有效动作：刷新 lastActiveAt 与空闲计时 */
  private async touch(session: GameSession): Promise<void> {
    const now = new Date()
    try {
      await this.ctx.database.set(TABLES.session, session.id, { lastActiveAt: now })
    } catch (error) {
      this.logger.debug('刷新活跃时间失败：%s', (error as Error).message)
    }
    session.lastActiveAt = now
    // 集结阶段还没有空闲钟，等开打时统一挂
    if (session.status === 'running') {
      this.resetIdleTimer({ id: session.id, idleTimeout: session.idleTimeout })
    }
  }

  /**
   * 巡检：不依赖内存定时器，按库里的状态把该收的场次收掉。
   * 进程重启 / 热重载后定时器全丢，这里就是兜底；正常运行时每 5 分钟一次。
   */
  async sweep(): Promise<number> {
    let closed = 0
    let rows: GameSession[] = []
    try {
      rows = await this.ctx.database.get(TABLES.session, {
        status: { $in: ['joining', 'running'] },
      } as any)
    } catch (error) {
      this.logger.debug('巡检读取场次失败：%s', (error as Error).message)
      return 0
    }

    for (const row of rows) {
      try {
        const startedAt = new Date(row.startedAt).getTime()
        if (row.status === 'joining') {
          const window = (row.joinWindow || this.config.joinWindow) * 1000
          if (Date.now() - startedAt >= window) {
            await this.finishJoining(row.id)
            closed++
          }
          continue
        }

        const duration = row.maxDuration * 1000
        if (duration > 0 && Date.now() - startedAt >= duration) {
          await this.expire(row.id)
          closed++
          continue
        }

        const idle = (row.idleTimeout || this.config.idleTimeout) * 1000
        if (idle > 0) {
          const last = new Date(row.lastActiveAt || row.startedAt).getTime()
          if (Date.now() - last >= idle) {
            await this.closeIdle(row, idle / 1000)
            closed++
          }
        }
      } catch (error) {
        this.logger.warn('巡检场次 %d 失败：%s', row.id, (error as Error).message)
      }
    }
    if (closed) this.logger.info('巡检收场 %d 个超时/无人的场次', closed)
    return closed
  }

  // ------------------------------------------------------------------ 加入
  async join(session: GameSession, userId: string): Promise<{ joined: number; max: number }> {
    // 非房间模式本来就不用加入，别让玩家看到「本场已结束」这种吓人的话
    if (session.personalGuessQuota <= 0) throw new GameError('no-room')
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

    await this.touch(session)
    return { joined: players.length + 1, max: this.config.maxPlayers }
  }

  private async finishJoining(sessionId: number): Promise<void> {
    const [row] = await this.ctx.database.get(TABLES.session, sessionId)
    if (!row || row.status !== 'joining') return

    const players = await this.ctx.database.get(TABLES.player, { sessionId })
    if (!players.length) {
      const settled = await this.settle(sessionId, 'cancel')
      if (settled) await this.notify(row.channelKey, this.text('settleCancel'))
      return
    }
    await this.beginRunning(row)
  }

  /** 集结 → 开打：重置计时基准，挂上时长与空闲两个钟 */
  private async beginRunning(row: GameSession): Promise<void> {
    const now = new Date()
    const result = await this.ctx.database.set(
      TABLES.session,
      { id: row.id, status: 'joining' },
      { status: 'running', startedAt: now, lastActiveAt: now },
    )
    if (!result.matched) return
    this.clearTimers(row.id, 'join')
    row.status = 'running'
    row.startedAt = now
    row.lastActiveAt = now
    this.startClock(row)
  }

  /** 发起人在窗口内提前开始 */
  async startEarly(session: GameSession): Promise<void> {
    if (session.status !== 'joining') throw new GameError('not-running')
    const players = await this.ctx.database.get(TABLES.player, { sessionId: session.id })
    if (!players.length) throw new GameError('not-joined')
    await this.beginRunning(session)
  }

  /** 超时结束：结算 + 公布汤底，不能悄无声息地收场 */
  private async expire(sessionId: number): Promise<void> {
    const [row] = await this.ctx.database.get(TABLES.session, sessionId)
    if (!row) return
    const settled = await this.settle(sessionId, 'timeout')
    if (!settled) return
    await this.notify(row.channelKey, this.text('settleTimeout'))
    await this.notify(row.channelKey, this.answerText(row.taleSnapshot.answer))
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

    // 下面三种在本地就挡掉：不调模型、不扣次数、不给套话留任何机会
    if (looksLikeAnswerProbe(normalized)) throw new GameError('answer-probe')
    if (looksLikeChitchat(normalized)) throw new GameError('chitchat')

    const cache = this.judged.get(session.id) ?? new Map<string, Verdict>()
    this.judged.set(session.id, cache)
    const cachedVerdict = cache.get(normalized)
    if (cachedVerdict) {
      await this.touch(session)
      return { verdict: cachedVerdict, remaining: this.questionRemaining(session), duplicated: true }
    }

    if (session.questionQuota > 0 && session.questionsUsed >= session.questionQuota) {
      throw new GameError('quota-question', { remaining: this.guessRemaining(session) })
    }

    // 同一个人连发两次：第二次直接劝回，别让两条请求同时压在模型上
    const lockKey = `${session.id}:${userId}:q`
    if (this.pending.has(lockKey)) throw new GameError('ai-busy')
    this.pending.add(lockKey)

    let judged
    try {
      const history = this.config.includeHistory ? await this.recentVerdicts(session.id) : []
      judged = await this.ai.judge(question, session.taleSnapshot.answer, history)
    } catch (error) {
      throw await this.aiFailure(session, error)
    } finally {
      this.pending.delete(lockKey)
    }

    if (!this.config.allowPartialAnswer && judged.verdict === 'partial') {
      judged.verdict = 'irrelevant'
    }

    await this.consumeQuestion(session)
    cache.set(normalized, judged.verdict as Verdict)
    this.touchCooldown(cooldownKey)
    await this.touch(session)

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

  /** 已确认的判词：开了 includeHistory 才用，喂给模型保持前后一致 */
  private async recentVerdicts(sessionId: number): Promise<Array<{ q: string; v: string }>> {
    try {
      const rows = await this.ctx.database.get(TABLES.question, { sessionId })
      return rows
        .filter((row) => ['yes', 'no', 'irrelevant', 'partial'].includes(row.verdict))
        .slice(-12)
        .map((row) => ({ q: row.content.slice(0, 80), v: row.verdict }))
    } catch {
      return []
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
    if (result.matched) return

    // 没扣上：可能这期间场次已经被别人结算了（不是配额问题）
    const [row] = await this.ctx.database.get(TABLES.session, session.id)
    if (!row || row.status !== 'running') throw new GameError('no-session')
    throw new GameError('quota-question', { remaining: this.guessRemaining(row) })
  }

  /** 「提问用完了但还能提交几次」——提示语里的数字，不能永远写 0 */
  private guessRemaining(session: GameSession): number {
    return Math.max(session.guessQuota - session.guessesUsed, 0)
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

    // 太短 / 纯语气词：判不出东西，还白扣一次提交
    if (tooShortToJudge(content) || looksLikeChitchat(content)) throw new GameError('guess-too-short')

    let quotaSource: 'personal' | 'public' = 'public'
    if (session.personalGuessQuota > 0) {
      const player = await this.ctx.database.get(TABLES.player, { sessionId: session.id, userId })
      if (!player.length) throw new GameError('not-joined')
      if (player[0].personalGuessUsed < session.personalGuessQuota) quotaSource = 'personal'
    }

    const publicExhausted = session.guessesUsed >= session.guessQuota
    if (quotaSource === 'public' && publicExhausted) {
      throw new GameError('quota-guess', { settled: false })
    }

    const lockKey = `${session.id}:${userId}:g`
    if (this.pending.has(lockKey)) throw new GameError('ai-busy')
    this.pending.add(lockKey)

    let scored: ScoreResult
    try {
      scored = await this.ai.score(content, session.taleSnapshot.answer, session.taleSnapshot.keys ?? [])
    } catch (error) {
      throw await this.aiFailure(session, error)
    } finally {
      this.pending.delete(lockKey)
    }

    const threshold = Math.round(session.passThreshold * 100)
    const passed = scored.score >= threshold

    const consumed = await this.consumeGuess(session, userId, quotaSource)
    if (!consumed) {
      const [fresh] = await this.ctx.database.get(TABLES.session, session.id)
      if (!fresh || fresh.status !== 'running') throw new GameError('no-session')
      throw new GameError('quota-guess', { settled: false })
    }
    this.touchCooldown(cooldownKey)
    await this.touch(session)

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

    const players = await this.ctx.database.get(TABLES.player, { sessionId: session.id, userId })
    const personalUsed = players[0]?.personalGuessUsed ?? 0
    const remainingPersonal = Math.max(session.personalGuessQuota - personalUsed, 0)
    const remainingPublic = Math.max(session.guessQuota - session.guessesUsed - (quotaSource === 'public' ? 1 : 0), 0)

    let settled = false
    if (passed) settled = await this.settle(session.id, 'win', userId)

    // 最后一次提交也没中：当场收场并公布汤底，别让场次挂在那里没人管
    const exhausted = !passed && remainingPersonal <= 0 && remainingPublic <= 0
    if (exhausted) settled = (await this.settle(session.id, 'empty')) || settled

    return {
      score: scored.score,
      passed,
      quotaSource,
      remainingPersonal,
      remainingPublic,
      detail: scored.points,
      settled,
      exhausted,
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

  /** 本场实际参与人数：发起人、加入过、提问过、提交过都算 */
  async participants(sessionId: number): Promise<number> {
    const users = new Set<string>()
    try {
      const [sessions, players, asked, guessed] = await Promise.all([
        this.ctx.database.get(TABLES.session, sessionId),
        this.ctx.database.get(TABLES.player, { sessionId }),
        this.ctx.database.get(TABLES.question, { sessionId }),
        this.ctx.database.get(TABLES.guess, { sessionId }),
      ])
      if (sessions[0]?.openerId) users.add(sessions[0].openerId)
      for (const row of players) users.add(row.userId)
      for (const row of asked) users.add(row.userId)
      for (const row of guessed) users.add(row.userId)
    } catch (error) {
      this.logger.debug('参与人数统计失败：%s', (error as Error).message)
    }
    return Math.max(users.size, 1)
  }

  // ------------------------------------------------------------------ 结算
  async settle(
    sessionId: number,
    reason: 'win' | 'empty' | 'manual' | 'timeout' | 'cancel' | 'error' | 'idle',
    winnerId = '',
  ): Promise<boolean> {
    const result = await this.ctx.database.set(
      TABLES.session,
      { id: sessionId, status: { $ne: 'settled' } },
      { status: 'settled', endReason: reason, winnerId, settledAt: new Date() },
    )
    if (!result.matched) return false

    this.clearTimers(sessionId)
    this.judged.delete(sessionId)
    // 冷却和判词缓存都以场次 id 为前缀，不跟着清会一直留在内存里
    for (const key of [...this.cooldowns.keys()]) {
      if (key.startsWith(`${sessionId}:`)) this.cooldowns.delete(key)
    }
    return true
  }

  /**
   * AI 判定失败时的统一出口。
   * 默认直接收场（AI 连不上，这锅汤本来也进行不下去），并把汤底告诉玩家；
   * 关掉 abortOnAiFailure 则退回「本次不计次数，请重试」。
   */
  private async aiFailure(session: GameSession, error: unknown): Promise<GameError> {
    const mapped = this.aiError(error)
    if (!this.config.abortOnAiFailure) return mapped

    const reason = String(mapped.data?.reason || 'unreachable')
    const settled = await this.settle(session.id, 'error')
    if (!settled) {
      // 等判定的这段时间里场次已经被别人打完了：报「AI 挂了」会误导
      const [row] = await this.ctx.database.get(TABLES.session, session.id)
      if (!row || row.status !== 'running') return new GameError('no-session')
    }
    this.logger.warn('AI 不可用（%s），场次 %d %s', reason, session.id, settled ? '已终止' : '已结束')
    return new GameError(mapped.code, {
      ...mapped.data,
      reason,
      aborted: settled,
      answer: session.taleSnapshot.answer,
      title: session.taleSnapshot.title,
    })
  }

  // ------------------------------------------------------------------ 版面
  async ensurePlan(tale: Tale): Promise<LayoutPlan> {
    const stored = tale.newspaper
    const maxAge = this.config.layoutPlanMaxAge
    const fresh = maxAge > 0
      ? !stored?.generatedAt || Date.now() - stored.generatedAt < maxAge * 86400000
      : true

    if (stored && (stored as LayoutPlan).title && (stored as LayoutPlan).body?.length && fresh) {
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
        // 引题/副题是模型写的，必须挡一道「有没有把汤底说出去」
        if (planLeaksAnswer(plan, tale.answer)) {
          this.logger.warn('版面规划疑似泄底，已改用默认版面：%s', tale.title)
          return defaultPlan(tale)
        }
        plan.generatedAt = Date.now()
        await this.ctx.database.set(TABLES.tale, tale.id, { newspaper: plan })
        return plan
      }
    } catch (error) {
      this.logger.warn('版面规划生成失败，使用默认版面：%s', (error as Error).message)
    }
    return defaultPlan(tale)
  }

  // ------------------------------------------------------------------ 工具
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queue.get(key) ?? Promise.resolve()
    const run = previous.then(() => fn(), () => fn())
    const tail = run.then(() => undefined, () => undefined)
    this.queue.set(key, tail)
    tail.then(() => {
      if (this.queue.get(key) === tail) this.queue.delete(key)
    })
    return run
  }

  private schedule(sessionId: number, kind: TimerKind, delay: number, callback: () => unknown): void {
    const dispose = this.ctx.setTimeout(() => {
      Promise.resolve(callback()).catch((error) => this.logger.warn('定时任务失败：%s', (error as Error).message))
    }, delay)
    const list = this.timers.get(sessionId) ?? []
    list.push({ kind, dispose })
    this.timers.set(sessionId, list)
  }

  private clearTimers(sessionId: number, kind?: TimerKind): void {
    const list = this.timers.get(sessionId)
    if (!list) return
    const keep: Array<{ kind: TimerKind; dispose: () => void }> = []
    for (const item of list) {
      if (kind && item.kind !== kind) {
        keep.push(item)
        continue
      }
      item.dispose()
    }
    if (keep.length) this.timers.set(sessionId, keep)
    else this.timers.delete(sessionId)
  }

  dispose(): void {
    for (const id of [...this.timers.keys()]) this.clearTimers(id)
    this.cooldowns.clear()
    this.judged.clear()
    this.senders.clear()
    this.queue.clear()
    this.pending.clear()
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

  private text(key: string, params: string[] = []): string {
    return this.ctx.i18n.text([], [`situation-puzzle.${key}`], params as any)
  }

  private answerText(answer: string): string {
    return `${this.text('answerTitle')}\n${answer}`
  }

  /** 定时任务里没有 session，用频道最近一次会话发；发不出去只记 debug */
  private async notify(channelKey: string, text: string): Promise<void> {
    const session = this.senders.get(channelKey)
    try {
      if (session) return void (await session.send(text))
      const platform = channelKey.slice(0, channelKey.indexOf(':'))
      const channelId = channelKey.slice(channelKey.indexOf(':') + 1)
      const bot = (this.ctx.bots as any).find?.((item: any) => item.platform === platform)
      if (bot) await bot.sendMessage(channelId, text)
    } catch (error) {
      this.logger.debug('场次通知发送失败：%s', (error as Error).message)
    }
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
        case 'timeout': return new GameError('ai-error', { reason: 'timeout' })
        default: return new GameError('ai-error', { reason: 'unreachable' })
      }
    }
    this.logger.warn('AI 调用异常：%s', (error as Error)?.message)
    return new GameError('ai-error', { reason: 'unreachable' })
  }
}
