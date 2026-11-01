import { Schema } from 'koishi'

export const name = 'soup'

export type RenderMode = 'image-first' | 'text'
export type RenderBackend = 'auto' | 'puppeteer' | 'text'
export type RenderTheme = 'newspaper' | 'plain'
export type RenderFormat = 'jpg' | 'png' | 'webp'
export type LayoutPlanMode = 'ai' | 'default'
export type Accent = 'rust' | 'blood' | 'ink' | 'steel'

export interface Config {
  // ---- 基础
  maxMessageLength: number
  answeringHint: boolean
  verdictWithAt: boolean
  verdictWithQuota: boolean
  historyRetentionDays: number

  // ---- 玩法
  defaultQuestionQuota: number
  defaultGuessQuota: number
  personalGuessQuota: number
  joinWindow: number
  maxPlayers: number
  passThreshold: number
  maxDuration: number
  questionCooldown: number
  guessCooldown: number
  allowPartialAnswer: boolean
  showScoreDetail: boolean
  hostCanEnd: boolean

  // ---- AI
  baseURL: string
  apiKey: string
  model: string
  thinkingMode: boolean
  reasoningEffort: 'low' | 'high' | 'max'
  temperature: number
  timeout: number
  maxRetries: number
  dailyCallLimit: number
  modelCheck: boolean
  includeHistory: boolean

  // ---- 汤库
  talesDir: string
  autoImport: boolean
  autoEnable: boolean
  seedBundled: boolean
  ignoreLeakWarning: boolean

  // ---- 主人
  masterAuthTTL: number

  // ---- 渲染
  renderMode: RenderMode
  renderBackend: RenderBackend
  renderTheme: RenderTheme
  renderWidth: number
  renderScale: number
  renderFormat: RenderFormat
  renderMaxChars: number
  renderTimeout: number
  renderCacheDir: string
  renderCacheMaxMB: number
  renderCircuitThreshold: number
  renderCooldown: number
  paperName: string
  renderFooterHint: boolean
  renderCaption: boolean

  // ---- 版面
  layoutPlanMode: LayoutPlanMode
  layoutPlanModel: string
  layoutPlanPrompt: string
  layoutPlanMaxAge: number
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    maxMessageLength: Schema.natural().min(200).max(4000).default(1500)
      .description('单条消息最大字符数，超出自动分段'),
    historyRetentionDays: Schema.natural().min(1).max(365).default(30)
      .description('场次与问答明细保留天数'),
    answeringHint: Schema.boolean().default(true)
      .description('开局时提示「只能问 是 / 不是 / 无关」'),
    verdictWithAt: Schema.boolean().default(false)
      .description('判词是否 @ 提问者'),
    verdictWithQuota: Schema.boolean().default(true)
      .description('判词后追加剩余提问次数（剩余 ≤ 3 时）'),
  }).description('基础设置'),

  Schema.object({
    defaultQuestionQuota: Schema.natural().max(999).default(0)
      .description('公共提问配额，0 表示不限'),
    defaultGuessQuota: Schema.natural().min(1).max(20).default(3)
      .description('公共提交配额'),
    personalGuessQuota: Schema.natural().max(10).default(0)
      .description('个人提交配额，0 表示关闭房间模式'),
    joinWindow: Schema.natural().min(10).max(600).default(60)
      .description('加入窗口（秒）'),
    maxPlayers: Schema.natural().min(1).max(100).default(20)
      .description('单场最大玩家数'),
    passThreshold: Schema.percent().min(0.5).max(1).default(0.8)
      .description('通过相似度阈值'),
    maxDuration: Schema.natural().max(86400).default(0)
      .description('单场时长上限（秒），0 表示不限'),
    questionCooldown: Schema.natural().max(60).default(3)
      .description('提问冷却（秒）'),
    guessCooldown: Schema.natural().max(60).default(5)
      .description('提交冷却（秒）'),
    allowPartialAnswer: Schema.boolean().default(false)
      .description('允许「是也不是」判词（实验性）'),
    showScoreDetail: Schema.boolean().default(false)
      .description('评分时展示关键要素命中情况'),
    hostCanEnd: Schema.boolean().default(true)
      .description('发起人可以结束自己开的场次'),
  }).description('玩法规则'),

  Schema.object({
    baseURL: Schema.string().default('https://api.deepseek.com')
      .description('API 端点（OpenAI ChatCompletions 格式）'),
    apiKey: Schema.string().role('secret').default('')
      .description('API Key，留空则读环境变量 DEEPSEEK_API_KEY'),
    model: Schema.string().default('deepseek-flash')
      .description('模型名称，官方当前为 deepseek-flash（V4.1-Flash）'),
    thinkingMode: Schema.boolean().default(false)
      .description('开启思考模式；开启后 temperature 不生效'),
    reasoningEffort: Schema.union(['low', 'high', 'max'] as const).default('high')
      .description('思考强度，仅思考模式生效'),
    temperature: Schema.number().min(0).max(1).step(0.05).default(0.2)
      .description('采样温度，判词要求稳定，不宜高'),
    timeout: Schema.natural().min(3).max(60).default(15)
      .description('单次请求超时（秒）'),
    maxRetries: Schema.natural().max(3).default(2)
      .description('失败重试次数'),
    dailyCallLimit: Schema.natural().max(100000).default(2000)
      .description('全局日调用上限，0 表示不限'),
    modelCheck: Schema.boolean().default(true)
      .description('启动时校验模型名是否存在'),
    includeHistory: Schema.boolean().default(false)
      .description('把本场历史问答作为上下文（显著增加成本）'),
  }).description('AI 服务'),

  Schema.object({
    talesDir: Schema.string().default('data/soup/tales')
      .description('汤文件目录（相对 Koishi 工作目录）'),
    autoImport: Schema.boolean().default(true)
      .description('启动时自动扫描导入'),
    autoEnable: Schema.boolean().default(true)
      .description('新导入的汤默认启用'),
    seedBundled: Schema.boolean().default(true)
      .description('汤库为空时自动铺一份内置样例汤（3 锅，可随意删改）'),
    ignoreLeakWarning: Schema.boolean().default(false)
      .description('忽略「汤面疑似泄底」告警'),
    masterAuthTTL: Schema.natural().min(60).max(3600).default(600)
      .description('主人绑定密钥有效期（秒）'),
  }).description('汤库与主人'),

  Schema.object({
    renderMode: Schema.union(['image-first', 'text'] as const).default('image-first')
      .description('图片优先（失败降级文本）或纯文本'),
    renderBackend: Schema.union(['auto', 'puppeteer', 'text'] as const).default('auto')
      .description('出图后端，auto 自动探测'),
    renderTheme: Schema.union(['newspaper', 'plain'] as const).default('newspaper')
      .description('图片主题'),
    renderWidth: Schema.natural().min(480).max(1280).default(720)
      .description('图片逻辑宽度（px）'),
    renderScale: Schema.natural().min(1).max(3).default(2)
      .description('清晰度倍数，2 即实际 1440px'),
    renderFormat: Schema.union(['jpg', 'png', 'webp'] as const).default('jpg')
      .description('输出编码，jpg 体积约为 png 的 1/6'),
    renderMaxChars: Schema.natural().min(200).max(3000).default(1200)
      .description('超过该字数自动缩字号，仍超则降级文本'),
    renderTimeout: Schema.natural().min(2).max(30).default(8)
      .description('渲染 + 发送超时（秒）'),
    renderCacheDir: Schema.string().default('data/soup/cache')
      .description('图片缓存目录'),
    renderCacheMaxMB: Schema.natural().max(2048).default(200)
      .description('缓存上限（MB），0 表示不缓存'),
    renderCircuitThreshold: Schema.natural().min(1).max(10).default(3)
      .description('连续发送失败几次触发熔断'),
    renderCooldown: Schema.natural().min(60).max(3600).default(600)
      .description('熔断时长（秒）'),
    paperName: Schema.string().max(16).default('海龟汤晚报')
      .description('报纸名称，印在刊头'),
    renderFooterHint: Schema.boolean().default(true)
      .description('图片底部印一行判词规则'),
    renderCaption: Schema.boolean().default(true)
      .description('图片后补一行极简规则'),
  }).description('渲染（报纸图）'),

  Schema.object({
    layoutPlanMode: Schema.union(['ai', 'default'] as const).default('ai')
      .description('ai = 按汤生成版面规划（导入期一次）；default = 全部用默认版'),
    layoutPlanModel: Schema.string().default('')
      .description('生成版面规划用的模型，留空复用主模型'),
    layoutPlanPrompt: Schema.string().role('textarea').default('')
      .description('追加到内置 prompt 的刊例偏好（留空用内置）'),
    layoutPlanMaxAge: Schema.natural().max(3650).default(0)
      .description('超过 N 天重新生成版面规划，0 表示永不'),
  }).description('AI 版面规划'),
])
