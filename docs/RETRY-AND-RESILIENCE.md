# Retry & Resilience Mechanism

devin-byok-plus 内置了一套多层防断连与容错机制，确保通过 BYOK 代理对接上游 LLM API 时，
瞬态网络故障、上游过载、长时间思考等场景下对话不会中断。

---

## 1. 自动重试（Automatic Retry）

**核心模块：** `src/proxy/retry-utils.js`

### 1.1 可重试错误判断

`isRetriableError(error, statusCode)` 统一判定哪些错误值得重试：

| 类型 | 错误码/状态码 | 说明 |
|------|-------------|------|
| 网络层 | `ETIMEDOUT` | 连接超时 |
| 网络层 | `ECONNRESET` | 连接重置 |
| 网络层 | `ECONNREFUSED` | 连接被拒绝 |
| 网络层 | `ENOTFOUND` / `EAI_AGAIN` | DNS 解析失败 |
| 网络层 | `ENETUNREACH` / `EHOSTUNREACH` | 网络/主机不可达 |
| 网络层 | `EPIPE` / `ECONNABORTED` | 管道破裂/连接中止 |
| HTTP | 408 | 请求超时 |
| HTTP | 429 | 限流（特殊退避策略） |
| HTTP | 502 / 503 / 504 | 上游服务器错误 |

4xx 客户端错误（401/403/400/404 等）**不重试**——这些是业务层错误，重试无意义。

可通过 `.env` 设置 `ENABLE_RETRY=false` 全局禁用重试。

### 1.2 退避算法

`calculateRetryDelay(retryCount, statusCode, headers, isTimeout)` 实现指数退避：

- **普通错误：** 1s → 2s → 5s（预定义梯度）
- **超时错误：** 0.5s → 1.5s → 3s（更快重试）
- **429 限流：** 优先读取 `Retry-After` 响应头（最大等待 60s），无该头则 10s → 15s → 20s
- **超出预定义范围：** 指数退避 `min(1000 × 2^n, 30000)ms`，加 ±20% 随机抖动防惊群

### 1.3 各处理器重试配置

| 处理器 | 环境变量 | 默认最大重试 | 特殊规则 |
|--------|---------|-------------|---------|
| Anthropic Chat | `MAX_RETRIES` | 3 | 流已开始接收数据则不重试（避免重复输出） |
| OpenAI Chat | `MAX_RETRIES` | 3 | 多路径 fallback + 网络重试 |
| Completions | `MAX_COMPLETION_RETRIES` | 2 | — |
| Web Search | `MAX_WEBSEARCH_RETRIES` | 1 | — |
| Embeddings | `MAX_EMBEDDINGS_RETRIES` | 2 | 失败后降级到 hash fallback |

### 1.4 通用重试包装器

提供两种风格供各模块使用：

- **`retryWithBackoff(fn, options)`** — Promise/async 风格，适合简单的请求-响应场景
- **`retryHttpRequest(requestFn, options)`** — 回调风格，适合需要精细控制的 HTTP 请求

---

## 2. 心跳保活（Heartbeat）

**位置：** `src/proxy/handlers/chat.js` — `createStreamLifecycle()` 内的 `startHeartbeat()`

### 问题

上游 LLM（尤其是 thinking 模型）可能长时间思考后才开始输出。在此期间 SSE 流无数据，
Devin 客户端（或中间的 HTTP 代理/负载均衡器）可能因为空闲超时而主动断开连接。

### 解决

启动心跳后，**每 3 秒**检查一次：若距上次写入已超过 3 秒，则向客户端发送一个
**空内容的 text delta** 包（`buildTextDelta(messageId, '', 0)`）。

客户端收到的是协议合法的空增量，不会显示任何内容，但 HTTP 层认为连接仍然活跃。

```
client ←── empty delta ←── proxy（每3秒） ←── [等待上游思考] ←── Claude API
```

---

## 3. HTTP 长连接池（Keep-Alive Agent）

**位置：** `src/proxy/handlers/chat.js`

```js
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,  // 60s TCP keepalive 探测
  maxSockets: 30,         // 最大并发连接数
  maxFreeSockets: 5,      // 空闲连接保留数
});
```

所有到上游 API 的 HTTPS 请求共享此连接池，**复用 TCP/TLS 连接**：
- 减少 TLS 握手开销和连接建立失败概率
- 空闲连接保持 60 秒，避免频繁的连接/断开循环

---

## 4. SSE 空闲超时检测

**位置：** `src/proxy/handlers/chat.js`

| 参数 | 环境变量 | 默认值 | 说明 |
|------|---------|-------|------|
| 请求超时 | `OPENAI_REQUEST_TIMEOUT_MS` | 300000 (5min) | 整个请求无任何响应 |
| 请求超时 | `ANTHROPIC_REQUEST_TIMEOUT_MS` | 300000 (5min) | 同上（Anthropic 路由） |
| 流空闲超时 | `OPENAI_SSE_IDLE_TIMEOUT_MS` | 180000 (3min) | 流开始后无新数据 |
| 流空闲超时 | `ANTHROPIC_SSE_IDLE_TIMEOUT_MS` | 180000 (3min) | 同上（Anthropic 路由） |

**行为：**
- 超时后销毁上游连接，触发错误处理路径
- 若符合重试条件（未超过最大次数 + 流未开始），自动重试
- 避免"上游 API 挂起不返回"导致的无限等待

---

## 5. 熔断器（Circuit Breaker）

**位置：** `src/proxy/retry-utils.js` — `CircuitBreaker` 类

经典的三态熔断模式，防止上游彻底不可用时无意义的重试浪费资源并加剧上游压力：

```
CLOSED ──(连续N次失败)──→ OPEN ──(等待resetTimeout)──→ HALF_OPEN
  ↑                                                        │
  └──────────────(试探请求成功)────────────────────────────┘
```

### 各服务熔断配置

| 服务 | 失败阈值 | 恢复等待 |
|------|---------|---------|
| Anthropic | 10 次连续失败 | 60 秒 |
| OpenAI | 10 次连续失败 | 60 秒 |
| Voyage (Embeddings) | 5 次连续失败 | 30 秒 |
| DuckDuckGo (Web Search) | 5 次连续失败 | 30 秒 |

**OPEN 状态：** 直接拒绝请求，返回 `[Circuit Breaker Open]` 错误，不再向上游发送。
**HALF_OPEN 状态：** 放行少量试探请求，成功则恢复 CLOSED。

---

## 6. WebSocket 保活

**位置：** `src/proxy/ws-bridge.js`

```js
arg1.setKeepAlive(true, 30000);  // 30s TCP keepalive 探测
```

WS 桥接层开启 TCP 层 keepalive，每 30 秒发送探测包，
防止底层 TCP 连接被 NAT 设备、防火墙或操作系统静默回收。

---

## 7. API 路径 Fallback

**位置：** `src/proxy/handlers/chat.js` — `streamOpenAI()` 内的 `fn2()` 闭包

OpenAI 路由支持**多路径降级**，不仅仅是"同一请求重发"，而是换一种协议再试：

1. 优先尝试 `/v1/responses`（OpenAI Responses API）
2. 被拒 → 自动降级到 `/v1/chat/completions`（Chat Completions API）
3. Gemini thinking 字段不兼容 → 去掉 `thinking_config` 再试

降级结果会被缓存（Gateway Capability），后续请求直接走兼容路径，避免重复试错。

### Anthropic Prompt Cache Fallback

Anthropic 路由在启用 prompt cache 时，若网关不支持 `cache_control`：
- 标记该网关不支持 prompt cache
- 立即**无缓存重试**（不计入重试次数/熔断）
- 后续请求自动跳过 cache_control 注入

---

## 机制协作总览

```
  Devin Client
       │
       ▼
  ┌─────────────────────────────────────┐
  │  BYOK Proxy                         │
  │                                     │
  │  ① 心跳保活（3s 空 delta）           │  ← 防止客户端断开
  │  ② WebSocket keepalive（30s）        │  ← 防止 TCP 被回收
  │                                     │
  │  ┌───────────────────────────────┐  │
  │  │  请求发送层                    │  │
  │  │  ③ Keep-Alive 连接池           │  │  ← 复用 TCP/TLS
  │  │  ④ SSE 空闲超时检测            │  │  ← 发现挂起
  │  │  ⑤ 自动重试 + 指数退避         │  │  ← 消化瞬态故障
  │  │  ⑥ API 路径 Fallback           │  │  ← 协议兼容降级
  │  │  ⑦ 熔断器                      │  │  ← 防止雪崩
  │  └───────────────────────────────┘  │
  └─────────────────────────────────────┘
       │
       ▼
  Upstream LLM API (Claude / OpenAI / Gemini / ...)
```

**最终效果：** 网络抖动、上游临时过载、长时间思考等场景对用户完全透明，
对话不会因为单次瞬态故障而中断。
