# 空流修复与日志诊断补全 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「上游回 200 但零内容」的空流不再被伪装成正常结束（改为重试 2 次、耗尽后明确报错），并补齐 503 与断流的诊断信息，配一个只读日志聚合脚本。

**Architecture:** 判定逻辑外移到纯函数模块 `stream-end.js`；`chat.js` 的流结束回调只做分流；`createStreamLifecycle` 搬到独立模块并补 `detach()` 以避免重试时心跳与监听叠加；所有新增日志字段同步 `log-writer.js` 的白名单。

**Tech Stack:** Node.js ESM（`src/proxy/**` 为 ESM，扩展侧 `src/managers/**` 为 CJS）、`node --test` 内建测试运行器、无第三方测试库。

**Spec:** `docs/superpowers/specs/2026-07-30-empty-stream-and-log-diagnostics-design.md`

**分支:** `fix/empty-stream-and-log-diagnostics`（已创建，spec 已提交 `39c8ab2` / `d251984`）

---

## 通用约定

- **测试命令**：全量 `npm test`；单文件 `node --test test/unit/<name>.test.mjs`。
- **语法自检**：改完任一 `src/proxy/**` 文件后跑 `node --check <file>`（该目录为 ESM，`node --check` 对 `.js` 默认按 CJS 解析会误报 import 错误，因此统一用 `node --input-type=module --check` 的替代做法：直接 `node -e "import('./src/proxy/handlers/xxx.js').then(()=>console.log('OK'))"`）。
- **提交粒度**：每个 Task 结束提交一次，消息格式 `<emoji> v0.0.N <中文描述>`（延续本主题的版本号，spec 已用到 v0.0.2）。
- **禁止**：不得改动 `shouldRetryAnthropicRequest` / `isRetriableError` / `calculateRetryDelay` / 熔断阈值（spec 第 7 节不变量 1）。

## 文件结构

| 文件 | 责任 | 动作 |
| --- | --- | --- |
| `src/proxy/handlers/stream-lifecycle.js` | 客户端响应的写入与资源生命周期（心跳、finalize、fail、detach） | 新建（从 `chat.js` 搬迁） |
| `src/proxy/handlers/stream-end.js` | 判定流是怎么结束的 + 空流是否该重试（纯函数） | 新建 |
| `src/proxy/handlers/anthropic-stream.js` | 新增 `emittedContent` 标记与 getter | 修改 |
| `src/proxy/logging/anomaly.js` | 新增 3 个 code 与 severity 映射 | 修改 |
| `src/proxy/logging/log-writer.js` | `ALLOWED_FIELDS` 增补新字段与 `turn_start` | 修改 |
| `src/proxy/handlers/chat.js` | 只做分流与调用；移除 `createStreamLifecycle` 定义 | 修改 |
| `scripts/analyze-logs.mjs` | 只读日志聚合报告（4 个纯函数 + 组合） | 新建 |
| `test/unit/stream-lifecycle.test.mjs` | detach / finalize / fail 行为 | 新建 |
| `test/unit/stream-end.test.mjs` | 四种分类与重试判定 | 新建 |
| `test/unit/empty-stream-marker.test.mjs` | processor 的 `emittedContent` 语义 | 新建 |
| `test/unit/analyze-logs.test.mjs` | 聚合纯函数 | 新建 |
| `test/unit/anomaly.test.mjs` | 扩充新 code 断言 | 修改 |
| `test/unit/log-writer.test.mjs` | 断言新字段可落盘 | 修改 |

---

## Task 1: 把 createStreamLifecycle 搬到独立模块（纯搬迁，零行为变更）

**Files:**
- Create: `src/proxy/handlers/stream-lifecycle.js`
- Modify: `src/proxy/handlers/chat.js:698-791`（删除函数定义）、`chat.js:1-67`（加 import）

- [ ] **Step 1: 新建 `src/proxy/handlers/stream-lifecycle.js`**

函数体与 `chat.js:698-791` **逐字符相同**，只补模块 import 与 `export`。不要顺手重命名 `arg0`/`tmp5` 之类的混淆标识符 —— 本步的价值就在于 diff 可逐行核对。

```js
// 客户端响应的写入与资源生命周期：心跳、幂等收尾、失败收尾、客户端断开侦测。
// 从 chat.js 原样搬迁（见 spec 3.5），除后续新增的 detach() 外不改任何逻辑。
import { buildErrorChunk, buildStopChunk, buildTextDelta, STOP_REASON } from './build-response.js';
import { endOfStreamEnvelope, wrapEnvelope } from '../connect.js';

export function createStreamLifecycle(arg0, fn, arg2, arg3, arg4, tmp0 = {}) {
  const suppressErrorBody = tmp0.suppressErrorBody === true;
  let tmp5 = false;
  let tmp6 = false;
  let tmp7 = null;
  let tmp8 = Date.now();
  const tmp9 = 3000;
  const tmp10 = () => {
    if (tmp7) {
      return;
    }
    tmp7 = setInterval(() => {
      if (tmp6 || arg0.writableEnded || tmp5) {
        clearInterval(tmp7);
        tmp7 = null;
        return;
      }
      if (Date.now() - tmp8 >= tmp9) {
        arg0.write(wrapEnvelope(buildTextDelta(arg3, '', 0)));
      }
    }, tmp9);
  };
  const fn2 = () => {
    if (tmp7) {
      clearInterval(tmp7);
      tmp7 = null;
    }
  };
  const fn3 = (arg02) => {
    if (!arg0.writableEnded && !tmp5) {
      if (arg4) {
        arg4.mark('first_windsurf_write');
      }
      arg0.write(arg02);
      tmp8 = Date.now();
    }
  };
  const fn4 = (arg02) => {
    if (tmp6 || arg0.writableEnded || tmp5) {
      return false;
    }
    tmp6 = true;
    fn2();
    fn3(endOfStreamEnvelope());
    arg0.end();
    if (arg02) {
      console.log(arg02);
    }
    if (arg4) {
      arg4.summary('finalized');
    }
    return true;
  };
  const tmp14 = (arg02, arg1) => {
    if (tmp5 || arg0.writableEnded) {
      return false;
    }
    if (arg02) {
      if (suppressErrorBody) {
        // 辅助请求（如标题/摘要生成）失败：只发无正文的 ERROR 停止块，
        // 避免错误文案被 Devin 当作正文写入会话标题。
        fn3(wrapEnvelope(buildStopChunk(arg3, STOP_REASON.ERROR)));
        console.log('  🛡️  Suppressed error body for auxiliary request: ' + arg02);
      } else {
        fn3(wrapEnvelope(buildErrorChunk(arg3, arg02)));
      }
    }
    return fn4(arg1);
  };
  arg0.on('close', () => {
    if (arg0.writableEnded || tmp5) {
      return;
    }
    tmp5 = true;
    tmp6 = true;
    fn2();
    const tmp02 = fn();
    if (tmp02 && !tmp02.destroyed) {
      console.log('  ℹ️  Client disconnected, stopping ' + arg2 + ' upstream stream');
      if (arg4) {
        arg4.summary('client_disconnected');
      }
      tmp02.destroy();
    }
  });
  const tmp15 = {
    safeWrite: fn3,
    finalize: fn4,
    fail: tmp14,
    startHeartbeat: tmp10,
    wasClosedByClient: () => tmp5,
  };
  return tmp15;
}
```

- [ ] **Step 2: 从 `chat.js` 删除原函数定义**

删除 `chat.js` 第 698 行 `function createStreamLifecycle(arg0, fn, arg2, arg3, arg4, tmp0 = {}) {` 到第 791 行 `}` 的整段（即 `isAuxiliaryRequest` 结束之后、`function shouldForwardOpenAITools` 之前的全部内容）。

- [ ] **Step 3: 在 `chat.js` 加 import**

在第 67 行 `import { Anomaly } from '../logging/anomaly.js';` 之后追加一行：

```js
import { createStreamLifecycle } from './stream-lifecycle.js';
```

- [ ] **Step 4: 验证模块可加载且无残留引用**

Run:
```bash
node -e "import('./src/proxy/handlers/chat.js').then(()=>console.log('chat OK'))"
node -e "import('./src/proxy/handlers/stream-lifecycle.js').then(m=>console.log('lifecycle OK', typeof m.createStreamLifecycle))"
```
Expected: `chat OK` 与 `lifecycle OK function`

Run:
```bash
git grep -n "function createStreamLifecycle" -- src
```
Expected: 只有 `src/proxy/handlers/stream-lifecycle.js` 一处命中。

- [ ] **Step 5: 全量回归（搬迁不得改变任何行为）**

Run: `npm test`
Expected: 与搬迁前同样的通过数；不得出现新失败。

> 已知预存失败：`sidebarTemplate.test.mjs` 可能报 `renderSidebarHtml is not a function`（与本改动无关）。记录基线，只要失败集合不变即视为通过。

- [ ] **Step 6: 提交**

```bash
git add src/proxy/handlers/stream-lifecycle.js src/proxy/handlers/chat.js
git commit -m "♻️ v0.0.3 流生命周期搬迁到独立模块"
```

---

## Task 2: 给 lifecycle 加 detach()，修掉重试时的心跳与监听叠加

**背景（spec 3.5）**：心跳 `setInterval` 只在自己的回调里自检 `finalized || writableEnded || closedByClient` 才 `clearInterval`。空流重试既不 `finalize` 也不 `fail`，三者都不成立 → 旧心跳会一直每 3 秒往客户端写空 delta；同时每次重建 lifecycle 都会给同一个响应对象再挂一个 `close` 监听。

**Files:**
- Test: `test/unit/stream-lifecycle.test.mjs`（新建）
- Modify: `src/proxy/handlers/stream-lifecycle.js`
- Modify: `src/proxy/handlers/chat.js:1524`（prompt cache 重试递归前调用 `detach()`）

- [ ] **Step 1: 写失败测试**

创建 `test/unit/stream-lifecycle.test.mjs`：

```js
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStreamLifecycle } from "../../src/proxy/handlers/stream-lifecycle.js";

// 假客户端响应：只需要 write / end / writableEnded / on('close')
function fakeRes() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.written = [];
  res.write = (chunk) => {
    res.written.push(chunk);
    return true;
  };
  res.end = () => {
    res.writableEnded = true;
  };
  return res;
}

function makeLifecycle(res) {
  // 参数顺序：(clientRes, getUpstreamReq, providerLabel, messageId, timing, options)
  return createStreamLifecycle(res, () => null, "Anthropic", "msg_1", null);
}

test("detach 后心跳不再向客户端写入", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  try {
    const res = fakeRes();
    const lc = makeLifecycle(res);
    lc.startHeartbeat();
    mock.timers.tick(3100);
    const afterFirstTick = res.written.length;
    assert.ok(afterFirstTick >= 1, "心跳应至少写出一次");
    lc.detach();
    mock.timers.tick(12000);
    assert.equal(res.written.length, afterFirstTick, "detach 后不应再有写入");
  } finally {
    mock.timers.reset();
  }
});

test("detach 后 close 监听归零，且重复调用幂等不抛", () => {
  const res = fakeRes();
  const lc = makeLifecycle(res);
  assert.equal(res.listenerCount("close"), 1);
  lc.detach();
  assert.equal(res.listenerCount("close"), 0);
  assert.doesNotThrow(() => lc.detach());
});

test("多次重建 lifecycle 且每次 detach 时监听不累积", () => {
  const res = fakeRes();
  for (let i = 0; i < 3; i++) {
    const lc = makeLifecycle(res);
    lc.detach();
  }
  const lc = makeLifecycle(res);
  assert.equal(res.listenerCount("close"), 1, "同一响应上只应有一个活跃 close 监听");
  lc.detach();
});

test("finalize 幂等：第二次返回 false", () => {
  const res = fakeRes();
  const lc = makeLifecycle(res);
  assert.equal(lc.finalize(), true);
  assert.equal(lc.finalize(), false);
  assert.equal(res.writableEnded, true);
});

test("fail 写出错误块并收尾，重复调用返回 false", () => {
  const res = fakeRes();
  const lc = makeLifecycle(res);
  assert.equal(lc.fail("[Anthropic Empty Stream]"), true);
  assert.ok(res.written.length >= 2, "应写出错误块与结束包");
  assert.equal(lc.fail("again"), false);
});

test("客户端 close 后 wasClosedByClient 为真", () => {
  const res = fakeRes();
  const lc = makeLifecycle(res);
  assert.equal(lc.wasClosedByClient(), false);
  res.emit("close");
  assert.equal(lc.wasClosedByClient(), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/unit/stream-lifecycle.test.mjs`
Expected: FAIL，`lc.detach is not a function`（前两个 `detach` 用例失败，`finalize`/`fail`/`close` 用例应已通过）

- [ ] **Step 3: 实现 detach()**

在 `src/proxy/handlers/stream-lifecycle.js` 里把匿名的 `close` 监听改成具名函数并新增 `detach`。三处改动：

把
```js
  arg0.on('close', () => {
```
改为
```js
  const onClientClose = () => {
```

把该回调结尾的
```js
  });
```
改为
```js
  };
  arg0.on('close', onClientClose);
  // 重试路径既不 finalize 也不 fail，必须由调用方显式回收资源，
  // 否则旧心跳会持续写入、close 监听会随重试累积（见 spec 3.5）。
  const detach = () => {
    fn2();
    arg0.removeListener('close', onClientClose);
  };
```

在返回对象里加一项：
```js
  const tmp15 = {
    safeWrite: fn3,
    finalize: fn4,
    fail: tmp14,
    startHeartbeat: tmp10,
    detach,
    wasClosedByClient: () => tmp5,
  };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/unit/stream-lifecycle.test.mjs`
Expected: PASS（6 个用例全通过）

- [ ] **Step 5: prompt cache 重试路径补 detach()**

`chat.js` 里 prompt cache 不支持时的无缓存重试（原第 1517-1524 行附近）在递归 `streamAnthropic(` 之前插入一行。改动后应为：

```js
            console.log(
              '  ↩️  Anthropic prompt cache unsupported — retrying without cache_control'
            );
            emitStreamStatus(
              'retry',
              'Anthropic prompt cache unsupported — retrying without cache_control'
            );
            tmp18.detach();
            streamAnthropic(
```

- [ ] **Step 6: 验证加载与全量回归**

Run:
```bash
node -e "import('./src/proxy/handlers/chat.js').then(()=>console.log('chat OK'))"
npm test
```
Expected: `chat OK`；失败集合与 Task 1 基线一致。

- [ ] **Step 7: 提交**

```bash
git add src/proxy/handlers/stream-lifecycle.js src/proxy/handlers/chat.js test/unit/stream-lifecycle.test.mjs
git commit -m "🐛 v0.0.4 流生命周期新增detach修复重试资源叠加"
```

---

## Task 3: 新增 stream-end.js（流结束分类 + 空流重试判定）

**Files:**
- Test: `test/unit/stream-end.test.mjs`（新建）
- Create: `src/proxy/handlers/stream-end.js`

- [ ] **Step 1: 写失败测试**

创建 `test/unit/stream-end.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamEnd, classifyStreamEnd, shouldRetry } from "../../src/proxy/handlers/stream-end.js";

test("StreamEnd 是冻结常量", () => {
  assert.equal(StreamEnd.CLOSED, "closed");
  assert.equal(StreamEnd.NORMAL, "normal");
  assert.equal(StreamEnd.EMPTY, "empty");
  assert.equal(StreamEnd.PARTIAL, "partial");
  assert.ok(Object.isFrozen(StreamEnd));
});

test("收到终止事件 → NORMAL", () => {
  assert.equal(
    classifyStreamEnd({ isDone: true, emittedContent: true, closedByClient: false }),
    StreamEnd.NORMAL
  );
  assert.equal(
    classifyStreamEnd({ isDone: true, emittedContent: false, closedByClient: false }),
    StreamEnd.NORMAL
  );
});

test("无终止事件且零内容写出 → EMPTY", () => {
  assert.equal(
    classifyStreamEnd({ isDone: false, emittedContent: false, closedByClient: false }),
    StreamEnd.EMPTY
  );
});

test("无终止事件但已写出内容 → PARTIAL", () => {
  assert.equal(
    classifyStreamEnd({ isDone: false, emittedContent: true, closedByClient: false }),
    StreamEnd.PARTIAL
  );
});

test("closedByClient 优先于其它条件", () => {
  assert.equal(
    classifyStreamEnd({ isDone: false, emittedContent: false, closedByClient: true }),
    StreamEnd.CLOSED
  );
  assert.equal(
    classifyStreamEnd({ isDone: true, emittedContent: true, closedByClient: true }),
    StreamEnd.CLOSED
  );
});

test("畸形入参一律返回最保守的 PARTIAL 且不抛", () => {
  assert.equal(classifyStreamEnd(undefined), StreamEnd.PARTIAL);
  assert.equal(classifyStreamEnd(null), StreamEnd.PARTIAL);
  assert.equal(classifyStreamEnd("nope"), StreamEnd.PARTIAL);
  assert.equal(classifyStreamEnd([1, 2]), StreamEnd.PARTIAL);
});

test("只有 EMPTY 且未达上限才重试", () => {
  assert.equal(shouldRetry(StreamEnd.EMPTY, 0, 2), true);
  assert.equal(shouldRetry(StreamEnd.EMPTY, 1, 2), true);
  assert.equal(shouldRetry(StreamEnd.EMPTY, 2, 2), false);
  assert.equal(shouldRetry(StreamEnd.EMPTY, 3, 2), false);
});

test("非 EMPTY 一律不重试", () => {
  for (const kind of [StreamEnd.NORMAL, StreamEnd.PARTIAL, StreamEnd.CLOSED, "weird", undefined]) {
    assert.equal(shouldRetry(kind, 0, 2), false, String(kind) + " 不应重试");
  }
});

test("max=0 表示关闭空流重试", () => {
  assert.equal(shouldRetry(StreamEnd.EMPTY, 0, 0), false);
});

test("非数字入参不抛且不重试", () => {
  assert.equal(shouldRetry(StreamEnd.EMPTY, "x", 2), false);
  assert.equal(shouldRetry(StreamEnd.EMPTY, 0, undefined), false);
  assert.equal(shouldRetry(StreamEnd.EMPTY, NaN, NaN), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/unit/stream-end.test.mjs`
Expected: FAIL，`Cannot find module .../stream-end.js`

- [ ] **Step 3: 实现模块**

创建 `src/proxy/handlers/stream-end.js`：

```js
// 判定「流是怎么结束的」，以及空流是否还该重试。
// 纯函数，不 import 任何业务模块（见 spec 3.2 / 第 7 节不变量 5）。
// 任何畸形入参都返回最保守的 PARTIAL —— PARTIAL 既不重试也不报错，
// 与改造前的行为完全一致，因此误判时最坏结果是「维持现状」。

export const StreamEnd = Object.freeze({
  CLOSED: 'closed', // 客户端主动关闭
  NORMAL: 'normal', // 收到终止事件
  EMPTY: 'empty', // 无终止事件且零内容写出
  PARTIAL: 'partial', // 无终止事件但已写出内容
});

export function classifyStreamEnd(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return StreamEnd.PARTIAL;
  }
  if (state.closedByClient === true) {
    return StreamEnd.CLOSED;
  }
  if (state.isDone === true) {
    return StreamEnd.NORMAL;
  }
  return state.emittedContent === true ? StreamEnd.PARTIAL : StreamEnd.EMPTY;
}

export function shouldRetry(kind, attempt, max) {
  if (kind !== StreamEnd.EMPTY) {
    return false;
  }
  const done = Number(attempt);
  const limit = Number(max);
  if (!Number.isFinite(done) || !Number.isFinite(limit)) {
    return false;
  }
  return done < limit;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/unit/stream-end.test.mjs`
Expected: PASS（10 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/proxy/handlers/stream-end.js test/unit/stream-end.test.mjs
git commit -m "✨ v0.0.5 新增流结束分类与空流重试判定"
```

---

## Task 4: Anthropic processor 记录「是否已向客户端写出内容」

**背景（spec 3.1）**：重试安全性只取决于「零内容写出」，不能用 `usage.output_tokens` 判断 —— 实测存在 `out=1`/`out=2` 的空流轮。

**Files:**
- Test: `test/unit/empty-stream-marker.test.mjs`（新建）
- Modify: `src/proxy/handlers/anthropic-stream.js:61-82`（构造函数）、`:96-98` 之后（getter）、`:198-209`（tool_use 写出）、`:225-234`（文本恢复出的工具调用）、`:278-285`（`_emitTextChunk`）

- [ ] **Step 1: 写失败测试**

创建 `test/unit/empty-stream-marker.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicStreamProcessor } from "../../src/proxy/handlers/anthropic-stream.js";

function newProcessor() {
  // 构造参数：(messageId, modelUid, targetId)
  return new AnthropicStreamProcessor("msg_1", "model_uid_1", null);
}

test("新建时 emittedContent 为 false", () => {
  assert.equal(newProcessor().emittedContent, false);
});

test("只有 message_start 的空流：emittedContent 仍为 false", () => {
  const p = newProcessor();
  p.processEvent({
    event: "message_start",
    data: { message: { usage: { input_tokens: 10, cache_creation_input_tokens: 19444 } } },
  });
  assert.equal(p.emittedContent, false);
  assert.equal(p.isDone, false);
});

test("文本 delta 写出后 emittedContent 为 true", () => {
  const p = newProcessor();
  p.processEvent({ event: "content_block_start", data: { index: 0, content_block: { type: "text" } } });
  p.processEvent({
    event: "content_block_delta",
    data: { index: 0, delta: { type: "text_delta", text: "hello world" } },
  });
  p.processEvent({ event: "content_block_stop", data: { index: 0 } });
  assert.equal(p.emittedContent, true);
});

test("tool_use 写出后 emittedContent 为 true", () => {
  const p = newProcessor();
  p.processEvent({
    event: "content_block_start",
    data: { index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read_file" } },
  });
  p.processEvent({
    event: "content_block_delta",
    data: { index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"a.js"}' } },
  });
  p.processEvent({ event: "content_block_stop", data: { index: 0 } });
  assert.equal(p.emittedContent, true);
  assert.deepEqual(p.getToolsCalled(), ["read_file"]);
});

test("thinking 块不算内容写出（客户端未收到正文）", () => {
  const p = newProcessor();
  p.processEvent({
    event: "content_block_start",
    data: { index: 0, content_block: { type: "thinking" } },
  });
  p.processEvent({
    event: "content_block_delta",
    data: { index: 0, delta: { type: "thinking_delta", thinking: "思考中" } },
  });
  assert.equal(p.emittedContent, false);
});

test("emittedContent 只增不减", () => {
  const p = newProcessor();
  p.processEvent({ event: "content_block_start", data: { index: 0, content_block: { type: "text" } } });
  p.processEvent({
    event: "content_block_delta",
    data: { index: 0, delta: { type: "text_delta", text: "x" } },
  });
  p.processEvent({ event: "content_block_stop", data: { index: 0 } });
  p.processEvent({ event: "message_stop", data: {} });
  assert.equal(p.emittedContent, true);
  assert.equal(p.isDone, true);
});
```

> 说明：`thinking` 用例断言的是「思考内容不构成可重试判定里的正文」。它走 `buildThinkingDelta`，不经过 `_emitTextChunk`，所以实现上天然为 false —— 这条测试的作用是把该语义钉住，防止以后有人顺手在 thinking 分支里也置标记，导致空流不再被识别。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/unit/empty-stream-marker.test.mjs`
Expected: FAIL，第一个用例即报 `expected undefined to equal false`（getter 不存在）

- [ ] **Step 3: 实现标记**

3 处改动，全部在 `src/proxy/handlers/anthropic-stream.js`：

(a) 构造函数末尾（`this._turnLog = null;` 之前）加一行：

```js
        this._emittedContent = false;
```

(b) 在 `getToolsCalled()` 之后加 getter：

```js
    // 是否已有任何正文/工具调用抵达客户端。只增不减。
    // 空流重试的安全前提就是它为 false（见 spec 3.1）。
    get emittedContent() {
        return this._emittedContent;
    }
```

(c) `_emitTextChunk` 内在计数之后置标记：

```js
    _emitTextChunk(tmp0, tmp1) {
        if (!tmp0) {
            return;
        }
        this._tokenCount++;
        this._emittedContent = true;
        tmp1.push(buildTextDelta(this._messageId, tmp0, this._tokenCount));
        emitAIText(tmp0, true, this._targetId);
    }
```

(d) `_onContentBlockStop` 的 tool_use 分支，在 `this._emittedToolCall = true;` 之后加一行：

```js
            this._emittedToolCall = true;
            this._emittedContent = true;
```

(e) `_onMessageStop` 里「从文本恢复工具调用」的分支，在 `this._stopReason = "tool_use";` 之前加一行：

```js
                this._emittedContent = true;
                this._stopReason = "tool_use";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/unit/empty-stream-marker.test.mjs`
Expected: PASS（6 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/proxy/handlers/anthropic-stream.js test/unit/empty-stream-marker.test.mjs
git commit -m "✨ v0.0.6 Anthropic流处理器记录内容写出标记"
```

---

## Task 5: anomaly 表新增 3 个代码

**Files:**
- Modify: `src/proxy/logging/anomaly.js:10-45`
- Modify: `test/unit/anomaly.test.mjs:12-25`（high 集合断言）、`:46-48`（总数断言）

- [ ] **Step 1: 先改测试（TDD：断言新契约）**

`test/unit/anomaly.test.mjs` 两处修改。

把「high 集合与 spec 第 6 节一致」整个用例替换为：

```js
test("high 集合与 spec 第 6 节一致", () => {
  const high = [
    Anomaly.STREAM_ABORTED,
    Anomaly.STREAM_ERROR,
    Anomaly.STREAM_IDLE_TIMEOUT,
    Anomaly.REQUEST_TIMEOUT,
    Anomaly.FORCED_STOP,
    Anomaly.UPSTREAM_ERROR_STATUS,
    Anomaly.EMPTY_STREAM,
    Anomaly.EMPTY_STREAM_EXHAUSTED,
  ];
  for (const code of high) {
    assert.equal(severityOf(code), Severity.HIGH, code + " 应为 high");
  }
  assert.equal(high.length, 8);
});
```

把「low 集合正确」用例替换为：

```js
test("low 集合正确", () => {
  assert.equal(severityOf(Anomaly.TOOL_NAME_AUTOCORRECTED), Severity.LOW);
  assert.equal(severityOf(Anomaly.TOOL_UNKNOWN_PASSTHROUGH), Severity.LOW);
  assert.equal(severityOf(Anomaly.CLIENT_CLOSED), Severity.LOW);
});
```

把总数用例替换为：

```js
test("共 17 个 anomaly 代码", () => {
  assert.equal(Object.keys(Anomaly).length, 17);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/unit/anomaly.test.mjs`
Expected: FAIL，`severityOf(undefined)` 返回 low 导致 high 断言失败，且总数断言 `14 !== 17`

- [ ] **Step 3: 实现新代码**

`src/proxy/logging/anomaly.js`。在 `Anomaly` 的 high 段落追加两项、low 段落追加一项：

```js
export const Anomaly = Object.freeze({
  // high — 断开场景
  STREAM_ABORTED: "stream_aborted",
  STREAM_ERROR: "stream_error",
  STREAM_IDLE_TIMEOUT: "stream_idle_timeout",
  REQUEST_TIMEOUT: "request_timeout",
  FORCED_STOP: "forced_stop",
  UPSTREAM_ERROR_STATUS: "upstream_error_status",
  EMPTY_STREAM: "empty_stream",
  EMPTY_STREAM_EXHAUSTED: "empty_stream_exhausted",
  // medium — 重试/熔断/工具降级
  RETRY: "retry",
  CIRCUIT_BREAKER: "circuit_breaker",
  TOOL_CALLS_DOWNGRADED: "tool_calls_downgraded",
  TOOLS_ALL_FILTERED: "tools_all_filtered",
  TOOL_RECOVERED_FROM_TEXT: "tool_recovered_from_text",
  TOOL_ARGS_INVALID_JSON: "tool_args_invalid_json",
  // low — 名称纠正/透传/客户端主动关闭
  TOOL_NAME_AUTOCORRECTED: "tool_name_autocorrected",
  TOOL_UNKNOWN_PASSTHROUGH: "tool_unknown_passthrough",
  CLIENT_CLOSED: "client_closed",
});
```

并在 `SEVERITY_BY_CODE` 里补三行：

```js
  [Anomaly.UPSTREAM_ERROR_STATUS]: Severity.HIGH,
  [Anomaly.EMPTY_STREAM]: Severity.HIGH,
  [Anomaly.EMPTY_STREAM_EXHAUSTED]: Severity.HIGH,
```

```js
  [Anomaly.TOOL_UNKNOWN_PASSTHROUGH]: Severity.LOW,
  [Anomaly.CLIENT_CLOSED]: Severity.LOW,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/unit/anomaly.test.mjs`
Expected: PASS（9 个用例，含「值与键一一对应且为 snake_case」自动覆盖新代码命名）

- [ ] **Step 5: 提交**

```bash
git add src/proxy/logging/anomaly.js test/unit/anomaly.test.mjs
git commit -m "✨ v0.0.7 新增空流与客户端关闭异常代码"
```

---

## Task 6: chat.js 按结束类型分流，空流改为重试 + 耗尽报错

这是本计划的核心改动。**只改 Anthropic 路**（OpenAI 路在 Task 8）。

**Files:**
- Modify: `src/proxy/handlers/chat.js`
  - `:1-68` 加 import
  - `:173-182` 附近加 3 个常量
  - `:1318-1342` streamAnthropic 参数与 `turnLog.set`
  - `:1429-1435` 之后新增 `retryOptions()`
  - `:1476` 附近加 `sseBytes` 声明
  - `:1524-1541`、`:1547-1566`、`:1693-1712`、`:1734-1753` 四处内联选项字面量替换为 `retryOptions()`
  - `:1616-1631` data 回调累计字节
  - `:1632-1658` end 回调重写为分流
  - `:1787-1802` `retryAnthropicRequest` 扩展

- [ ] **Step 1: 加 import 与常量**

在 `chat.js` 的 import 区末尾（`import { createStreamLifecycle } from './stream-lifecycle.js';` 之后）追加：

```js
import { StreamEnd, classifyStreamEnd, shouldRetry } from './stream-end.js';
```

在 `ANTHROPIC_SSE_IDLE_TIMEOUT_MS` 常量定义之后追加：

```js
// 空流（上游回 200 但零内容写出）专用重试通道。与 HTTP 层的 MAX_RETRIES 完全独立，
// 两者共用配额会挤掉 503 重试（实测 18/25 靠它自愈），见 spec 3.3。
const EMPTY_STREAM_MAX_RETRIES = parseInt(process.env.EMPTY_STREAM_MAX_RETRIES || '2', 10);
const EMPTY_STREAM_RETRY_DELAYS = [1000, 3000];
// 一轮内用于空流重试的总时长预算，从本轮起始计量。
const EMPTY_STREAM_BUDGET_MS = parseInt(process.env.EMPTY_STREAM_BUDGET_MS || '120000', 10);
```

- [ ] **Step 2: streamAnthropic 增加两个透传参数**

把 `:1318-1342` 的签名与 `turnLog.set` 改为：

```js
function streamAnthropic(
  arg0,
  arg1,
  {
    systemPrompt: tmp2,
    messages: tmp3,
    tools: tmp4,
    toolChoice: tmp5,
    resolvedModel: tmp6,
    messageId: tmp7,
    timing: tmp8,
    monitorTargetId: tmp9,
    thinkingOptions: tmp10,
    byokSlot: tmp11 = null,
    turnLog = null,
    emptyRetries = 0,
    turnStartedAt = Date.now(),
  },
  retryCount = 0
) {
  const tmp12 = getProviderConfig(tmp11).anthropic;
  turnLog?.set({
    route: 'anthropic',
    model: tmp6,
    byokSlot: tmp11,
    retryCount,
    emptyRetries,
    upstreamHost: tmp12.host,
  });
```

- [ ] **Step 3: 新增 retryOptions() 并替换四处内联字面量**

在 `logAnthropicUsage` 定义之后插入：

```js
  // 重发用的选项快照。HTTP 重试与空流重试共用同一个构造点，
  // 避免新增透传字段时漏改其中某一处（原来有 4 份重复的对象字面量）。
  const retryOptions = () => ({
    systemPrompt: tmp2,
    messages: tmp3,
    tools: tmp4,
    toolChoice: tmp5,
    resolvedModel: tmp6,
    messageId: tmp7,
    timing: tmp8,
    monitorTargetId: tmp9,
    thinkingOptions: tmp10,
    byokSlot: tmp11,
    turnLog,
    emptyRetries,
    turnStartedAt,
  });
```

然后把 4 处 `{ systemPrompt: tmp2, ... turnLog, }` 内联字面量全部替换为 `retryOptions()`：

1. prompt cache 无缓存重试：`streamAnthropic(arg0, arg1, retryOptions(), retryCount);`
2. 503/非 2xx 重试：`retryAnthropicRequest(arg0, arg1, retryOptions(), retryCount, arg02.statusCode, null);`
3. 请求超时重试：`retryAnthropicRequest(arg0, arg1, retryOptions(), retryCount, 0, timeoutError);`
4. 网络错误重试：`retryAnthropicRequest(arg0, arg1, retryOptions(), retryCount, 0, arg02);`

替换后跑一次 `git grep -n "systemPrompt: tmp2," -- src/proxy/handlers/chat.js`，预期只剩 `retryOptions` 内部那一处。

- [ ] **Step 4: 在函数作用域声明 sseBytes 并在 data 回调累计**

把 `:1476` 的
```js
  let hasReceivedData = false; // 标记是否接收到任何数据
```
改为
```js
  let hasReceivedData = false; // 标记是否接收到任何数据
  let sseBytes = 0; // 本次尝试收到的上游 SSE 字节数（空流判定与诊断用）
```

> 必须放在函数作用域而不是响应回调内：`finishTurnLog` 需要读它。

在 data 回调里累计（`hasReceivedData = true;` 之后一行）：

```js
      arg02.on('data', (arg03) => {
        hasReceivedData = true; // 标记已接收到数据
        sseBytes += Buffer.byteLength(arg03);
```

- [ ] **Step 5: 重写 end 回调为四路分流**

把 `:1632-1658` 的整个 `arg02.on('end', ...)` 替换为下面这一组「4 个短处理函数 + 一个分流器」。插入位置：紧跟在 `fn2();`（首次启动空闲计时器那行）之前，处理函数先定义，再是 `arg02.on('end')`。

```js
      const onNormalEnd = () => {
        circuitBreaker.recordSuccess(); // 成功请求，重置熔断器
        logAnthropicUsage();
        finishTurnLog();
        tmp18.finalize('  ✅ Stream ended normally');
      };
      const onPartialEnd = () => {
        // 已有内容抵达客户端但没收到 message_stop：维持既有行为（补一个终止事件收尾），
        // 绝不重试 —— 重发会导致文本重复。
        console.log('  ⚠️  Anthropic stream ended without message_stop — forcing stop');
        turnLog?.anomaly(
          Anomaly.FORCED_STOP,
          'no message_stop bytes=' + sseBytes + ' emittedContent=true'
        );
        for (const ev of processor.processEvent({ event: 'message_stop', data: {} })) {
          tmp18.safeWrite(wrapEnvelope(ev));
        }
        logAnthropicUsage();
        finishTurnLog();
        tmp18.finalize('  ✅ Stream ended (forced stop, partial content)');
      };
      const onEmptyEnd = () => {
        const detail =
          'attempt=' +
          emptyRetries +
          '/' +
          EMPTY_STREAM_MAX_RETRIES +
          ' host=' +
          tmp12.host +
          ' bytes=' +
          sseBytes;
        const elapsed = Date.now() - turnStartedAt;
        const delay =
          EMPTY_STREAM_RETRY_DELAYS[
            Math.min(emptyRetries, EMPTY_STREAM_RETRY_DELAYS.length - 1)
          ];
        const withinBudget = elapsed + delay <= EMPTY_STREAM_BUDGET_MS;
        if (shouldRetry(StreamEnd.EMPTY, emptyRetries, EMPTY_STREAM_MAX_RETRIES) && withinBudget) {
          console.log('  ⚠️  Anthropic returned an empty stream — retrying (' + detail + ')');
          turnLog?.anomaly(Anomaly.EMPTY_STREAM, detail);
          tmp18.detach(); // 必须：否则旧心跳与 close 监听会随重试叠加（spec 3.5）
          retryAnthropicRequest(arg0, arg1, retryOptions(), retryCount, 0, null, {
            reason: 'empty_stream',
            delayMs: delay,
          });
          return;
        }
        console.error(
          '  ❌ Anthropic empty stream, giving up (' + detail + ' elapsed=' + elapsed + 'ms)'
        );
        turnLog?.anomaly(Anomaly.EMPTY_STREAM_EXHAUSTED, detail + ' elapsed=' + elapsed + 'ms');
        logAnthropicUsage();
        finishTurnLog();
        // 关键：不再伪造 message_stop，改走失败通道。
        // 这样客户端拿到明确错误，emitChatEnd 也不会以自然结束语义触发完成声音。
        tmp18.fail('[Anthropic Empty Stream] 上游返回空响应（无任何内容），请重试');
      };
      const onClosedByClient = () => {
        // 用户点了停止：不是故障，不写错误块，只留一条低危记录与汇总
        turnLog?.anomaly(Anomaly.CLIENT_CLOSED, 'client closed during stream');
        finishTurnLog();
      };
      arg02.on('end', () => {
        tmp22 = true;
        fn();
        if (sseBuffer.trim()) {
          processPart(sseBuffer);
          sseBuffer = '';
        }
        if (arg1.writableEnded) {
          // 客户端响应已被更早的路径收尾（如 idle timeout 的 fail）：
          // 原代码在这里什么都不做，正是孤儿轮的来源之一。只补一条汇总。
          finishTurnLog();
          return;
        }
        const kind = classifyStreamEnd({
          isDone: processor.isDone,
          emittedContent: processor.emittedContent,
          closedByClient: tmp18.wasClosedByClient(),
        });
        if (kind === StreamEnd.CLOSED) {
          onClosedByClient();
        } else if (kind === StreamEnd.NORMAL) {
          onNormalEnd();
        } else if (kind === StreamEnd.EMPTY) {
          onEmptyEnd();
        } else {
          onPartialEnd();
        }
      });
```

> **有意不做的一件事**：空流耗尽时**不调用** `circuitBreaker.recordFailure()`。spec 第 2 节非目标里写明「不改熔断器阈值与状态机」，往里塞新的失败来源会改变熔断触发时机，属于本次不该扩的面。空流已由 `empty_stream_exhausted` 记录，需要时可另开一轮评估。

- [ ] **Step 6: 扩展 retryAnthropicRequest 为唯一重发入口**

把 `:1787-1802` 的整个函数替换为：

```js
// 唯一的 Anthropic 重发调度入口。两类重试共用它：
//   HTTP 层（503 / 超时 / 网络错误）→ 递增 retryCount，打 RETRY
//   空流（200 但零内容写出）        → 递增 options.emptyRetries，anomaly 由调用点负责
//     （调用点才拿得到 host 与已收字节数这些细节）
function retryAnthropicRequest(
  arg0,
  arg1,
  options,
  currentRetryCount,
  statusCode,
  error,
  extra = {}
) {
  const isEmptyStream = extra.reason === 'empty_stream';
  const delay = Number.isFinite(extra.delayMs)
    ? extra.delayMs
    : calculateRetryDelay(currentRetryCount, statusCode, {}, isTimeoutError(error));
  const nextRetryCount = isEmptyStream ? currentRetryCount : currentRetryCount + 1;
  const nextOptions = isEmptyStream
    ? { ...options, emptyRetries: (options?.emptyRetries || 0) + 1 }
    : options;
  const attemptLabel = isEmptyStream
    ? nextOptions.emptyRetries + '/' + EMPTY_STREAM_MAX_RETRIES
    : nextRetryCount + '/' + (process.env.MAX_RETRIES || 3);
  const errorDesc = isEmptyStream
    ? 'empty stream'
    : error?.code || error?.message || `HTTP ${statusCode}`;
  if (!isEmptyStream) {
    options?.turnLog?.anomaly(Anomaly.RETRY, 'anthropic ' + nextRetryCount + ': ' + errorDesc);
  }
  console.log(`  ↩️  [Anthropic] Retry ${attemptLabel} after ${delay}ms (${errorDesc})`);
  emitStreamStatus('retry', `Anthropic retry ${attemptLabel} after ${delay}ms (${errorDesc})`);

  setTimeout(() => {
    streamAnthropic(arg0, arg1, nextOptions, nextRetryCount);
  }, delay);
}
```

> 空流分支不递增 `retryCount`：两个计数器必须彼此独立，否则空流重试会吃掉 503 重试的配额（spec 3.3）。

- [ ] **Step 7: 验证加载 + 静态自查**

Run:
```bash
node -e "import('./src/proxy/handlers/chat.js').then(()=>console.log('chat OK'))"
git grep -n "no message_stop" -- src/proxy/handlers/chat.js
git grep -n "systemPrompt: tmp2," -- src/proxy/handlers/chat.js
```
Expected:
- `chat OK`
- `no message_stop` 只在 `onPartialEnd` 一处
- `systemPrompt: tmp2,` 只在 `retryOptions` 一处

- [ ] **Step 8: 全量回归**

Run: `npm test`
Expected: 失败集合与 Task 1 基线一致（本 Task 不新增单测，逻辑由 `stream-end.test.mjs` 与 Task 10 的假上游实机验证覆盖 —— 驱动 `streamAnthropic` 需要真实 HTTP 与槽位配置，做成单测的复杂度远高于它能提供的信心）。

- [ ] **Step 9: 提交**

```bash
git add src/proxy/handlers/chat.js
git commit -m "🐛 v0.0.8 空流改为重试并在耗尽后明确报错"
```

---

## Task 7: 补齐诊断信息（503 响应体 / idle timeout 打标 / client_closed / turn_start / 新字段）

**Files:**
- Modify: `src/proxy/handlers/chat.js`（6 处）
- Modify: `src/proxy/logging/log-writer.js:22-61`（`ALLOWED_FIELDS`）
- Test: `test/unit/log-writer-new-fields.test.mjs`（新建）

- [ ] **Step 1: 先写白名单的失败测试**

创建 `test/unit/log-writer-new-fields.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogWriter } from "../../src/proxy/logging/log-writer.js";
import { dailyFilePath } from "../../src/proxy/logging/log-file.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "byok-log-fields-"));
}

function readLines(dir) {
  const file = dailyFilePath(dir);
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const CONFIG = { logEnabled: true, logVerbose: false, logMaxMb: 10, logRetainDays: 7 };

test("chat_turn 的新字段不被白名单丢弃", () => {
  const dir = tempDir();
  const w = createLogWriter({ dir, proc: "hybrid", config: CONFIG });
  w.logEvent({
    type: "chat_turn",
    turnId: "t1",
    emittedContent: false,
    emptyRetries: 2,
    upstreamHost: "127.0.0.1:9090",
    sseBytes: 1234,
  });
  w.flushSync();
  const [line] = readLines(dir);
  assert.equal(line.emittedContent, false);
  assert.equal(line.emptyRetries, 2);
  assert.equal(line.upstreamHost, "127.0.0.1:9090");
  assert.equal(line.sseBytes, 1234);
});

test("turn_start 事件可落盘且带关联键", () => {
  const dir = tempDir();
  const w = createLogWriter({ dir, proc: "hybrid", config: CONFIG });
  w.logEvent({
    type: "turn_start",
    turnId: "t2",
    target: "default",
    initiator: "user",
    promptLen: 17404,
    model: "claude-opus-5",
    byokSlot: 4,
  });
  w.flushSync();
  const [line] = readLines(dir);
  assert.equal(line.type, "turn_start");
  assert.equal(line.turnId, "t2");
  assert.equal(line.initiator, "user");
  assert.equal(line.model, "claude-opus-5");
  assert.equal(line.byokSlot, 4);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/unit/log-writer-new-fields.test.mjs`
Expected: FAIL，第一个用例报 `undefined !== false`（`emittedContent` 等字段被白名单过滤掉）

- [ ] **Step 3: 扩充 ALLOWED_FIELDS**

`src/proxy/logging/log-writer.js`，在 `// chat_turn` 段落末尾（`"anomalies",` 之后）追加：

```js
  "anomalies",
  "emittedContent",
  "emptyRetries",
  "upstreamHost",
  "sseBytes",
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/unit/log-writer-new-fields.test.mjs`
Expected: PASS（2 个用例）

- [ ] **Step 5: 503 响应体落盘**

`chat.js` 非 2xx 分支：删除现有的
```js
        turnLog?.anomaly(Anomaly.UPSTREAM_ERROR_STATUS, String(arg02.statusCode));
```
把打标移到 body 读完之后（因为只有那时才拿得到原因）：

```js
        arg02.on('end', () => {
          const bodyText = sanitizeLogBody(tmp02);
          console.error('  ❌ Body: ' + bodyText);
          turnLog?.anomaly(
            Anomaly.UPSTREAM_ERROR_STATUS,
            'status=' +
              arg02.statusCode +
              ' host=' +
              tmp12.host +
              ' attempt=' +
              retryCount +
              ' body=' +
              String(bodyText).slice(0, 512)
          );
          const tmp03 = buildProviderErrorMessage('Anthropic', arg02.statusCode, tmp02);
```

- [ ] **Step 6: Anthropic 路 idle timeout 打标 + finish**

在空闲超时回调里（`console.error('  ❌ Anthropic stream stalled after ...')` 之后）补两行：

```js
          turnLog?.anomaly(
            Anomaly.STREAM_IDLE_TIMEOUT,
            'idle ' + ANTHROPIC_SSE_IDLE_TIMEOUT_MS + 'ms bytes=' + sseBytes
          );
          finishTurnLog();
          tmp18.fail('[Anthropic Stream Timeout]');
          arg02.destroy();
```

- [ ] **Step 7: 4 个 wasClosedByClient 早退点补 client_closed**

`arg02.on('aborted')`：
```js
        if (tmp18.wasClosedByClient()) {
          turnLog?.anomaly(Anomaly.CLIENT_CLOSED, 'client closed (aborted)');
          finishTurnLog();
          return;
        }
```

`arg02.on('error')`：
```js
        if (tmp18.wasClosedByClient()) {
          turnLog?.anomaly(Anomaly.CLIENT_CLOSED, 'client closed (stream error)');
          finishTurnLog();
          return;
        }
```

`tmp17.setTimeout(...)` 回调开头：
```js
    if (tmp18.wasClosedByClient()) {
      turnLog?.anomaly(Anomaly.CLIENT_CLOSED, 'client closed (request timeout)');
      finishTurnLog();
      return;
    }
```

`tmp17.on('error')` 的 ECONNRESET/ECONNABORTED 早退：
```js
    if (
      tmp18.wasClosedByClient() &&
      (arg02.code === 'ECONNRESET' || arg02.code === 'ECONNABORTED')
    ) {
      turnLog?.anomaly(Anomaly.CLIENT_CLOSED, 'client closed (' + arg02.code + ')');
      finishTurnLog();
      return;
    }
```

> `anomaly()` 与 `finish()` 都幂等且 finish 之后不再产生事件，所以多条路径先后触发不会重复落行。

- [ ] **Step 8: finishTurnLog 带上新字段**

把 `:1429-1435` 的 `finishTurnLog` 改为：

```js
  const finishTurnLog = () => {
    turnLog?.finish({
      stopReason: processor.stopReason,
      toolsCalled: processor.getToolsCalled(),
      usage: processor.getUsage(),
      emittedContent: processor.emittedContent,
      sseBytes,
    });
  };
```

- [ ] **Step 9: 落 turn_start 事件**

`chat.js` import 区追加：

```js
import { logEvent } from '../logging/log-writer.js';
```

`handleGetChatMessage` 里 `createTurnLog({...})` 之后紧跟：

```js
  // 一轮的起始记录。没有它，中途死掉的轮次只剩若干 anomaly（实测 4 个孤儿轮），
  // 也算不出「发起数 vs 完成数」。
  logEvent({
    type: 'turn_start',
    turnId: tmp9,
    target: tmp19,
    initiator: tmp8 || 'unknown',
    promptLen: tmp3.length,
    model: tmp11,
    byokSlot: effectiveSlot,
  });
```

> 不带 `route` / `upstreamHost`：此刻还没决定走 responses 还是 chat-completions，也还没取 provider 配置。这两个字段由 `chat_turn` 承载（spec 4.2 按此口径执行）。

- [ ] **Step 10: 验证与全量回归**

Run:
```bash
node -e "import('./src/proxy/handlers/chat.js').then(()=>console.log('chat OK'))"
node --test test/unit/log-writer.test.mjs test/unit/log-writer-new-fields.test.mjs
npm test
```
Expected: `chat OK`；log-writer 两个测试文件全绿；全量失败集合与基线一致。

- [ ] **Step 11: 提交**

```bash
git add src/proxy/handlers/chat.js src/proxy/logging/log-writer.js test/unit/log-writer-new-fields.test.mjs
git commit -m "🔊 v0.0.9 补齐503响应体与断流诊断字段"
```

---

## Task 8: OpenAI 路可区分空流（只打标，不改行为）

**范围说明**：OpenAI 路**不做**空流重试。原因是它没有 `retryAnthropicRequest` 那样的重发调度器，`attachOpenAISseStream` 也把响应流与 processor 绑在一起，补一条重发通道的改动量远大于 Anthropic 路，而当前实测流量里 OpenAI 路占比为 0。本 Task 只让它的空流在日志里可辨认：`forced_stop` 的 detail 带上 `emittedContent`，一条 grep 就能看出是「空流」还是「半截内容」。行为完全不变。

**Files:**
- Modify: `src/proxy/handlers/openai-stream.js`（两个 processor 各 2 处）
- Modify: `src/proxy/handlers/chat.js:1182-1193`（`attachOpenAISseStream` 的 forced stop 分支）

- [ ] **Step 1: 两个 processor 加 emittedContent**

`OpenAIStreamProcessor`（`:36`）与 `ChatCompletionsStreamProcessor`（`:351`）的构造函数各加一行：

```js
    this._emittedContent = false;
```

两个类各加一个 getter（放在已有的 `getToolsCalled()` 之后）：

```js
  get emittedContent() {
    return this._emittedContent;
  }
```

两个类的 `_emitTextChunk`（`:309-316` 与 `:543-550`）各加一行：

```js
  _emitTextChunk(tmp0, tmp1) {
    if (!tmp0) {
      return;
    }
    this._tokenCount++;
    this._emittedContent = true;
    tmp1.push(buildTextDelta(this._messageId, tmp0, this._tokenCount));
    emitAIText(tmp0, true, this._targetId);
  }
```

工具调用写出点：先枚举全部位置

Run: `git grep -n "push(buildToolCallDelta(" -- src/proxy/handlers/openai-stream.js`

在**每一处** `push(buildToolCallDelta(...));` 的下一行插入：

```js
        this._emittedContent = true;
```

- [ ] **Step 2: 校验没有漏改**

Run:
```bash
node -e "import('./src/proxy/handlers/openai-stream.js').then(()=>console.log('openai-stream OK'))"
git grep -c "_emittedContent = true" -- src/proxy/handlers/openai-stream.js
```
Expected: `openai-stream OK`；计数 = 2（两个 `_emitTextChunk`）+ 上一步枚举出的 `buildToolCallDelta` 处数。把这个数字记在提交说明里，便于日后核对。

- [ ] **Step 3: forced_stop detail 带上 emittedContent**

`chat.js` 的 `attachOpenAISseStream` 里，把
```js
      turnLog?.anomaly(Anomaly.FORCED_STOP, 'no terminal event');
```
改为
```js
      turnLog?.anomaly(
        Anomaly.FORCED_STOP,
        'no terminal event emittedContent=' + (tmp13.emittedContent === true)
      );
```

> `tmp13` 就是该函数入参里的 `processor`。两个 OpenAI processor 都已在 Step 1 提供 `emittedContent`，因此这里无需类型判断。

- [ ] **Step 4: 验证与全量回归**

Run:
```bash
node -e "import('./src/proxy/handlers/chat.js').then(()=>console.log('chat OK'))"
npm test
```
Expected: `chat OK`；失败集合与基线一致。

- [ ] **Step 5: 提交**

```bash
git add src/proxy/handlers/openai-stream.js src/proxy/handlers/chat.js
git commit -m "🔊 v0.0.10 OpenAI路空流在日志中可辨认"
```

---

## Task 9: 只读日志聚合脚本

**Files:**
- Test: `test/unit/analyze-logs.test.mjs`（新建）
- Create: `scripts/analyze-logs.mjs`
- Modify: `package.json:18-27`（加 `logs:report`）

- [ ] **Step 1: 写失败测试**

创建 `test/unit/analyze-logs.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLines,
  summarize,
  groupAnomalies,
  listBrokenTurns,
  recoveryRate,
  aggregate,
} from "../../scripts/analyze-logs.mjs";

const TS = 1785289894459;

function line(obj) {
  return JSON.stringify({ ts: TS, pid: 1, proc: "hybrid", ...obj });
}

const SAMPLE = [
  line({ type: "turn_start", turnId: "a", initiator: "user" }),
  line({ type: "chat_turn", turnId: "a", stopReason: "tool_use", anomalies: [] }),
  line({ type: "turn_start", turnId: "b", initiator: "agent" }),
  line({ type: "anomaly", turnId: "b", code: "empty_stream", severity: "high", detail: "attempt=0/2" }),
  line({ type: "anomaly", turnId: "b", code: "empty_stream_exhausted", severity: "high" }),
  line({
    type: "chat_turn",
    turnId: "b",
    stopReason: null,
    anomalies: ["empty_stream", "empty_stream_exhausted"],
  }),
  line({ type: "turn_start", turnId: "c", initiator: "agent" }),
  line({ type: "anomaly", turnId: "c", code: "upstream_error_status", severity: "high", detail: "status=503" }),
  line({ type: "anomaly", turnId: "c", code: "retry", severity: "medium" }),
  line({ type: "chat_turn", turnId: "c", stopReason: "tool_use", anomalies: ["upstream_error_status", "retry"] }),
  line({ type: "turn_start", turnId: "d", initiator: "agent" }), // 孤儿：无 chat_turn
];

test("parseLines 跳过坏行并计数", () => {
  const { events, malformed } = parseLines([...SAMPLE, "{not json", "", "  "]);
  assert.equal(events.length, SAMPLE.length);
  assert.equal(malformed, 1);
});

test("summarize 给出发起数/完成数/完成率/孤儿数", () => {
  const { events } = parseLines(SAMPLE);
  const s = summarize(events);
  assert.equal(s.turnStarts, 4);
  assert.equal(s.chatTurns, 3);
  assert.equal(s.orphans, 1);
  assert.equal(s.completionRate, "75.0%");
});

test("groupAnomalies 按 code 计数并保留 severity", () => {
  const { events } = parseLines(SAMPLE);
  const rows = groupAnomalies(events);
  const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
  assert.equal(byCode.empty_stream.count, 1);
  assert.equal(byCode.empty_stream.severity, "high");
  assert.equal(byCode.retry.count, 1);
  assert.equal(byCode.retry.severity, "medium");
});

test("listBrokenTurns 列出断开轮与孤儿轮", () => {
  const { events } = parseLines(SAMPLE);
  const broken = listBrokenTurns(events);
  const ids = broken.map((b) => b.turnId).sort();
  assert.deepEqual(ids, ["b", "d"]);
  assert.equal(broken.find((b) => b.turnId === "d").reason, "orphan");
});

test("recoveryRate 统计重试后是否恢复", () => {
  const { events } = parseLines(SAMPLE);
  const r = recoveryRate(events);
  // b 空流耗尽未恢复，c 503 重试后恢复
  assert.equal(r.attempted, 2);
  assert.equal(r.recovered, 1);
  assert.equal(r.rate, "50.0%");
});

test("aggregate 组合四部分且带 malformed", () => {
  const out = aggregate([...SAMPLE, "{broken"]);
  assert.equal(out.malformed, 1);
  assert.equal(out.summary.turnStarts, 4);
  assert.ok(Array.isArray(out.anomalies));
  assert.ok(Array.isArray(out.brokenTurns));
  assert.equal(out.recovery.attempted, 2);
});

test("空输入不抛且返回零值", () => {
  const out = aggregate([]);
  assert.equal(out.summary.turnStarts, 0);
  assert.equal(out.summary.completionRate, "n/a");
  assert.deepEqual(out.anomalies, []);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/unit/analyze-logs.test.mjs`
Expected: FAIL，`Cannot find module .../scripts/analyze-logs.mjs`

- [ ] **Step 3: 实现脚本**

创建 `scripts/analyze-logs.mjs`：

```js
#!/usr/bin/env node
// 只读日志聚合报告。绝不写、删、改任何日志文件（spec 第 7 节不变量 6）。
// 用法：npm run logs:report -- --date=2026-07-30 --days=3
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 断开类 anomaly：命中任一即视为该轮断开
const BROKEN_CODES = new Set([
  'empty_stream_exhausted',
  'circuit_breaker',
  'request_timeout',
  'stream_idle_timeout',
  'stream_aborted',
  'stream_error',
]);
// 触发过自愈尝试的 anomaly
const RETRY_CODES = new Set(['retry', 'empty_stream']);

export function parseLines(lines) {
  const events = [];
  let malformed = 0;
  for (const raw of lines || []) {
    const text = String(raw || '').trim();
    if (!text) {
      continue;
    }
    try {
      events.push(JSON.parse(text));
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

function pct(part, total) {
  if (!total) {
    return 'n/a';
  }
  return ((part / total) * 100).toFixed(1) + '%';
}

function turnIdsOf(events, type) {
  const set = new Set();
  for (const e of events) {
    if (e && e.type === type && e.turnId) {
      set.add(e.turnId);
    }
  }
  return set;
}

export function summarize(events) {
  const starts = turnIdsOf(events, 'turn_start');
  const turns = turnIdsOf(events, 'chat_turn');
  let orphans = 0;
  for (const id of starts) {
    if (!turns.has(id)) {
      orphans++;
    }
  }
  return {
    turnStarts: starts.size,
    chatTurns: turns.size,
    orphans,
    completionRate: pct(turns.size, starts.size),
  };
}

export function groupAnomalies(events) {
  const byCode = new Map();
  for (const e of events) {
    if (!e || e.type !== 'anomaly' || !e.code) {
      continue;
    }
    const row = byCode.get(e.code) || { code: e.code, severity: e.severity || 'low', count: 0 };
    row.count++;
    byCode.set(e.code, row);
  }
  return [...byCode.values()].sort((a, b) => b.count - a.count);
}

export function listBrokenTurns(events) {
  const out = [];
  const starts = turnIdsOf(events, 'turn_start');
  const turns = new Map();
  for (const e of events) {
    if (e && e.type === 'chat_turn' && e.turnId) {
      turns.set(e.turnId, e);
    }
  }
  for (const [turnId, turn] of turns) {
    const codes = Array.isArray(turn.anomalies) ? turn.anomalies : [];
    const hit = codes.find((c) => BROKEN_CODES.has(c));
    if (hit) {
      out.push({
        turnId,
        reason: hit,
        stopReason: turn.stopReason ?? null,
        retryCount: turn.retryCount ?? 0,
        emptyRetries: turn.emptyRetries ?? 0,
        upstreamHost: turn.upstreamHost ?? '',
        durationMs: turn.durationMs ?? 0,
      });
    }
  }
  for (const turnId of starts) {
    if (!turns.has(turnId)) {
      out.push({ turnId, reason: 'orphan' });
    }
  }
  return out;
}

export function recoveryRate(events) {
  let attempted = 0;
  let recovered = 0;
  for (const e of events) {
    if (!e || e.type !== 'chat_turn') {
      continue;
    }
    const codes = Array.isArray(e.anomalies) ? e.anomalies : [];
    if (!codes.some((c) => RETRY_CODES.has(c))) {
      continue;
    }
    attempted++;
    if (e.stopReason) {
      recovered++;
    }
  }
  return { attempted, recovered, rate: pct(recovered, attempted) };
}

export function aggregate(lines) {
  const { events, malformed } = parseLines(lines);
  return {
    malformed,
    summary: summarize(events),
    anomalies: groupAnomalies(events),
    brokenTurns: listBrokenTurns(events),
    recovery: recoveryRate(events),
  };
}

// ── 以下为脚本外壳：读文件 + 打印，不参与单测 ──

function logDir() {
  return path.join(os.homedir(), '.devin-byok-plus', 'logs');
}

function localDateOf(ts) {
  const d = new Date(Number(ts) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function utcDateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

// 文件名按 UTC 日期（log-file.js:24-29），本地日期 D 的事件可能落在
// proxy-D 与 proxy-(D-1) 两个文件里，因此两个都读，最后按 ts 的本地日期过滤。
function filesForLocalDates(dir, dates) {
  const wanted = new Set();
  for (const dateStr of dates) {
    const base = new Date(dateStr + 'T00:00:00');
    wanted.add(utcDateStr(base));
    wanted.add(utcDateStr(new Date(base.getTime() - 86400000)));
    wanted.add(utcDateStr(new Date(base.getTime() + 86400000)));
  }
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => {
      const m = /^proxy-(\d{4}-\d{2}-\d{2})(\.\d+)?\.jsonl$/.exec(n);
      return m && wanted.has(m[1]);
    })
    .map((n) => path.join(dir, n));
}

function parseArgs(argv) {
  const out = { date: localDateOf(Date.now()), days: 1 };
  for (const a of argv) {
    const m = /^--([a-z]+)=(.+)$/.exec(a);
    if (!m) {
      continue;
    }
    if (m[1] === 'date') {
      out.date = m[2];
    } else if (m[1] === 'days') {
      out.days = Math.max(1, parseInt(m[2], 10) || 1);
    }
  }
  return out;
}

function datesBack(dateStr, days) {
  const base = new Date(dateStr + 'T00:00:00');
  const list = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(base.getTime() - i * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    list.push(d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()));
  }
  return list;
}

function main() {
  const { date, days } = parseArgs(process.argv.slice(2));
  const dates = datesBack(date, days);
  const dir = logDir();
  const files = filesForLocalDates(dir, dates);
  if (files.length === 0) {
    console.log('未找到日志文件：' + dir);
    return;
  }
  const wantedDates = new Set(dates);
  const lines = [];
  for (const f of files) {
    for (const raw of fs.readFileSync(f, 'utf8').split('\n')) {
      const text = raw.trim();
      if (!text) {
        continue;
      }
      let ts = 0;
      const m = /"ts":(\d+)/.exec(text);
      if (m) {
        ts = Number(m[1]);
      }
      if (wantedDates.has(localDateOf(ts))) {
        lines.push(text);
      }
    }
  }
  const report = aggregate(lines);
  console.log('日期（本地）：' + dates.join(', '));
  console.log('文件：' + files.map((f) => path.basename(f)).join(', '));
  console.log('坏行：' + report.malformed);
  console.log('');
  console.log('── 概览 ──');
  console.log(
    '发起 ' +
      report.summary.turnStarts +
      ' / 完成 ' +
      report.summary.chatTurns +
      ' / 完成率 ' +
      report.summary.completionRate +
      ' / 孤儿轮 ' +
      report.summary.orphans
  );
  console.log('');
  console.log('── anomaly 分布 ──');
  for (const row of report.anomalies) {
    console.log('  ' + row.code.padEnd(24) + row.severity.padEnd(8) + row.count);
  }
  console.log('');
  console.log('── 自愈率（重试/空流重试后是否有 stopReason）──');
  console.log(
    '  ' + report.recovery.recovered + '/' + report.recovery.attempted + ' = ' + report.recovery.rate
  );
  console.log('');
  console.log('── 断开轮清单 ──');
  for (const b of report.brokenTurns) {
    if (b.reason === 'orphan') {
      console.log('  ' + b.turnId.slice(0, 8) + '  orphan（有始无终）');
      continue;
    }
    console.log(
      '  ' +
        b.turnId.slice(0, 8) +
        '  ' +
        b.reason.padEnd(24) +
        'stop=' +
        (b.stopReason ?? '-') +
        ' retry=' +
        b.retryCount +
        ' empty=' +
        b.emptyRetries +
        ' host=' +
        b.upstreamHost +
        ' dur=' +
        b.durationMs +
        'ms'
    );
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main();
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/unit/analyze-logs.test.mjs`
Expected: PASS（7 个用例）

- [ ] **Step 5: 加 npm 脚本入口**

`package.json` 的 `scripts` 里加一行（放在 `"test"` 之后）：

```json
    "logs:report": "node scripts/analyze-logs.mjs",
```

- [ ] **Step 6: 跑一次真实报告**

Run: `npm run logs:report`
Expected: 打印概览 / anomaly 分布 / 自愈率 / 断开轮清单。旧日志没有 `turn_start`，所以完成率会显示 `n/a` 且孤儿轮为 0 —— 这是预期的（不做旧格式兼容，spec 5.3）。

- [ ] **Step 7: 提交**

```bash
git add scripts/analyze-logs.mjs test/unit/analyze-logs.test.mjs package.json
git commit -m "✨ v0.0.11 新增日志聚合分析脚本"
```

---

## Task 10: 假上游实机验证 + 同步运行副本

**Files:**
- 临时文件（验证完删除，不入库）：`tmp-empty-upstream.mjs`
- 修改并恢复：`C:\Users\cz\.devin-byok-plus\.env`（`BYOK4_ANTHROPIC_API_HOST`）

⚠️ 本 Task 要动用户的 `.env` 与运行副本，每一步都必须先备份。

- [ ] **Step 1: 全量回归确认基线**

Run: `npm test`
Expected: 新增的 5 个测试文件（`stream-lifecycle` / `stream-end` / `empty-stream-marker` / `log-writer-new-fields` / `analyze-logs`）全绿，其余失败集合与 Task 1 记录的基线一致。

- [ ] **Step 2: 写假上游（复现空流）**

创建 `tmp-empty-upstream.mjs`（仓库根目录，验证后删除）：

```js
// 假 Anthropic 上游：回 200 + message_start 后立刻关流，一个字不产。
// 用来复现日志里那 11 个 forced_stop/no message_stop 轮。
import http from 'node:http';

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      console.log('收到请求 ' + req.method + ' ' + req.url + ' bytes=' + Buffer.byteLength(body));
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(
        'event: message_start\n' +
          'data: {"type":"message_start","message":{"id":"msg_fake","model":"claude-opus-5","usage":{"input_tokens":10,"cache_creation_input_tokens":19444}}}\n\n'
      );
      setTimeout(() => res.end(), 200);
    });
  })
  .listen(9099, '127.0.0.1', () => console.log('fake empty upstream → http://127.0.0.1:9099'));
```

Run: `node tmp-empty-upstream.mjs`（新开一个终端，保持运行）
Expected: 打印 `fake empty upstream → http://127.0.0.1:9099`

- [ ] **Step 3: 备份并临时改 .env 指向假上游**

Run（PowerShell）：
```powershell
Copy-Item "$env:USERPROFILE\.devin-byok-plus\.env" "$env:USERPROFILE\.devin-byok-plus\.env.emptystream-bak"
(Get-Content "$env:USERPROFILE\.devin-byok-plus\.env") -replace '^BYOK4_ANTHROPIC_API_HOST=.*$', 'BYOK4_ANTHROPIC_API_HOST=127.0.0.1:9099' | Set-Content "$env:USERPROFILE\.devin-byok-plus\.env"
Select-String -Path "$env:USERPROFILE\.devin-byok-plus\.env" -Pattern '^BYOK4_ANTHROPIC_API_HOST=' | ForEach-Object { $_.Line }
```
Expected: 输出 `BYOK4_ANTHROPIC_API_HOST=127.0.0.1:9099`，且备份文件存在。

- [ ] **Step 4: 同步改动到运行副本并重启客户端**

工作区 `src/proxy/**` 与运行副本 `proxy-scripts/src/**` 目录结构一一对应（少 `proxy` 这一层）。

Run（PowerShell，先备份再覆盖）：
```powershell
$dst = "$env:USERPROFILE\.windsurf\extensions\jornlin.devin-byok-plus-2.4.6\proxy-scripts\src"
Copy-Item $dst "$dst.emptystream-bak" -Recurse
Copy-Item "d:\repository\devin-byok-plus\src\proxy\handlers\stream-lifecycle.js" "$dst\handlers\"
Copy-Item "d:\repository\devin-byok-plus\src\proxy\handlers\stream-end.js" "$dst\handlers\"
Copy-Item "d:\repository\devin-byok-plus\src\proxy\handlers\chat.js" "$dst\handlers\"
Copy-Item "d:\repository\devin-byok-plus\src\proxy\handlers\anthropic-stream.js" "$dst\handlers\"
Copy-Item "d:\repository\devin-byok-plus\src\proxy\handlers\openai-stream.js" "$dst\handlers\"
Copy-Item "d:\repository\devin-byok-plus\src\proxy\logging\anomaly.js" "$dst\logging\"
Copy-Item "d:\repository\devin-byok-plus\src\proxy\logging\log-writer.js" "$dst\logging\"
```

然后**完全退出并重开客户端**（不是 reload window —— 代理是 spawn 出来的独立 node 子进程，只有完全重启才会重新加载源码）。

- [ ] **Step 5: 触发一轮对话并核对现象**

在客户端里选 BYOK4 模型随便发一条消息。预期观察到：

1. 输出面板出现两次 `⚠️  Anthropic returned an empty stream — retrying (attempt=0/2 ...)` 与 `attempt=1/2 ...`
2. 随后 `❌ Anthropic empty stream, giving up (...)`
3. 客户端显示明确错误「上游返回空响应（无任何内容），请重试」，**不是**空白回复
4. **完成声音不响**
5. 期间客户端界面没有反复抖动/重复空白（心跳没有叠加）

- [ ] **Step 6: 用报告核对日志**

Run: `npm run logs:report`
Expected：
- `anomaly 分布` 里出现 `empty_stream 2` 与 `empty_stream_exhausted 1`
- `断开轮清单` 里该轮 `reason=empty_stream_exhausted`、`empty=2`、`host=127.0.0.1:9099`
- 完成率不再是 `n/a`（`turn_start` 已生效），孤儿轮为 0

- [ ] **Step 7: 恢复 .env 与运行副本，删除临时文件**

Run（PowerShell）：
```powershell
Move-Item "$env:USERPROFILE\.devin-byok-plus\.env.emptystream-bak" "$env:USERPROFILE\.devin-byok-plus\.env" -Force
Select-String -Path "$env:USERPROFILE\.devin-byok-plus\.env" -Pattern '^BYOK4_ANTHROPIC_API_HOST=' | ForEach-Object { $_.Line }
Remove-Item "d:\repository\devin-byok-plus\tmp-empty-upstream.mjs"
```
Expected: 输出恢复为 `BYOK4_ANTHROPIC_API_HOST=127.0.0.1:9090`；临时脚本已删除；停掉 Step 2 的假上游进程。

> 运行副本的备份 `src.emptystream-bak` 先留着，等真实网关跑一天确认没问题再删。

- [ ] **Step 8: 真实网关下观察一轮**

保持修复后的运行副本，正常使用半天到一天，然后：

Run: `npm run logs:report`
Expected: 对比修复前的基线（`forced_stop 11` / `circuit_breaker 7` / 4 个孤儿轮），确认：
- `forced_stop` 大幅减少（原来 11 个里的空流轮现在归到 `empty_stream`，多数应在重试后恢复）
- 孤儿轮为 0
- `upstream_error_status` 的 detail 里能看到网关 503 的真实原因文本

- [ ] **Step 9: 收尾提交（若有验证期间的修补）**

```bash
git status --short
git add -A src test
git commit -m "✅ v0.0.12 空流修复实机验证与修补"
```
若验证期间无需修补，跳过本步。

---

## 计划自检

**Spec 覆盖核对**

| spec 章节 | 对应 Task |
| --- | --- |
| 3.1 emittedContent 判据 | Task 4 |
| 3.2 stream-end.js | Task 3 |
| 3.3 重试策略（独立计数/单入口/预算/状态隔离） | Task 6 Step 2/3/5/6 |
| 3.4 重试耗尽报错 | Task 6 Step 5（`onEmptyEnd` 后半段） |
| 3.5 lifecycle detach + 搬迁 | Task 1、Task 2 |
| 3.6 OpenAI 路 | Task 8（只打标，范围已在 Task 8 开头说明并给出理由） |
| 4.1 三个新 anomaly code | Task 5 |
| 4.2 新字段 + turn_start + detail 增强 | Task 7 |
| 4.3 finish 覆盖率 | Task 6 Step 5（`writableEnded` 早退补 finish）、Task 7 Step 6/7 |
| 5 分析脚本 | Task 9 |
| 6 配置项 | Task 6 Step 1（两个 env 常量） |
| 7 不变量 | Task 1 Step 5 / Task 6 Step 8 的回归；Task 6 的「有意不做」说明 |
| 8 测试 | Task 2/3/4/5/7/9 的单测 + Task 10 实机 |

**与 spec 的两处口径调整（已在对应位置注明）**

1. `turn_start` 不带 `route` / `upstreamHost`：创建 turn log 时这两者尚未确定，改由 `chat_turn` 承载。
2. OpenAI 路只打标不重试：缺重发调度器，改动量与收益不匹配（当前该路流量为 0）。

**命名一致性核对**：`StreamEnd` / `classifyStreamEnd` / `shouldRetry` / `emittedContent` / `emptyRetries` / `sseBytes` / `upstreamHost` / `detach` 在全部 Task 中拼写一致；`empty_stream` / `empty_stream_exhausted` / `client_closed` 三个 code 与 `anomaly.js`、测试、分析脚本的常量集合一致。
