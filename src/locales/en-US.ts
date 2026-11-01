import zhCN from './zh-CN'

/**
 * en-US 目前只覆盖「最先看到的那几句话」——指令描述、判词、配额提示。
 * 其余文案原样继承 zh-CN，保证不会出现空串或 key 泄漏。
 */
const messages = {
  ...zhCN['situation-puzzle'],
  noSession: 'No puzzle is running here. Send "海龟汤 开局" to start one.',
  verdictYes: 'Yes',
  verdictNo: 'No',
  verdictIrrelevant: 'Irrelevant',
  verdictPartial: 'Yes and no',
  quotaQuestion: 'You are out of questions for this round.',
  quotaGuess: 'You are out of guesses.',
  cooldown: 'Please wait {0}s.',
  noPermission: 'You do not have permission to do that.',
  aiNotConfigured: 'AI is not configured yet. Please ask the admin for an apiKey.',
  aiUnreachable: 'The host is away. Please try again (this attempt was not counted).',
  bindSuccess: 'Bound. You are now this bot\'s master.',
  bindFailed: 'Invalid or expired code.',
}

export default {
  ...zhCN,
  'situation-puzzle': messages,
}
