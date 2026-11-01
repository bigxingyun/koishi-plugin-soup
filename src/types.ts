import type { Accent } from './config'

export type Difficulty = 'easy' | 'normal' | 'hard'
export type SessionStatus = 'joining' | 'running' | 'settled'
export type EndReason = 'win' | 'empty' | 'manual' | 'timeout' | 'cancel'
export type Verdict = 'yes' | 'no' | 'irrelevant' | 'partial'
export type RenderKind = 'image' | 'text'

export interface TaleKey {
  id: number
  text: string
  weight: number
}

/** 报纸版面规划：AI 只产这个结构，排版由代码计算 */
export interface LayoutPlan {
  version?: number
  masthead?: { name?: string; en?: string }
  issue?: number
  pages?: number
  date?: string
  difficulty?: string
  tags?: string[]
  kicker?: string
  title?: string
  deck?: string
  body?: string[]
  style?: {
    columns?: 1 | 2
    fontPx?: number
    lineHeight?: number
    dropCap?: boolean
    accent?: Accent
    grain?: number
  }
  stamp?: { text?: string; angle?: number; opacity?: number }
  byline?: string
  dateline?: string
  notice?: { title?: string; lines?: string[] }
  howto?: { title?: string; lines?: string[] }
  footer?: { left?: string; right?: string }
}

/** 场次持有汤的快照，避免汤被改动后历史回放错乱 */
export interface TaleSnapshot {
  taleId: string
  title: string
  difficulty: Difficulty
  surface: string
  answer: string
  keys: TaleKey[]
}

export interface Tale {
  id: number
  taleId: string
  title: string
  difficulty: Difficulty
  surface: string
  answer: string
  keys: TaleKey[]
  tags: string[]
  author: string
  enabled: boolean
  playedCount: number
  checksum: string
  version: number
  source: string
  newspaper: LayoutPlan
  createdAt: Date
  updatedAt: Date
}

export interface GameSession {
  id: number
  channelKey: string
  platform: string
  channelId: string
  guildId: string
  taleRowId: number
  taleSnapshot: TaleSnapshot
  status: SessionStatus
  endReason: string
  renderMode: RenderKind
  openerId: string
  winnerId: string
  questionQuota: number
  questionsUsed: number
  guessQuota: number
  guessesUsed: number
  personalGuessQuota: number
  passThreshold: number
  maxDuration: number
  startedAt: Date
  settledAt: Date
}

export interface Player {
  id: number
  sessionId: number
  userId: string
  personalGuessUsed: number
  guesses: number
  joinedAt: Date
}

export interface Question {
  id: number
  sessionId: number
  userId: string
  content: string
  verdict: Verdict | 'error'
  cached: boolean
  model: string
  latencyMs: number
  createdAt: Date
}

export interface Guess {
  id: number
  sessionId: number
  userId: string
  content: string
  score: number
  points: any
  passed: boolean
  quotaSource: 'personal' | 'public'
  model: string
  latencyMs: number
  createdAt: Date
}

export interface Master {
  id: number
  platform: string
  selfId: string
  userId: string
  createdAt: Date
}

export interface Override {
  id: number
  channelKey: string
  field: string
  value: string
  updatedAt: Date
}

declare module 'koishi' {
  interface Tables {
    situation_puzzle_tale: Tale
    situation_puzzle_session: GameSession
    situation_puzzle_player: Player
    situation_puzzle_question: Question
    situation_puzzle_guess: Guess
    situation_puzzle_master: Master
    situation_puzzle_override: Override
  }
}
