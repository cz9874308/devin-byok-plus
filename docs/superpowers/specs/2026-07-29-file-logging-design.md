# 日志文件功能设计（file logging）

- 日期：2026-07-29
- 分支：`feat/file-logging`
- 状态：设计已获用户逐节确认

## 1. 背景与问题

使用扩展时经常遇到两类难以定位的问题：

1. **Agent 会话意外断开**（流中断、超时、进程退出）。
2. **Agent 没按规则调用工具**，尤其是弹窗交互工具 `ask_user_question`。

这两类问题的共同特征是**难以复现**，事后无从查证。

### 现状核对（已读代码确认）

- 日志只走内存与 stdout：子进程 `console.log` → `proxyManager.log()`（`src/managers/proxyManager.js:244-247`）→ 侧栏 webview，只保留最近 200 行（`src/providers/sidebarProvider.js:80-89`）。进程重启或崩溃后现场全部丢失。
- 断流路径**已有**日志但无留存：`stream aborted` / `stream error` / `idle timeout` / 重试（`src/proxy/handlers/chat.js:1175-1194`、`src/proxy/retry-utils.js:21-69`）都只 `console.error`。
- 工具调用异常点同样只打印不留存：未知工具透传、工具全被过滤、`stop=tool_calls` 但无工具而降级、文本兜底恢复（`src/proxy/handlers/openai-stream.js:192-255`）。
- 唯一已有的文件写能力是 `DEBUG_EXPORT_SYSTEM_PROMPT` 的一次性提示词 dump（`src/proxy/handlers/parse-request.js:46-72`），没有通用日志文件设施。

**结论：定位所需的线索大部分已经在打印，缺的是持久化 + 可按请求关联。**

## 2. 目标与非目标

### 目标

- 结构化事件摘要**默认常开**落盘，体积小、可长期保留。
- 对已知可疑代码路径打上固定 `anomaly` 代码与 `severity`，一次 grep 即可挑出可疑轮次。
- 保住"断开现场"：进程异常退出时尾部日志不丢。
- 原文（上游 SSE、请求体、系统提示词）**按需**开启，用于复现疑难 case。
- 不影响 agent 交互性能：常规写入全异步。

### 非目标（YAGNI，明确不做）

- 不做侧栏日志面板 UI。
- 不做日志查询/分析脚本。
- 不做远程上报。
- **不改任何现有业务判定逻辑**，只在既有分支旁挂日志调用。
- 不做启发式"本该弹窗却没弹"判定（见 6.3）。

## 3. 架构

### 3.1 新增文件

代理侧（ESM，位于 `src/proxy/logging/`）。按单一职责拆分，每个模块可独立单测：

| 文件 | 职责 |
| --- | --- |
| `log-config.js` | env → 配置对象；导出 `configureLog(patch)` 作为热更新入口（见 3.2）。 |
| `log-file.js` | 路径拼接、轮转判定与改名、启动时清理过期文件。均为纯路径/时间判断，无需真写满阈值即可测。 |
| `log-queue.js` | 队列、攒批、串行 flush、背压丢弃、退出路径同步兜干。 |
| `log-writer.js` | **门面**。对外只暴露 2 个方法（见 3.4）。**不 import 任何业务模块**，避免循环依赖（`ws-bridge.js`、`chat.js` 都要引它）。 |
| `anomaly.js` | anomaly 代码常量 + `Severity` 冻结常量 + code → severity 映射。纯数据 + 纯函数。 |
| `turn-log.js` | 单轮上下文。`createTurnLog(meta)` 返回句柄，收集本轮字段与 anomaly 列表，结束时落一条 `chat_turn` 汇总，并逐条落 `anomaly` 事件。 |

扩展侧（CommonJS）：

| 文件 | 职责 |
| --- | --- |
| `src/managers/log-writer.js` | 精简写入器（约 60 行），只做追写 + 轮转。因为扩展侧是 CJS、代理侧是 ESM，两边无法共用同一模块文件；**与代理侧门面同名**，差异仅由路径体现。 |

命名约定：全部模块以 `log-` 前缀归组；概念词汇统一为 **turn**（一轮对话），不混用 `request` / `context` 等同义词；`anomaly.js` 用单数，它定义的是一个概念及其映射，而非集合。

### 3.2 改造点（最小侵入）

- `src/proxy/hybrid-server.js` / `src/proxy/inference-proxy.js`：启动时初始化 logger（读 env、建目录、清理过期文件、写一条 `lifecycle` 启动事件）。
- `src/proxy/handlers/chat.js`：在 `handleGetChatMessage` 创建 turn log；在既有的断流/超时/重试/强制 stop 分支旁挂 `ctx.anomaly(...)`（`chat.js:1100-1110`、`1159-1194`、`1582-1616`、`1619-1651`、`1715-1729`）。
- `src/proxy/handlers/openai-stream.js` / `anthropic-stream.js`：在既有降级/兜底分支挂 `anomaly`（`openai-stream.js:203-249`、`anthropic-stream.js:202-228`）。两个 processor 目前不持有 turn log，通过 `setTurnLog(ctx)` 注入，沿用它们已有的 `setAllowedTools` / `setSoundEligible` 注入风格。
- `src/managers/proxyManager.js`：在 `log()` 之外新增扩展侧事件写入（启停、端口回退、进程退出码、配置热更），复用 `src/managers/proxy-paths.js:85-102` 的 `getUserConfigDir()`。
- `src/proxy/handlers/models.js`：`setRuntimeConfig`（`models.js:244`）末尾调用 `configureLog(patch)`，打通热更新链路。

**依赖方向（强制）**：`models.js` → `logging/*` 允许，反向禁止。`/api/config` 的 patch 落到 `setRuntimeConfig`，而门面不得 import 业务模块，因此必须由 `models.js` 主动调用 `configureLog` 把配置推给日志侧；缺这条出口，第 7 节的热更新无法实现。

### 3.3 关联键

每轮使用已有的 `messageId` 作为 `turnId`，配合 `pid`、`proc` 与 `monitorTargetId`。这样同一轮在两个子进程之间、以及多次重试之间都能串起来。

### 3.4 对外 API

门面只暴露 2 个方法：

```js
logEvent(event);                      // 结构化事件
logBlob(turnId, kind, () => content); // 原文；关闭时不调用 supplier
```

**不暴露 `isVerbose()`**：那会把内部配置泄漏给调用方，并强迫每个 blob 调用点写 `if (isVerbose())` 分支。改用惰性 supplier 后，调用点无分支，且 verbose 关闭时根本不构造大字符串——这正是原本想用 `isVerbose` 解决的问题。

`turn-log.js` 句柄同样保持 3 个方法封顶，避免为 15 个字段各写一个 setter：

```js
ctx.set(partialFields);      // 浅合并
ctx.anomaly(code, detail);
ctx.finish();                // 落 chat_turn，幂等
```

`Severity` 用冻结常量而非裸字符串：`Object.freeze({ HIGH: 'high', MEDIUM: 'medium', LOW: 'low' })`。

## 4. 写入模型（异步，三档）

异步写有一个致命弱点：**缓冲区内容在进程崩溃时会丢**，而"agent 突然断开"恰恰常伴随进程异常退出——最需要的尾部日志正是最易丢的。因此采用三档策略：

1. **常规事件 → 异步批量**：事件先进内存队列，单个 writer 用 `setImmediate` 合并为一次 `fs.appendFile`（多行拼接）。写操作串行化（单条 in-flight promise 链），避免并发 append 交错撕裂 JSONL 行。事件循环不阻塞。
2. **高危事件（`severity=high`）→ 立即调度 flush**：断流、abort、超时、进程级异常入队即触发 flush，不等批量窗口。仍是异步 IO，只是不攒批。
3. **退出路径 → 同步兜干**：`process.on('exit')`、`uncaughtException`、`unhandledRejection`、`SIGTERM`/`SIGINT` 中用 `appendFileSync` 一次性写完队列剩余内容。此时进程即将结束，阻塞几毫秒可接受，持久性是唯一目标。**这是保住断开现场的关键，且只在这一个点付同步代价。**

### 4.1 背压与自保

队列设行数与字节数双阈值。超限时丢弃**最旧的普通事件**、保留高危事件，并记一条 `log_dropped{count}` 事件。日志子系统绝不允许把代理拖成 OOM 或卡住——宁可少记几行。

verbose 的原文 blob 全程异步、写独立文件、**永不进入同步路径**（单个 blob 可能数 MB，同步写会造成可感知卡顿）。

### 4.2 量级说明

设计上**不按 SSE chunk 记日志**，一轮对话只落 `chat_turn` 汇总 + 若干 anomaly，约 1–10 行。现有代码本就在每轮打十几条 `console.log`（`openai-stream.js:192-255`），新增 IO 相对它属边角量。异步化的主要目的是消除尾部丢失风险与 Windows 上杀软介入导致的写延迟尖刺，而非当前存在性能问题。

对外接口全部 fire-and-forget、不返回 promise，调用点无需 `await`，业务代码零心智负担。

## 5. 事件 schema

### 5.1 公共信封

每行一个 JSON 对象，固定前缀字段：

```json
{ "ts": 1753000000000, "pid": 12345, "proc": "hybrid", "type": "chat_turn", "turnId": "msg_abc", "target": "default" }
```

`proc` 取 `hybrid` / `inference` / `ext`，配合 `pid` 区分三个写入方。

### 5.2 事件类型（5 种）

**`chat_turn`** — 每轮一条汇总，流结束时落盘。字段：

| 字段 | 说明 |
| --- | --- |
| `initiator` | `user` / `agent`，来源 `parse-request.js:516-560` |
| `route` | `anthropic` / `openai-responses` / `chat-completions` |
| `model` | 解析后的上游模型名 |
| `byokSlot` | 生效的 BYOK 槽位 |
| `promptLen` | 系统提示词长度 |
| `requestBytes` | 上游请求体字节数 |
| `toolsOffered` | 下发给模型的工具名数组 |
| `toolChoice` | tool_choice 取值 |
| `stopReason` | 上游 stop reason |
| `toolsCalled` | 实际调用的工具名数组 |
| `usage` | 复用 processor `getUsage()` 结构 |
| `retryCount` | 本轮重试次数 |
| `soundEligible` | 完成声音资格标记 |
| `durationMs` | 本轮耗时 |
| `anomalies` | 本轮 anomaly code 数组 |

**`anomaly`** — 每个可疑点一条独立行，含 `code`、`severity`、`detail`。与 `chat_turn.anomalies` 冗余是**故意的**：前者带上下文细节，后者支持单行 grep 定位轮次。

**`lifecycle`** — 进程生命周期：启动、端口绑定、退出码、`uncaughtException`。扩展侧的启停 / 配置热更 / 端口回退也用此类型，`proc:"ext"`。

> 事件类型取名 `lifecycle` 而非 `proc`，避免与信封里的 `proc` 字段同名不同义、干扰 grep。

**`blob`** — verbose 模式下写出原文文件后落一条指针行，日志主文件**永不内联大文本**：

```json
{ "type": "blob", "turnId": "msg_abc", "kind": "sse", "file": "blobs/msg_abc.sse.txt", "bytes": 123456 }
```

`kind` 取 `sse` / `request` / `system_prompt`。

**`log_dropped`** — 背压丢弃计数，保证"日志不完整"这件事本身可见。

### 5.3 序列化策略

写入前按 **key 白名单**序列化，只输出上表列出的字段，不做整对象 dump。理由不是保密，而是：schema 稳定、文件小、避免对象上挂着 socket/stream 引用导致 `JSON.stringify` 抛错或写出大量噪音。

**不做密钥脱敏**——日志落在本机 `~/.devin-byok-plus/logs/`，不在仓库内、不会被误提交、不上公网。verbose blob 原样落盘不做任何处理。

> 注意：日志内含完整系统提示词与代码内容，对外分享（贴 issue 等）前需自行确认。

单字段上限 **2KB**，超出截断并标记 `...truncated(N)`。这把行长控制在阈值内，使追加写在 Windows 上对单行保持原子性，从而无需引入文件锁。

## 6. anomaly 代码表

全部对应代码中**已存在**的分支，不新增任何判定逻辑。

| code | severity | 触发位置 |
| --- | --- | --- |
| `stream_aborted` | high | `chat.js:1175-1184`、`1599-1607` |
| `stream_error` | high | `chat.js:1185-1194`、`1608-1616` |
| `stream_idle_timeout` | high | `chat.js:1100-1110` |
| `request_timeout` | high | `chat.js:1619-1651` |
| `forced_stop` | high | `chat.js:1159-1169`、`1582-1592` |
| `upstream_error_status` | high | 非 2xx 响应分支 |
| `retry` | medium | `chat.js:1715-1729` |
| `circuit_breaker` | medium | `circuitBreaker.recordFailure()` 各调用点 |
| `tool_calls_downgraded` | medium | `openai-stream.js:246-249`、`472-474` |
| `tools_all_filtered` | medium | `openai-stream.js:217-220` |
| `tool_recovered_from_text` | medium | `openai-stream.js:224-225`、`anthropic-stream.js:206-207` |
| `tool_args_invalid_json` | medium | `tool-normalization.js:56-63` |
| `tool_name_autocorrected` | low | `openai-stream.js:203-206` |
| `tool_unknown_passthrough` | low | `openai-stream.js:207-209` |

`high` 触发即时 flush；`medium` / `low` 走批量。

### 6.1 覆盖"断开"问题

上表的 6 个 high 项直接覆盖断开场景，可判断断开发生在上游断流、超时、进程崩溃还是熔断。

### 6.2 覆盖"没按规则调用工具"问题

`tool_calls_downgraded`、`tools_all_filtered`、`tool_recovered_from_text`、`tool_args_invalid_json`、`tool_name_autocorrected` 这几条对应的正是"模型确实想调工具但被代理侧静默降级/纠正/丢弃"的高发嫌疑点。

### 6.3 不做启发式判定（已决策）

模型**自己选择**不调用 `ask_user_question` 时，代码路径完全正常，不存在可打标的异常分支。若加"工具清单含 `ask_user_question` 且本轮自然结束且未调任何工具"的启发式，绝大多数正常轮次（模型正常回答问题时本就不该弹窗）都会命中，产生大量误报并淹没真信号。

**因此只如实记录客观事实**：`toolsOffered`、`toolChoice`、`stopReason`、`toolsCalled`、`initiator`。定位时按
`toolsOffered` 含 `ask_user_question` 且 `toolsCalled` 不含它且 `stopReason=stop` 自行 grep 捞候选轮次。零误报，判定权保留在使用者手中。

## 7. 配置

4 个配置项，全部加入 `writeEnvConfig` 白名单（`proxyManager.js:523`）与 `buildRuntimeConfigPatch`（`proxyManager.js:587`）。已核对：这 4 个键与现有白名单无冲突。

| key | 默认值 | 运行态字段 | 说明 |
| --- | --- | --- | --- |
| `LOG_ENABLED` | `true` | `logEnabled` | 总开关。摘要级日志每轮仅 1–10 行 JSON，常开才能捕获难复现问题 |
| `LOG_VERBOSE` | `false` | `logVerbose` | 原文 blob 开关 |
| `LOG_MAX_MB` | `10` | `logMaxMb` | 单文件轮转阈值 |
| `LOG_RETAIN_DAYS` | `7` | `logRetainDays` | 保留天数 |

去掉 `FILE_` 前缀：本设计的日志只有文件一个去向，该前缀是冗余的；简洁形式也与现有 `MAX_RETRIES`、`COMPLETION_TIMEOUT_MS` 风格一致。

`_runtimeConfig` 现存 camelCase 与 UPPER_CASE 混用（`defaultModel` vs `OPENAI_SERVICE_TIER`）。新增键**统一 camelCase**，不沿袭旧的不一致。

进入白名单的原因：不进白名单的 key 会被 `writeEnvConfig` 走 `tmp4` 原样透传（`proxyManager.js:524`、`581-583`），位置与注释不受管理。进入白名单后侧栏可管理、有固定位置。

加入 `buildRuntimeConfigPatch` 后，开关可经 `/api/config` **热更新、无需重启代理**（链路见 3.2 的 `configureLog`）——`LOG_VERBOSE` 尤其需要，便于复现问题时即时开启。

## 8. 文件布局与轮转

```
~/.devin-byok-plus/logs/
  proxy-2026-07-29.jsonl        # 当天全部事件（三个写入方共享）
  proxy-2026-07-29.1.jsonl      # 超过 LOG_MAX_MB 后的轮转序号
  blobs/msg_abc.sse.txt         # verbose 原文，按 turnId 命名
```

落在 `~/.devin-byok-plus/`，与 `.env` 同一持久目录，卸载重装不丢。

**按天单文件、三方共写。** 多写者靠 `pid` 字段区分；追加模式 + 单行原子写在 Windows 上对小于 4KB 的行是安全的，配合 5.3 的字段级截断把行长控制在阈值内，无需文件锁。

**轮转**：启动时与每次写入前检查当前文件大小，超阈值则改名加序号。

**清理**：仅在**进程启动时**扫描目录一次，删除超过 `LOG_RETAIN_DAYS` 的文件。不使用定时器，避免长期运行进程中多一个无必要的 timer。

## 9. 错误处理

本节是「不影响功能」这条强制要求的落点。`anomaly()` / `logEvent()` 的调用点直接嵌在业务分支里（如 `chat.js:1175-1194`），日志代码抛错就等于把 agent 交互打断。

- **调用本身不得抛错**：`logEvent` / `logBlob` / `ctx.*` 的整个函数体裹 `try/catch`，任何异常一律吞——不只是 IO 错误，也包括参数畸形（如 `detail` 含循环引用导致 `JSON.stringify` 抛错）、supplier 自身抛错。
- 日志子系统自身的任何 IO 错误一律吞掉（目录不可写、磁盘满等），绝不向业务路径抛出。
- 首次写入失败时向 stdout 打印一次告警（经 `proxyManager.log()` 出现在输出面板），之后静默，避免刷屏。
- `LOG_ENABLED=false` 时所有接口为空实现，零 IO、零队列分配。

## 10. 测试

沿用现有 21 个单测的 `.mjs` + node 内建 runner 风格，置于 `test/unit/`。模块拆分后每项可直接单测，不再依赖大模块副作用间接验证。

**`log-writer.test.mjs`**（门面）
- 写入临时目录，产出可逐行 `JSON.parse` 的 JSONL
- 字段级 2KB 截断与 `truncated` 标记
- `LOG_ENABLED=false` 时零 IO；`LOG_VERBOSE=false` 时 `logBlob` 的 supplier **不被调用**
- **传入畸形参数（循环引用、supplier 抛错）不抛出**

**`log-file.test.mjs`**
- 轮转在超过 `LOG_MAX_MB` 时触发并正确改名加序号
- 启动清理只删超过 `LOG_RETAIN_DAYS` 的文件

**`log-queue.test.mjs`**
- 攒批合并为单次写入，flush 串行不交错
- 背压超限丢最旧普通事件、保留 high、产生 `log_dropped`
- 退出路径同步 flush 写出队列剩余内容

**`anomaly.test.mjs`**
- code → severity 映射正确
- high 集合与 6 节表格一致

**`turn-log.test.mjs`**
- 一轮内多次 `anomaly()` 汇总进 `chat_turn.anomalies` 且去重
- `finish()` 只落一次 `chat_turn`（幂等，对应现有 `streamFinished` 那类双重 finalize 风险）

**`log-config.test.mjs`**
- `configureLog(patch)` 热更新生效，且 `models.js` → `logging` 单向依赖不产生循环引用

## 11. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 三进程共写同一文件导致行撕裂 | 字段截断保证行 < 4KB + 追加模式原子性；`pid` 区分来源 |
| 崩溃时尾部日志丢失 | 退出路径 `appendFileSync` 同步兜干（第 4 节第 3 档） |
| 日志拖累性能或涨爆内存 | 全异步 + 队列双阈值背压 + 不按 chunk 记录 |
| verbose 忘关导致磁盘占用 | 默认关闭 + 按天轮转 + `LOG_RETAIN_DAYS` 启动清理 |
| 日志代码引入新崩溃点 | 调用体全裹 `try/catch` 吞一切异常（第 9 节）；不 import 业务模块避免循环依赖 |
| 热更新链路走不通 | `models.js` 单向调用 `configureLog`（3.2），并由 `log-config.test.mjs` 覆盖 |

## 12. 交付范围

本次仅交付「能落盘、能 grep、不丢尾部」。侧栏异常面板 UI 与离线查询脚本若后续需要，各自另开 spec。

