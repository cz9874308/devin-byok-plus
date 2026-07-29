# 空流修复与日志诊断补全设计

- 日期：2026-07-30
- 分支：`fix/empty-stream-and-log-diagnostics`
- 前置：`docs/superpowers/specs/2026-07-29-file-logging-design.md`（日志设施已实现并随 v2.5.0 发布）
- 状态：设计已获用户逐项确认

## 1. 背景

日志设施上线后产出了第一份真实数据：`~/.devin-byok-plus/logs/proxy-2026-07-29.jsonl`，747 行，约 580 个 `chat_turn`、123 个 `anomaly`、48 个 `lifecycle`。全部样本 `route=anthropic`、`model=claude-opus-5`、`byokSlot=4`，上游是 `.env` 里的 `BYOK4_ANTHROPIC_API_HOST=127.0.0.1:9090`（本地网关，非公网）。

这份数据把「agent 经常断开」拆成了两个互不相同的根因，并否证了「弹窗工具被代理吃掉」的猜想。

### 1.1 anomaly 分布

| code | 条数 |
| --- | --- |
| `upstream_error_status` | 56 |
| `retry` | 49 |
| `forced_stop` | 11 |
| `circuit_breaker` | 7 |

`stream_aborted`、`stream_error`、`stream_idle_timeout`、`request_timeout` 全部为 0 —— 其中至少 `stream_idle_timeout` 的 0 是假的，见 1.4。

### 1.2 断开根因 A：503 → 重试耗尽 → 熔断

25 个 turn 命中 503。其中 18 个在重试 1-2 次后恢复（`stopReason=tool_use`，工作继续），7 个 `retryCount=3` 耗尽后走 `circuit_breaker`，`stopReason` 与 `usage` 全空 —— 这是用户可见的断开。

重试延迟表是 `1s / 2s / 5s`（`src/proxy/retry-utils.js:8`），三次加起来只扛 8 秒。18/25 的恢复率说明重试方向正确，但窗口偏短。

**已决策：本次不碰重试参数。**只把 503 的响应体记下来 —— 网关说的是「无可用通道」「频率限制」还是「上游过载」，对应的正确退避完全不同，没有这个信息就调参数是猜。

### 1.3 断开根因 B：空流被当成正常结束

11 个 turn 落 `forced_stop / no message_stop`，特征高度一致：

- `retryCount=0`（从未重试）
- `output_tokens=0`（个别 1-2）
- `cache_creation_input_tokens` 有值：19444 / 88675 / 122506
- `durationMs` 12s-198s

即：网关接了请求、回了 200、发出 `message_start`（带 prompt cache 写入统计），然后直接关流，一个字也没产。

现有代码在 `src/proxy/handlers/chat.js:1639-1651` 伪造一个 `message_stop` 塞给 processor，然后以 `✅ Stream ended (forced stop)` 收尾。后果有三层：

1. 客户端收到合法的终止事件，认为这一轮正常结束，agent 就此停住。
2. `_onMessageStop` 会调 `emitChatEnd`（`src/proxy/handlers/anthropic-stream.js:244`），`toolsCalled` 为空且非 `tool_use`，于是**完成声音照响**，进一步强化「正常干完了」的错觉。
3. 不重试、不报错、日志里只留一句 `no message_stop`。

这是纯粹的代理侧逻辑缺陷，也是本次修复的主目标。

### 1.4 诊断盲区

| 盲区 | 位置 | 后果 |
| --- | --- | --- |
| 503 响应体只 `console.error` 不落盘 | `chat.js:1503-1509` | 不知道网关为何 503，无法定退避策略 |
| Anthropic 路 idle timeout 既不打 anomaly 也不 `finishTurnLog` | `chat.js:1587-1601` | 整类 high 失败模式不可见（OpenAI 路 `chat.js:1123` 有打标）。用户 100% 走 anthropic，所以日志里该 code 恒为 0 |
| `forced_stop` detail 只有 `no message_stop` | `chat.js:1641` | 不知道收到过几个事件、最后事件类型、字节数 |
| `wasClosedByClient()` 早退点直接 `return` | `chat.js:1590`、`1662`、`1673`、`1684`、`1723` | 无法区分「用户点了停」与真断开；且 turn log 不 finish |
| 无 `turn_start` 事件 | `chat.js:593-602` | 4 个 turn 只有 anomaly 没有 `chat_turn`（finish 未执行到），现场丢失；也算不出「发起数 vs 完成数」 |
| 无聚合手段 | — | 本次分析全靠临时手写 PowerShell，不可复用 |

### 1.5 弹窗工具：确认是模型没请求

`ask_user_question` 在 566 轮里被提供，实际调用 6 轮。判定链：

- `toolsCalled` 记录的是代理实际转发给客户端的调用，6 轮成功说明工具定义、别名映射、参数规范化全链路是通的。
- 工具类 anomaly 全部为 0：没有 `tools_all_filtered`、`tool_calls_downgraded`、`tool_name_autocorrected`、`tool_recovered_from_text`、`tool_args_invalid_json`。代理没有丢弃或改写过任何工具调用。
- `isAllowedToolName` 只要求名字非空（`src/proxy/handlers/tool-normalization.js:6-10`），`ask_user`/`ask_human`/`askUserQuestion` 等别名都会被映射回 `ask_user_question`。
- `SYSTEM_PROMPT_OVERRIDE` 未开启，17.4K 的系统提示词（含用户规则）原样送达上游。

结论：模型自己没有发出这个工具调用。**已决策：本次 spec 不对弹窗做任何改动**（不打标、不记回答尾文、不注入提示词）。作为参考留档：`stopReason=end_turn` 且 `toolsCalled` 为空的候选轮共 26 个（26/566 = 4.6%），若日后需要量化「本该弹却没弹」，这是可用的筛选条件，误报规模可控。

> 这一条同时修正了前置 spec 第 6.3 节的判断：该节担心启发式判定会「淹没真信号」，真实数据下候选集只有 4.6%。本次不做，但理由是优先级，不是误报率。

## 2. 目标与非目标

### 目标

- 空流不再被伪装成正常结束：能自动重试，重试无效时明确失败。
- 空流不再误触发完成声音。
- 503 的原因可事后查证。
- 补齐 Anthropic 路缺失的 high 级打标，使断开原因不再有整类盲区。
- 每一轮都至少有一条起始记录与一条终止记录，孤儿轮消失。
- 提供可复用的只读聚合脚本。

### 非目标

- 不调整**既有 HTTP 层**的重试次数与退避延迟参数（含 503、超时、网络错误）。第 3 章新增的空流重试是一条独立通道，与它们不共享计数与延迟表。
- 不改熔断器阈值与状态机。
- 不对弹窗工具做任何检测或提示词干预。
- 不做侧栏日志/异常面板 UI。
- 不改日志文件命名与轮转策略（`dailyFileName` 的 UTC 命名保持不变，见 5.3）。
- 不引入任何测试专用后门开关（如强制空流的 env）。

## 3. 空流修复

### 3.1 判定依据：写出内容，而不是 token 数

`usage.output_tokens` 不能作为唯一判据：实测有 `out=1`、`out=2` 的 `forced_stop` 轮，上游报了输出 token，但这些 token 未必落成客户端可见内容。重试安全性只取决于一件事 —— **是否已经向客户端写出过内容**。零内容写出时重发不可能产生重复文本。

因此在 processor 上新增只读标记：

- `anthropic-stream.js`：新增私有 `_emittedContent`，在 `_emitTextChunk`（文本落给客户端处）与 tool_use 块写出处置为 `true`；暴露 `get emittedContent()`。
- 该标记只增不减，语义是「本轮是否已有任何内容抵达客户端」。

### 3.2 新模块 `src/proxy/handlers/empty-stream.js`

纯函数，不 import 任何业务模块，可独立单测：

```js
classifyStreamEnd({ isDone, emittedContent, closedByClient }); // 'closed' | 'normal' | 'empty' | 'partial'
shouldRetryEmptyStream(kind, retryCount, maxRetries);          // boolean
```

分类语义：

| 结果 | 条件 | 处理 |
| --- | --- | --- |
| `closed` | `closedByClient` 为真 | 记 `client_closed`，finish turn log，不重试不报错 |
| `normal` | `isDone` 为真 | 现状不变：记录成功、重置熔断器、正常收尾 |
| `empty` | `!isDone` 且 `!emittedContent` | 重试；耗尽则报错 |
| `partial` | `!isDone` 且 `emittedContent` | 现状不变：伪造 `message_stop` 收尾，只补充 `forced_stop` 的上下文记录 |

`partial` 必须保持现状：已经有内容抵达客户端，重发会造成文本重复。

### 3.3 重试策略

- 触发点：`chat.js:1632-1658` 的 `res.on('end')` 分支，按 `classifyStreamEnd` 结果分流。
- 次数：默认最多 2 次，由 `EMPTY_STREAM_MAX_RETRIES` 控制。
- 延迟：固定 `1s / 3s`，不引入新的可配置延迟表。
- **独立计数器** `emptyStreamRetryCount`，与 HTTP 层的 `retryCount` 分开累计。理由：两者共用配额会让空流重试挤掉 503 重试，而 503 重试的 18/25 恢复率是现在唯一有效的自愈机制，不能被削弱。
- 复用既有的 `streamAnthropic(..., retryCount)` 递归入口重发，请求体不变（因此 prompt cache 更可能命中，重发成本低于首次）。
- 每次触发落一条 `empty_stream`（high），detail 含 `attempt=N/M`、上游主机、已收字节数。
- `shouldRetryAnthropicRequest` 的 `hasReceivedData` 判定**不改动**，避免影响现有 HTTP 层重试行为。

### 3.4 重试耗尽

耗尽后**不再伪造 `message_stop`**，改走既有失败通道 `fail('[Anthropic Empty Stream]')`：

- 客户端得到明确错误，用户知道要重发，而不是以为 agent 答完了。
- `emitChatEnd` 不再以自然结束语义触发，完成声音不再误响。
- 落 `empty_stream_exhausted`（high）并 `finishTurnLog`。

### 3.5 OpenAI 路

`classifyStreamEnd` 是纯函数，接到 OpenAI 路（`chat.js:1182-1200` 的 `forcing stop` 分支）几乎零成本。**决定一并接入**，理由是留一条未修的同类路径将来必然复现同一个 bug。当前样本里 OpenAI 路占比为 0，所以它排在实施阶段 2，anthropic 路先落地验证。若不认可可以砍掉，不影响阶段 1。

## 4. 可观测补全

沿用前置 spec 的原则：**只在既有分支旁挂日志调用，不新增业务判定**。唯一的例外是 3.1 的 `emittedContent` 标记，它是空流修复本身需要的状态，不是为日志而加。

### 4.1 anomaly 代码表增补

| code | severity | 触发位置 | 说明 |
| --- | --- | --- | --- |
| `empty_stream` | high | `chat.js` anthropic/openai 的 `end` 分支 | 每次空流重试触发一条 |
| `empty_stream_exhausted` | high | 同上 | 重试耗尽、向客户端报错时 |
| `client_closed` | low | 各 `wasClosedByClient()` 早退点 | 用户主动停止，非故障 |

`stream_idle_timeout` 不是新增，而是补上 Anthropic 路缺失的调用点（`chat.js:1587-1601`）。

### 4.2 事件字段增补

`chat_turn` 新增字段：

| 字段 | 说明 |
| --- | --- |
| `emittedContent` | 本轮是否有内容抵达客户端 |
| `emptyStreamRetryCount` | 空流重试次数（与 `retryCount` 分列） |
| `upstreamHost` | 生效的上游主机（`host:port`），排查多槽位/多网关时必需 |
| `sseBytes` | 本轮收到的上游 SSE 字节数，空流时为区分「完全没数据」与「只有 message_start」的关键 |

新增事件类型 `turn_start`：在 `chat.js:593-602` 创建 turn log 之后立即落一条，携带 `turnId` / `initiator` / `promptLen` / `model` / `byokSlot` / `upstreamHost` / `route`。作用有两个：孤儿轮（只有 anomaly 没有 `chat_turn`）变成可见的「有始无终」，以及使完成率 = `chat_turn / turn_start` 可算。

`anomaly.detail` 内容增强（不改结构）：

- `upstream_error_status`：`status=<code> host=<host> attempt=<n> body=<前 512 字节>`，body 经既有的 `sanitizeLogBody` 处理。单字段 2KB 上限由 `log-writer.js` 已有的截断保证。
- `forced_stop`：`events=<n> lastEvent=<type> bytes=<n> emittedContent=<bool> outTokens=<n>`。

**`ALLOWED_FIELDS` 必须同步更新**（`src/proxy/logging/log-writer.js:22-61`）：白名单外的字段会被静默丢弃，这是最容易漏的一步。

### 4.3 finish 覆盖率

`finishTurnLog` 幂等（`turn-log.js` 的 `finished` 标志），可安全地在所有收尾路径调用。本次把它补到目前缺失的三处：Anthropic idle timeout、`wasClosedByClient` 早退、空流耗尽。目标是「任何一轮都至少有一条 `turn_start` 和一条 `chat_turn`」。

## 5. 分析脚本

### 5.1 形态

`scripts/analyze-logs.mjs`，只读，入口 `npm run logs:report`，参数 `--date=YYYY-MM-DD`（默认今天）与 `--days=N`（默认 1）。

### 5.2 输出

- 概览：`turn_start` 数、`chat_turn` 数、完成率、孤儿轮数量
- anomaly 分布：按 code × severity 计数
- 断开清单：熔断轮、空流轮（含重试后是否恢复）、超时轮、孤儿轮，每条给 `turnId` 前 8 位 + 关键字段
- 自愈率：`retry` 后成功的比例（本次实测 18/25）

### 5.3 实现约束

- 核心 `aggregate(lines)` 是纯函数（输入字符串数组，输出统计对象），单测直接喂假数据，不碰文件系统。脚本本体只做「读文件 → 调 aggregate → 打印」。
- 单行 `JSON.parse` 失败必须跳过并计入 `malformed` 计数，不能让一行坏数据搞挂整个报告。
- 日志文件名用 UTC 日期（`src/proxy/logging/log-file.js:24-29`），UTC+8 下看起来差一天。**不改命名**（会让历史文件断档），改为在脚本里做时区换算：`--date` 按本地日期解释，内部映射到可能涉及的 UTC 文件（跨界时读两个文件）。

## 6. 配置

| key | 默认值 | 说明 |
| --- | --- | --- |
| `EMPTY_STREAM_MAX_RETRIES` | `2` | 空流最大重试次数，`0` 表示关闭重试（退化为「不伪装成功、直接报错」） |

只读 env，**不进侧栏白名单**（`proxyManager.js` 的 `writeEnvConfig`）也不进 `buildRuntimeConfigPatch`。理由：这是一个装完就不需要再动的可靠性参数，不值得为它加 UI 与热更新链路；不在白名单的 key 仍会被原样透传给子进程，手改 `.env` 重启代理即生效。

## 7. 不变量与错误处理

本节是「不把现有可用行为改坏」的落点。以下几条在实现与评审中都必须逐条核对：

1. **HTTP 层重试行为不变**：`shouldRetryAnthropicRequest`、`isRetriableError`、`calculateRetryDelay`、熔断阈值一律不动。503 的 18/25 自愈率是回归基线。
2. **`partial` 路径行为不变**：已写出内容的轮次仍旧伪造 `message_stop` 收尾，绝不重试。
3. **客户端主动关闭不产生错误**：`wasClosedByClient()` 为真时只记录，不写错误块、不报 fail。
4. **日志调用不得抛错**：新增的 anomaly/字段调用沿用 `turn-log.js` 的全裹 `try/catch` 语义；`empty-stream.js` 是纯函数，对畸形入参返回 `partial`（最保守的分类）而不是抛异常。
5. **`empty-stream.js` 不 import 业务模块**，保持可单测与无循环依赖。
6. **分析脚本只读**：不写、不删、不改任何日志文件。

## 8. 测试

沿用现有 `.mjs` + node 内建 runner 风格，置于 `test/unit/`。

**`empty-stream.test.mjs`**（新）
- 四种分类的判定：`closed` / `normal` / `empty` / `partial`
- `closedByClient` 优先于其它条件
- `shouldRetryEmptyStream`：`empty` 且未达上限为真；`partial`、`normal` 恒为假；`maxRetries=0` 恒为假
- 畸形入参（`undefined`、非对象）返回 `partial` 且不抛

**`analyze-logs.test.mjs`**（新）
- `aggregate` 对构造的 JSONL 行产出正确的计数与清单
- 坏行计入 `malformed` 且不影响其余统计
- 孤儿轮识别：有 `turn_start` 无 `chat_turn`

**`anomaly.test.mjs`**（扩充）
- 三个新 code 的 severity 映射；high 集合与 4.1 表一致

**回归**：`test/unit/` 全量跑通，重点确认 `log-writer.test.mjs` 的白名单截断行为未被新字段破坏。

**实机验证**：写一个临时假上游（本地起一个 node HTTP 服务，回 200 + `message_start` 后立即 `end()`），把某个 BYOK 槽位的 host 指向它，观察：客户端出现明确错误而非空回复、完成声音不响、日志出现 `empty_stream` × 2 + `empty_stream_exhausted`。验证完删除临时脚本，不入库。

## 9. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 空流重试重复消耗 prompt cache 写入（实测 19K-122K token/次） | 上限 2 次；仅零内容写出时触发；重发请求体不变，cache 命中率更高，实际成本低于首次 |
| 空流重试与 HTTP 重试互相耗尽配额 | 两个计数器完全分离（3.3） |
| `emittedContent` 标记漏置导致误重试、产生重复文本 | 标记点集中在 `_emitTextChunk` 与 tool_use 写出两处；`partial` 是默认保守分类；单测覆盖 |
| 报错替代静默成功后，用户感知到的失败变多 | 这是预期效果：原本的「静默成功」才是更坏的失败。日志能证明这些轮次本来就没有产出 |
| 新字段被白名单静默丢弃 | 4.2 明确要求同步 `ALLOWED_FIELDS`，并由 `log-writer.test.mjs` 断言新字段可落盘 |
| 改动集中在 2394 行的 `chat.js`，回归面大 | 判定逻辑全部外移到纯函数模块；`chat.js` 内只做分流与调用，diff 保持小而集中 |

## 10. 实施阶段

**阶段 1（核心，anthropic 路）**
1. `empty-stream.js` + 单测
2. `anthropic-stream.js` 的 `emittedContent`
3. `chat.js` anthropic `end` 分支分流 + 空流重试 + 耗尽报错
4. `anomaly.js` 三个新 code + 单测

**阶段 2（可观测与 openai 路）**
5. 503 响应体、`forced_stop` 上下文、Anthropic idle timeout 打标、`client_closed`、`turn_start`、新字段 + `ALLOWED_FIELDS`
6. OpenAI 路接入 `classifyStreamEnd`

**阶段 3（工具）**
7. `scripts/analyze-logs.mjs` + `aggregate` 单测 + `package.json` 脚本入口

**阶段 4（验证与交付）**
8. 全量单测回归；假上游实机验证
9. 同步到运行副本 `~/.windsurf/extensions/jornlin.devin-byok-plus-2.4.6/proxy-scripts/src/`（目录结构与 `src/proxy/` 一一对应），完全重启客户端验证
10. 用 `npm run logs:report` 对比修复前后的断开分布

## 11. 决策记录

| 议题 | 决定 | 理由 |
| --- | --- | --- |
| 空流处理 | 重试 2 次，耗尽后报错 | 修掉「静默成功」这个最隐蔽的失败；零内容写出保证重试安全 |
| 503（A 类） | 只记响应体，不碰重试参数 | 网关 503 的具体原因未知，先取证再调参 |
| 弹窗工具 | 本次不做 | 已证明是模型未请求，非代理缺陷；优先级低于断开 |
| 分析手段 | 加只读脚本 | 本次分析靠一次性手写命令，不可复用 |
| 日志文件命名 | 保持 UTC 不改 | 改名会让历史文件断档，时区换算放到脚本侧 |
| OpenAI 路 | 一并接入，排在阶段 2 | 纯函数已具备，留同类未修路径将来必复现 |
