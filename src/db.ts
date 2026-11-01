import { Context } from 'koishi'

/** 所有表都必须带前缀，避免与其他插件的表名冲突 */
export const TABLES = {
  tale: 'situation_puzzle_tale',
  session: 'situation_puzzle_session',
  player: 'situation_puzzle_player',
  question: 'situation_puzzle_question',
  guess: 'situation_puzzle_guess',
  master: 'situation_puzzle_master',
  override: 'situation_puzzle_override',
} as const

export function setupModel(ctx: Context) {
  ctx.model.extend(TABLES.tale, {
    id: 'unsigned',
    taleId: 'string',
    title: 'string',
    difficulty: 'string',
    surface: 'text',
    answer: 'text',
    keys: 'json',
    tags: 'list',
    author: 'string',
    enabled: 'boolean',
    playedCount: 'unsigned',
    checksum: 'string',
    version: 'unsigned',
    source: 'string',
    newspaper: 'json',
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  }, {
    primary: 'id',
    autoInc: true,
    unique: [['taleId']],
  })

  ctx.model.extend(TABLES.session, {
    id: 'unsigned',
    channelKey: 'string',
    platform: 'string',
    channelId: 'string',
    guildId: 'string',
    taleRowId: 'unsigned',
    taleSnapshot: 'json',
    status: 'string',
    endReason: 'string',
    renderMode: 'string',
    openerId: 'string',
    winnerId: 'string',
    questionQuota: 'integer',
    questionsUsed: 'unsigned',
    guessQuota: 'integer',
    guessesUsed: 'unsigned',
    personalGuessQuota: 'unsigned',
    passThreshold: 'float',
    maxDuration: 'unsigned',
    joinWindow: 'unsigned',
    idleTimeout: 'unsigned',
    startedAt: 'timestamp',
    lastActiveAt: 'timestamp',
    settledAt: 'timestamp',
  }, {
    primary: 'id',
    autoInc: true,
    indexes: [['channelKey', 'status'], ['settledAt']],
  })

  ctx.model.extend(TABLES.player, {
    id: 'unsigned',
    sessionId: 'unsigned',
    userId: 'string',
    personalGuessUsed: 'unsigned',
    guesses: 'unsigned',
    joinedAt: 'timestamp',
  }, {
    primary: 'id',
    autoInc: true,
    unique: [['sessionId', 'userId']],
  })

  ctx.model.extend(TABLES.question, {
    id: 'unsigned',
    sessionId: 'unsigned',
    userId: 'string',
    content: 'text',
    verdict: 'string',
    cached: 'boolean',
    model: 'string',
    latencyMs: 'unsigned',
    createdAt: 'timestamp',
  }, {
    primary: 'id',
    autoInc: true,
    indexes: [['sessionId']],
  })

  ctx.model.extend(TABLES.guess, {
    id: 'unsigned',
    sessionId: 'unsigned',
    userId: 'string',
    content: 'text',
    score: 'unsigned',
    points: 'json',
    passed: 'boolean',
    quotaSource: 'string',
    model: 'string',
    latencyMs: 'unsigned',
    createdAt: 'timestamp',
  }, {
    primary: 'id',
    autoInc: true,
    indexes: [['sessionId']],
  })

  ctx.model.extend(TABLES.master, {
    id: 'unsigned',
    platform: 'string',
    selfId: 'string',
    userId: 'string',
    createdAt: 'timestamp',
  }, {
    primary: 'id',
    autoInc: true,
    unique: [['platform', 'selfId']],
  })

  ctx.model.extend(TABLES.override, {
    id: 'unsigned',
    channelKey: 'string',
    field: 'string',
    value: 'string',
    updatedAt: 'timestamp',
  }, {
    primary: 'id',
    autoInc: true,
    unique: [['channelKey', 'field']],
  })
}
