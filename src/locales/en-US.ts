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
  aiUnreachable: 'The host is not responding. Please ask again later (this attempt was not counted).',
  aiAborted: 'The AI host is unreachable ({0}), so this round is over.\n—— Answer ——\n{1}',
  aiEmptyGuess: 'Write down your theory, e.g. "海龟汤 提交 she never died".',
  unknownError: 'Something went wrong. This action did not complete.',
  settleWin: '🎉 {0} solved it!',
  bindSuccess: 'Bound. You are now this bot\'s master.',
  bindFailed: 'Invalid or expired code.',
}

export default {
  ...zhCN,
  'situation-puzzle': messages,
}
