import { createHash } from 'node:crypto'

export function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex')
}

export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

export function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

/** 半角化 + 去控制字符 + 压缩空白：用于判词缓存与相似度去重 */
export function normalizeText(input: string): string {
  return String(input)
    .replace(/[\u3000]/g, ' ')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 去掉首尾标点后作为缓存键 */
export function normalizeQuestion(input: string): string {
  return normalizeText(input).replace(/^[\s,.;:!?'"()[\]{}<>~-]+|[\s,.;:!?'"()[\]{}<>~-]+$/g, '')
}

const TAG_CLEANUP: Array<[RegExp, string]> = [
  [/<\s*br\s*\/?>/gi, '\n'],
  [/<\s*\/\s*(p|div|section|li|tr)\s*>/gi, '\n'],
  [/<\s*(b|strong)\s*>/gi, '**'],
  [/<\s*\/\s*(b|strong)\s*>/gi, '**'],
  [/<\s*(i|em)\s*>/gi, '*'],
  [/<\s*\/\s*(i|em)\s*>/gi, '*'],
]

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&mdash;': '—',
  '&hellip;': '…',
}

/**
 * 汤面清洗：把 HTML / 代码围栏 / 多余空行清成可渲染的纯文本。
 * 顺序很重要——先做标签映射，再剥剩余标签，最后解码实体。
 */
export function cleanSurface(raw: string): string {
  let text = String(raw)

  // 代码围栏整段保留内容，只去掉围栏本身
  text = text.replace(/^[ \t]*(?:```|~~~)[^\n]*$/gm, '')

  for (const [pattern, replacement] of TAG_CLEANUP) text = text.replace(pattern, replacement)

  // 剥离剩余标签（含 style/script 的内容一起丢掉）
  text = text.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
  text = text.replace(/<\/?[a-z][^>]*>/gi, '')

  for (const [entity, char] of Object.entries(ENTITIES)) {
    text = text.split(entity).join(char)
  }
  text = text.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const CHITCHAT = /^(?:哈|呵|嘿|嘻|嗯|哦|噢|额|啊|草|笑死|555|6+|牛|强|nb|666|\+1|同上|打卡|签到|在吗|有人吗)+$/i

/**
 * 纯语气词 / 复读 / 纯符号：不是提问。
 * 判定必须「整串都由这些构成」，否则「他死了吗」会被误伤。
 */
export function looksLikeChitchat(input: string): boolean {
  const text = normalizeText(input).replace(/[\s,，.!！?？~～。…、:：;；"'“”]+/g, '')
  if (!text) return true
  return CHITCHAT.test(text)
}

const PROBE_PATTERNS: RegExp[] = [
  /(告诉|说|讲|给|发|输出|透露|写).{0,6}(汤底|答案|真相)/,
  /(汤底|答案|真相).{0,3}(是什么|是啥|是啥呀|多少|给我)/,
  /忽略.{0,8}(以上|之前|前面|要求|规则|设定)/,
  /(开发者|dan|god)\s*模式|system\s*prompt|系统提示词|jailbreak|越狱/i,
  /(直接|快点|赶紧|马上).{0,4}(说|给|报|念)/,
]

/**
 * 冲着汤底来的（"直接告诉我答案""忽略以上要求"）。
 * 这类请求本地就挡掉：不调模型、不扣次数、也不给它任何"套话"的机会。
 */
export function looksLikeAnswerProbe(input: string): boolean {
  const text = normalizeText(input)
  if (!text) return false
  return PROBE_PATTERNS.some((pattern) => pattern.test(text))
}

/** 提交是否短到判不了（"？""哈哈""不知道"之外的两三字） */
export function tooShortToJudge(input: string, minLength = 3): boolean {
  const text = normalizeText(input).replace(/[\s,，.!！?？~～。…、:：;；]+/g, '')
  return text.length < minLength
}

/** 汤面是否泄露汤底：找长度 ≥ minLength 的公共子串 */
export function findLeak(surface: string, answer: string, minLength = 12): string | null {
  const a = normalizeText(answer).replace(/\s+/g, '')
  const s = normalizeText(surface).replace(/\s+/g, '')
  if (a.length < minLength || s.length < minLength) return null

  const window = new Set<string>()
  for (let i = 0; i + minLength <= a.length; i++) window.add(a.slice(i, i + minLength))
  for (let i = 0; i + minLength <= s.length; i++) {
    const piece = s.slice(i, i + minLength)
    if (window.has(piece)) return piece
  }
  return null
}

/** 按最大长度切段，尽量落在换行或句号处 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > maxLength) {
    let cut = -1
    for (const mark of ['\n\n', '\n', '。', '！', '？', '. ', ' ']) {
      const index = rest.lastIndexOf(mark, maxLength)
      if (index > maxLength * 0.4) {
        cut = index + mark.length
        break
      }
    }
    if (cut < 0) cut = maxLength
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
}
