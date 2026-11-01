import { Context } from 'koishi'
import { TABLES } from './db'
import type { Master } from './types'

interface Pending {
  code: string
  expires: number
}

export type PendingMap = Map<string, Pending>

export function pendingKey(platform: string, selfId: string, userId: string): string {
  return `${platform}:${selfId}:${userId}`
}

export function issueCode(pending: PendingMap, key: string, ttlSeconds: number): string {
  const code = String(Math.floor(100000 + Math.random() * 900000))
  pending.set(key, { code, expires: Date.now() + ttlSeconds * 1000 })
  // 顺手清理过期项，避免内存长期增长
  for (const [k, v] of pending) {
    if (v.expires < Date.now()) pending.delete(k)
  }
  return code
}

export function consumeCode(pending: PendingMap, key: string, code: string): boolean {
  const entry = pending.get(key)
  if (!entry) return false
  if (entry.expires < Date.now()) {
    pending.delete(key)
    return false
  }
  if (entry.code !== code.trim()) return false
  pending.delete(key)
  return true
}

export async function getMaster(ctx: Context, platform: string, selfId: string): Promise<Master | undefined> {
  const rows = await ctx.database.get(TABLES.master, { platform, selfId })
  return rows[0]
}

export async function isMaster(ctx: Context, platform: string, selfId: string, userId: string): Promise<boolean> {
  const master = await getMaster(ctx, platform, selfId)
  return !!master && master.userId === userId
}

export async function bindMaster(
  ctx: Context,
  platform: string,
  selfId: string,
  userId: string,
): Promise<boolean> {
  const existing = await getMaster(ctx, platform, selfId)
  if (existing) return false
  await ctx.database.create(TABLES.master, {
    platform,
    selfId,
    userId,
    createdAt: new Date(),
  })
  return true
}

export async function unbindMaster(ctx: Context, platform: string, selfId: string): Promise<void> {
  await ctx.database.remove(TABLES.master, { platform, selfId })
}
