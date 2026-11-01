# @bigxingyun/koishi-plugin-soup

> 把 Koishi 机器人变成 24 小时在线的海龟汤主持人。

玩家只问「是 / 不是 / 无关」，AI 主持人当场给判词；提交推理时按「关键要素命中 + 语义一致」打出相似度分，过线即揭汤底。汤面默认印成一张做旧报纸号外，发不出去就自动退回文字——玩家不会察觉。

不用等人主持、不用背汤底、不会说漏嘴。一锅汤十几分钟打完，适合群里随手开一局。

![真实渲染的汤面](https://raw.githubusercontent.com/bigxingyun/koishi-plugin-soup/main/docs/verify/real-render.jpg)

[![npm](https://img.shields.io/npm/v/@bigxingyun/koishi-plugin-soup?color=cb3837)](https://www.npmjs.com/package/@bigxingyun/koishi-plugin-soup)
[![license](https://img.shields.io/npm/l/@bigxingyun/koishi-plugin-soup)](https://github.com/bigxingyun/koishi-plugin-soup/blob/main/LICENSE)

## 特性

- **判词收敛**：模型只能回 `是 / 不是 / 无关`，输出走 JSON 白名单，其余一律丢弃
- **相似度评分**：汤底拆关键要素（权重可调）+ 语义分，按 6:4 加权，可解释
- **配额管理**：公共提问 / 公共提交 / 个人提交三层配额，用数据库求值表达式原子扣减，并发不超扣
- **报纸汤面**：默认把汤面渲染成做旧报纸图，渲染不可用时**自动降级纯文本**，玩家无感
- **AI 版面规划**：每锅汤的引题、副题、主色、印章由模型决定，版式由代码算（不会排版塌陷）
- **三级指令**：`海龟汤` → `海龟汤 汤库` → `海龟汤 汤库 重载`，管理功能全部收进分组

## 一局怎么玩

```
玩家：海龟汤 开局
bot ：〈一张报纸号外，印着汤面〉

玩家：海龟汤 问 她是不是被分尸了
bot ：是

玩家：海龟汤 提交 榜一发现被骗钱后潜入她家把她分尸，把尸块当礼物寄出去了
bot ：相似度 94%（通过线 80%）— 通过！〈公布汤底〉
```

提问次数、提交次数、通过线、单场时长都能按频道单独设置；开启「个人提交次数」后会多出一个 60 秒的加入窗口，变成多人轮流押注的房间模式。

## 安装

```sh
npm i @bigxingyun/koishi-plugin-soup
```

在 Koishi 控制台「插件配置」里启用，然后：

1. **填 API Key**：配置项 `apiKey`（或环境变量 `DEEPSEEK_API_KEY`）
2. **绑主人**：群里发 `海龟汤 主人 绑定`，到**控制台日志**里取 6 位密钥，再发 `海龟汤 主人 绑定 <密钥>`
3. **放汤**：首次启动会自动铺 3 锅样例汤到 `data/soup/tales/`，可随意删改；也可自己放 JSON 后发 `海龟汤 汤库 重载`

想要出图，额外装 `koishi-plugin-puppeteer`（可选，没装只发文本）。

| 项 | 要求 |
| --- | --- |
| Koishi | `^4.18.11` |
| Node.js | ≥ 18（依赖全局 `fetch`） |
| 数据库 | 必需，SQLite / MySQL / PostgreSQL / MongoDB 均可 |
| 出图 | 可选，需要 `koishi-plugin-puppeteer` + 系统中文字体 |

## 指令

| 指令 | 说明 |
| --- | --- |
| `海龟汤` | 当前场次摘要 |
| `海龟汤 开局 [汤名]` | 开始一局；`-t` 强制纯文本 |
| `海龟汤 问 <问题>` | 提问，只回 是 / 不是 / 无关 |
| `海龟汤 提交 <推理>` | 提交推理，返回相似度 |
| `海龟汤 加入` / `开始` | 房间模式加入 / 提前开始 |
| `海龟汤 汤面` `汤底` `状态` `结束` | 重发汤面 / 看汤底 / 进度 / 提前结束 |
| `海龟汤 战绩 [-s]` | 最近战绩 |
| `海龟汤 汤库` | 汤库列表（`列表` / `查看` / `启用` / `停用` / `删除` / `导入` / `重载`） |
| `海龟汤 主人` | 绑定与设置（`绑定` / `解绑` / `设置`） |
| `海龟汤 渲染` | 出图状态（`状态` / `测试` / `开启` / `关闭` / `主题`） |
| `海龟汤 诊断 [-f]` | 测 AI 站点连通性：Key、`/models`、模型名、能否真正跑一次推理 |

旧写法 `海龟汤 绑定`、`海龟汤 设置` 仍可用一次，会提示迁移到三段式。

### 更省事的写法

```text
汤 开局          # 汤 = 海龟汤
问 她死了吗       # 问 = 海龟汤 问
提交 榜一分尸了   # 提交 = 海龟汤 提交
```

或者**引用 bot 发的那张报纸**，输入你的问题即可——不用再打指令。指令始终优先，`海龟汤 状态` 这类不会被当成提问。

> 只认**引用 bot 自己的消息**：引用别人的话不会有反应（群里每天都在回复别人，否则 bot 会到处抢答）。引用一张图、一个表情也不会触发。
>
> 短别名默认开启；若 `问` / `提交` 已被别的插件占用，会自动跳过并在日志里记一条 debug。`引用即提问` 也能在配置里关掉。

## 汤文件格式

放在 `data/soup/tales/*.json`，单文件可放一条或数组：

```json
{
  "taleId": "additive-harm",
  "title": "添加剂危害",
  "difficulty": "normal",
  "tags": ["恐怖", "社会派"],
  "surface": "汤面正文，允许 Markdown，不允许 HTML",
  "answer": "汤底全文",
  "keys": [
    { "text": "摊主超量添加食品添加剂", "weight": 2 },
    { "text": "第一周年糕用了超标合成色素", "weight": 1 }
  ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `taleId` | ✅ | 小写字母/数字/连字符，3~64 位，全局唯一 |
| `title` | ✅ | 汤名，≤ 40 字 |
| `surface` | ✅ | 汤面，10~8000 字 |
| `answer` | ✅ | 汤底，10~10000 字 |
| `keys` | ❌ | 关键要素 1~8 条，缺省时评分退化为纯语义分 |
| `difficulty` | ❌ | `easy` / `normal` / `hard` |
| `tags` | ❌ | 最多 8 个 |
| `newspaper` | ❌ | 手工版面覆盖，写了就不再调 AI |

完整 JSON Schema：[`docs/schema/tale.schema.json`](https://github.com/bigxingyun/koishi-plugin-soup/blob/main/docs/schema/tale.schema.json)。

导入时会做三件事：**清洗 HTML/代码围栏**、**校验字段**、**泄底检测**（汤面含汤底 ≥12 字原句时拒绝导入）。

> 从 0.1.0 升级：数据目录由 `data/situation-puzzle/` 改为 `data/soup/`。若新目录尚未创建而老目录里已有汤，插件会自动继续读老目录，无需手动迁移。

## 配置要点

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `model` | `deepseek-flash` | 官方当前对应 V4.1-Flash |
| `thinkingMode` | `false` | 关掉思考模式：判词要稳定，且思考模式下 `temperature` 不生效 |
| `defaultGuessQuota` | `3` | 公共提交次数 |
| `defaultQuestionQuota` | `0` | 提问次数，0 表示不限 |
| `personalGuessQuota` | `0` | >0 时启用房间模式 |
| `passThreshold` | `0.8` | 通过相似度 |
| `renderMode` | `image-first` | 图片优先，失败降级文本 |
| `renderFormat` | `jpg` | PNG 体积约为 JPEG 的 6 倍 |
| `seedBundled` | `true` | 汤库为空时自动铺 3 锅内置样例汤 |
| `shortCommands` | `true` | 注册短别名：汤 / 问 / 提交 / 开局 |
| `quoteAsk` | `true` | 引用 **bot 自己的**消息时，文字直接当提问 |
| `abortOnAiFailure` | `true` | AI 判定失败就散场并交底；关掉则保留场次、提示重试 |
| `renderTheme` | `newspaper` | `newspaper` 做旧报纸 / `plain` 干净排版（可按频道切） |
| `historyRetentionDays` | `30` | 场次与问答明细保留天数，过期每 6 小时清一次 |

全部 56 项配置及默认值见[需求规格](https://github.com/bigxingyun/koishi-plugin-soup/blob/main/需求分析.md) §7。

## 常见问题

**Q：没配 Key 能用吗？**
能管理汤库、看汤面，但**不能开局**——判定器是这局游戏的前提，`海龟汤 开局` 会直接提示去填 `apiKey`（避免开出一局注定散场的汤）。

**Q：AI 挂了会怎样？**
默认**当场散场并公布汤底**：「AI 没连通（连不上 API 站点），这锅先散了，本场不计。」不会让你对着一个答不了题的场次干等。想保留场次就关掉 `abortOnAiFailure`。

**Q：群里回复别人也会被当成提问吗？**
不会。只认引用 **bot 自己发出的**消息，引用别人的话、引用一张图都不会触发。

**Q：没装 puppeteer 会怎样？**
一直发纯文本，功能完整。装了但渲染失败（比如容器缺中文字体）也会自动降级，不会报错给玩家。

**Q：判词不稳定怎么办？**
先把 `temperature` 保持 0.2 左右、`thinkingMode` 关掉；同一场次里重复的问题会被缓存，不会两次给不同答案。仍不满意可以换 `deepseek-v4-pro`（贵约 6 倍）。

**Q：为什么我的汤导入失败了？**
`海龟汤 汤库 重载` 会打印失败原因。最常见的是汤面里出现了汤底的原句（泄底检测），或 `taleId` 重复。

**Q：能一锅汤玩多局吗？**
能，汤库按 `playedCount` 优先抽没玩过的；同一频道同一时刻只允许一场。

## 开发

```sh
npm install
npm run build      # 编译到 lib/
npm test           # 79 个用例：单元 + mock 集成 + 渲染 + 路由 + 出图 + 稳定性
npm run typecheck
```

测试用 `@koishijs/plugin-mock` + 内存数据库，并用假 `fetch` 顶掉真实的模型调用，**不需要联网也不需要 API Key**。

版式与版面规划的实现参考在 [`docs/render-sample/`](https://github.com/bigxingyun/koishi-plugin-soup/tree/main/docs/render-sample)，需求规格见 [`需求分析.md`](https://github.com/bigxingyun/koishi-plugin-soup/blob/main/需求分析.md)。

### 真实出图验证（需要本机 Chrome）

```sh
npm run verify:render      # 或：$env:CHROME_PATH="D:\chrome\chrome.exe"; node scripts/verify-render.js
```

脚本会起一个无头 Koishi 应用（mock 适配器 + 内存数据库 + `@koishijs/plugin-http` + `koishi-plugin-puppeteer`），
自动发送一次 `海龟汤 开局`，把插件**实际发出**的图片落到 `docs/verify/`：`real-render.jpg`（做旧报纸）、`plain-render.jpg`（`renderTheme: plain`）；没有收到图片就以非零码退出。

> 两个只在裸 Context 里才会遇到的坑：`koishi-plugin-puppeteer` 声明了 `inject = ['http']`，必须先装
> `@koishijs/plugin-http`；另外它提供的服务在 `ready` 之后才真正就绪，脚本里要等一会儿再发消息。
> 正常 Koishi 应用这两个条件都天然满足。

## 已知限制

- 长汤面（>1200 字）会缩字号，仍过长时降级文本；尚未按高度自适应
- 汤面里的 Markdown 标题 / 表格暂不解析，会按纯文本渲染
- `en-US` 文案只有骨架

## 更新日志

### 怎么升级

```sh
npm i @bigxingyun/koishi-plugin-soup@latest    # 或在控制台「插件市场」点升级
```

升级后**重启 Koishi** 生效。数据不用手动迁移：表结构走 `ctx.model.extend` 自动补列，老数据目录也会被自动识别（见 0.1.1）。

### 0.2.3 — 2026-11-01

**修复**

- **引用别人的消息也会被当成提问**：0.2.1 只判断「消息里有没有引用」，群里谁回复谁都能触发一次提问，AI 一挂就满屏「主持人走神了」。现在只认**引用 bot 自己发出的消息**（先看被引用消息的作者，平台不提供时再反查一次），并且只取纯文本——引用一张图、一个表情不再触发
- 提前开局（`海龟汤 开始`）会把**超时计时器一起撤掉**，导致提前开局的场次永远不会超时
- 最后一次提交也没中时场次会一直挂着：现在当场收场并公布汤底
- 超时、无人加入这两种结束方式**完全静默**，玩家看不到任何结果；现在会在频道里说明并交底
- 结算统计里的「N 人参与」写死成 1，现在按发起人 + 加入 + 提问 + 提交的真实用户去重统计
- 汤库列表谎报页码（永远「第 1/1 页」），超过 20 条也不提示
- 图片缓存的 key 漏了个人配额 / 标签 / 主题 / 日期，改完规则会命中旧图，图上规则与实际不符
- `renderWidth` 只改了截图视口，纸张宽度写死 700px；现在真的跟着配置走，窄版自动退单栏

**变更**

- **AI 判定失败不再让玩家「稍后重试」，而是直接散场并公布汤底**（`AI 没连通（原因），这锅先散了，本场不计。`）。关掉 `abortOnAiFailure` 可回到「保留场次、本次不计次数」
- 未配置 `apiKey` 时**直接拒绝开局**，不再开出一局注定散场的汤
- 判词支持中英文归一（`是` / `否` / `无关` / `是也不是`），模型写中文不再判为解析失败
- 补齐之前"能配但不生效"的配置：`renderTheme`（新增 plain 干净排版）、`includeHistory`、`layoutPlanMaxAge`、`historyRetentionDays`（每 6 小时清理过期场次）、`answeringHint`

**其他**

- 测试 64 → 79，新增稳定性用例：AI 断线散场、引用别人的消息不插话、引用图片不触发、提前开局仍超时、人数统计、中文判词
- `npm run verify:render` 现在同时产出 `docs/verify/real-render.jpg`（做旧报纸）和 `docs/verify/plain-render.jpg`（干净排版）

### 0.2.1 — 2026-11-01

**新增**

- 短别名：`汤 开局`、`问 …`、`提交 …`、单独 `开局`。开关 `shortCommands`，和别的插件撞名时自动跳过
- 引用即提问：直接引用 bot 发的消息说话，就当提问。开关 `quoteAsk`

**修复**

- help 的用法说明里写了 `<问题>`，被 Koishi 当成消息元素解析，尾部漏出 `</推理></问题>`
- `开始` 的描述「提前结束集结」与 `结束` 语义混淆，改为「跳过等待，立刻发车」

**其他**

- 重写全部指令描述（去冗余、标注权限）；测试 56 → 64

### 0.2.0 — 2026-11-01

**新增**

- 3 锅样例汤随包发布，首次启动自动铺到 `data/soup/tales/`（只在汤库为空时铺，开关 `seedBundled`）
- `海龟汤 诊断 [-f]`：依次检查 Key → 站点可达 → 模型名 → 真实推理链路

**修复**

- AI 生成的版面（引题/副题）此前没有泄底检测，现与汤底做最长公共子串比对，命中即回退默认版面

**其他**

- 补 DeepSeek 请求契约测试：`response_format`、`thinking`、`temperature` 取舍、定界符、401 / 429 / 空 content / 非 JSON 共 11 例

### 0.1.1 — 2026-11-01

- 数据目录 `data/situation-puzzle/` → `data/soup/`；老目录里有汤时自动继续读，不会「汤库突然空了」
- README 补真机效果图、FAQ、环境要求

### 0.1.0 — 2026-11-01

- 首个可用版本：三级指令、公共/个人三层配额、AI 判词与相似度评分、报纸图渲染与纯文本降级、汤库导入与泄底检测、主人绑定

## License

[MIT](https://github.com/bigxingyun/koishi-plugin-soup/blob/main/LICENSE)
