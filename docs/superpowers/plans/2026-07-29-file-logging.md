# 日志文件功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为代理与扩展新增结构化 JSONL 日志落盘能力，把已有的断流/工具降级诊断信息持久化并打上 anomaly 标记，用于定位「agent 意外断开」与「未按规则调用工具」两类难复现问题。

**Spec:** `docs/superpowers/specs/2026-07-29-file-logging-design.md`

**Architecture:** 代理侧（ESM）在 `src/proxy/logging/` 新增 6 个单一职责模块，门面 `log-writer.js` 只暴露 2 个方法；扩展侧（CJS）新增同名精简写入器。写入采用异步三档策略（常规攒批 / high 立即 flush / 退出同步兜干）。业务代码只在**既有分支旁**挂日志调用，不改任何判定逻辑。

**Tech Stack:** Node.js (ESM + CJS 双侧), `node:test`, `node:fs`

**分支:** `feat/file-logging`（已创建）

---

## File Structure

| 文件 | 角色 | 改动类型 |
|---|---|---|
| `src/proxy/logging/log-config.js` | env → 配置 + `configureLog()` 热更新入口 | **Create** |
| `src/proxy/logging/log-file.js` | 路径拼接、轮转判定、启动清理 | **Create** |
| `src/proxy/logging/log-queue.js` | 队列、攒批、串行 flush、背压、退出兜干 | **Create** |
| `src/proxy/logging/log-writer.js` | 门面（`logEvent` / `logBlob`） | **Create** |
| `src/proxy/logging/anomaly.js` | anomaly 代码 + `Severity` 常量 + 映射 | **Create** |
| `src/proxy/logging/turn-log.js` | 单轮上下文 `createTurnLog()` | **Create** |
| `src/managers/log-writer.js` | 扩展侧精简写入器（CJS） | **Create** |
| `src/proxy/handlers/models.js` | `setRuntimeConfig` 末尾调 `configureLog` | **Modify** |
| `src/proxy/hybrid-server.js` | 启动初始化 + `lifecycle` 事件 | **Modify** |
| `src/proxy/inference-proxy.js` | 启动初始化 + `lifecycle` 事件 | **Modify** |
| `src/proxy/handlers/chat.js` | 建 turn log + 断流/超时/重试挂 anomaly | **Modify** |
| `src/proxy/handlers/openai-stream.js` | `setTurnLog` + 降级分支挂 anomaly | **Modify** |
| `src/proxy/handlers/anthropic-stream.js` | `setTurnLog` + 兜底分支挂 anomaly | **Modify** |
| `src/managers/proxyManager.js` | 白名单 + patch + 扩展侧事件写入 | **Modify** |
| `test/unit/log-config.test.mjs` | 配置与热更新测试 | **Create** |
| `test/unit/log-file.test.mjs` | 轮转与清理测试 | **Create** |
| `test/unit/log-queue.test.mjs` | 攒批、背压、退出兜干测试 | **Create** |
| `test/unit/log-writer.test.mjs` | 门面与容错测试 | **Create** |
| `test/unit/anomaly.test.mjs` | 代码 → severity 映射测试 | **Create** |
| `test/unit/turn-log.test.mjs` | 汇总、去重、幂等测试 | **Create** |

**实现顺序原则:** Task 2–6 是零依赖的纯新增模块（可独立测试、不影响现有功能）；Task 7 起才接入业务代码。任何一步测试失败必须先修复再继续。

---

### Task 1: 确认起点

- [ ] **Step 1: 确认分支**

Run: `git branch --show-current`
Expected: `feat/file-logging`

- [ ] **Step 2: 记录改动前的测试基线**

Run: `node --test test/unit/*.test.mjs`

记录当前通过/失败数。**已知预存失败:** `sidebarTemplate.test.mjs`（`renderSidebarHtml is not a function`），与本次改动无关。后续每次运行以此为基线对比，确保没有新增失败。

---

### Task 2: anomaly.js — 代码表与 severity

**Files:**
- Create: `src/proxy/logging/anomaly.js`
- Create: `test/unit/anomaly.test.mjs`

- [ ] **Step 1: 先写测试**

创建 `test/unit/anomaly.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { Anomaly, Severity, severityOf } from "../../src/proxy/logging/anomaly.js";

test("Severity 是冻结常量", () => {
  assert.equal(Severity.HIGH, "high");
  assert.equal(Severity.MEDIUM, "medium");
  assert.equal(Severity.LOW, "low");
  assert.ok(Object.isFrozen(Severity));
});

test("high 集合与 spec 第 6 节一致", () => {
  const high = [
    Anomaly.STREAM_ABORTED,
    Anomaly.STREAM_ERROR,
    Anomaly.STREAM_IDLE_TIMEOUT,
    Anomaly.REQUEST_TIMEOUT,
    Anomaly.FORCED_STOP,
    Anomaly.UPSTREAM_ERROR_STATUS,
  ];
  for (const code of high) {
    assert.equal(severityOf(code), Severity.HIGH, code + " 应为 high");
  }
  assert.equal(high.length, 6);
});

test("medium 集合正确", () => {
  const medium = [
    Anomaly.RETRY,
    Anomaly.CIRCUIT_BREAKER,
    Anomaly.TOOL_CALLS_DOWNGRADED,
    Anomaly.TOOLS_ALL_FILTERED,
    Anomaly.TOOL_RECOVERED_FROM_TEXT,
    Anomaly.TOOL_ARGS_INVALID_JSON,
  ];
  for (const code of medium) {
    assert.equal(severityOf(code), Severity.MEDIUM, code + " 应为 medium");
  }
});

test("low 集合正确", () => {
  assert.equal(severityOf(Anomaly.TOOL_NAME_AUTOCORRECTED), Severity.LOW);
  assert.equal(severityOf(Anomaly.TOOL_UNKNOWN_PASSTHROUGH), Severity.LOW);
});

test("共 14 个 anomaly 代码", () => {
  assert.equal(Object.keys(Anomaly).length, 14);
});

test("未知 code 归为 low, 不抛异常", () => {
  assert.equal(severityOf("no_such_code"), Severity.LOW);
  assert.equal(severityOf(undefined), Severity.LOW);
  assert.equal(severityOf(null), Severity.LOW);
});

test("Anomaly 值与键一一对应且为 snake_case", () => {
  for (const [key, value] of Object.entries(Anomaly)) {
    assert.equal(value, key.toLowerCase(), key + " 值应为键的小写");
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/unit/anomaly.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 anomaly.js**

创建 `src/proxy/logging/anomaly.js`：

```js
// anomaly 代码表。全部对应代码中【已存在】的分支，不新增任何判定逻辑。
// 详见 docs/superpowers/specs/2026-07-29-file-logging-design.md 第 6 节。

export const Severity = Object.freeze({
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
});

export const Anomaly = Object.freeze({
  // high — 断开场景
  STREAM_ABORTED: "stream_aborted",
  STREAM_ERROR: "stream_error",
  STREAM_IDLE_TIMEOUT: "stream_idle_timeout",
  REQUEST_TIMEOUT: "request_timeout",
  FORCED_STOP: "forced_stop",
  UPSTREAM_ERROR_STATUS: "upstream_error_status",
  // medium — 重试/熔断/工具降级
  RETRY: "retry",
  CIRCUIT_BREAKER: "circuit_breaker",
  TOOL_CALLS_DOWNGRADED: "tool_calls_downgraded",
  TOOLS_ALL_FILTERED: "tools_all_filtered",
  TOOL_RECOVERED_FROM_TEXT: "tool_recovered_from_text",
  TOOL_ARGS_INVALID_JSON: "tool_args_invalid_json",
  // low — 名称纠正/透传
  TOOL_NAME_AUTOCORRECTED: "tool_name_autocorrected",
  TOOL_UNKNOWN_PASSTHROUGH: "tool_unknown_passthrough",
});

const SEVERITY_BY_CODE = Object.freeze({
  [Anomaly.STREAM_ABORTED]: Severity.HIGH,
  [Anomaly.STREAM_ERROR]: Severity.HIGH,
  [Anomaly.STREAM_IDLE_TIMEOUT]: Severity.HIGH,
  [Anomaly.REQUEST_TIMEOUT]: Severity.HIGH,
  [Anomaly.FORCED_STOP]: Severity.HIGH,
  [Anomaly.UPSTREAM_ERROR_STATUS]: Severity.HIGH,
  [Anomaly.RETRY]: Severity.MEDIUM,
  [Anomaly.CIRCUIT_BREAKER]: Severity.MEDIUM,
  [Anomaly.TOOL_CALLS_DOWNGRADED]: Severity.MEDIUM,
  [Anomaly.TOOLS_ALL_FILTERED]: Severity.MEDIUM,
  [Anomaly.TOOL_RECOVERED_FROM_TEXT]: Severity.MEDIUM,
  [Anomaly.TOOL_ARGS_INVALID_JSON]: Severity.MEDIUM,
  [Anomaly.TOOL_NAME_AUTOCORRECTED]: Severity.LOW,
  [Anomaly.TOOL_UNKNOWN_PASSTHROUGH]: Severity.LOW,
});

// 未知 code 一律归 low，绝不抛异常（日志代码不得打断业务）。
export function severityOf(code) {
  return SEVERITY_BY_CODE[code] || Severity.LOW;
}

export function isHigh(code) {
  return severityOf(code) === Severity.HIGH;
}
```

- [ ] **Step 4: 运行测试确认全绿**

Run: `node --test test/unit/anomaly.test.mjs`
Expected: 7 tests PASS, 0 FAIL

- [ ] **Step 5: Commit**

```
git add src/proxy/logging/anomaly.js test/unit/anomaly.test.mjs
```
使用 `/git-commit` 提交。

---

### Task 3: log-config.js — 配置与热更新入口

**Files:**
- Create: `src/proxy/logging/log-config.js`
- Create: `test/unit/log-config.test.mjs`

**关键约束:** 本模块是热更新链路的落点。`models.js` → `logging/*` 单向依赖，反向禁止（spec 3.2）。

- [ ] **Step 1: 先写测试**

创建 `test/unit/log-config.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readLogConfigFromEnv, configureLog, getLogConfig } from "../../src/proxy/logging/log-config.js";

test("默认值: enabled=true, verbose=false, maxMb=10, retainDays=7", () => {
  const cfg = readLogConfigFromEnv({});
  assert.equal(cfg.logEnabled, true);
  assert.equal(cfg.logVerbose, false);
  assert.equal(cfg.logMaxMb, 10);
  assert.equal(cfg.logRetainDays, 7);
});

test("env 字符串 'false' 关闭开关", () => {
  const cfg = readLogConfigFromEnv({ LOG_ENABLED: "false", LOG_VERBOSE: "false" });
  assert.equal(cfg.logEnabled, false);
  assert.equal(cfg.logVerbose, false);
});

test("env 字符串 'true' 打开 verbose", () => {
  const cfg = readLogConfigFromEnv({ LOG_VERBOSE: "true" });
  assert.equal(cfg.logVerbose, true);
});

test("数值项非法时回落默认值", () => {
  const cfg = readLogConfigFromEnv({ LOG_MAX_MB: "abc", LOG_RETAIN_DAYS: "-5" });
  assert.equal(cfg.logMaxMb, 10);
  assert.equal(cfg.logRetainDays, 7);
});

test("数值项有上限保护", () => {
  const cfg = readLogConfigFromEnv({ LOG_MAX_MB: "999999", LOG_RETAIN_DAYS: "999999" });
  assert.ok(cfg.logMaxMb <= 1024);
  assert.ok(cfg.logRetainDays <= 365);
});

test("configureLog 热更新 verbose 生效", () => {
  configureLog({ LOG_VERBOSE: "true" });
  assert.equal(getLogConfig().logVerbose, true);
  configureLog({ LOG_VERBOSE: "false" });
  assert.equal(getLogConfig().logVerbose, false);
});

test("configureLog 只改传入的键, 不动其他键", () => {
  configureLog({ LOG_ENABLED: "true", LOG_MAX_MB: "20" });
  const before = getLogConfig();
  configureLog({ LOG_VERBOSE: "true" });
  const after = getLogConfig();
  assert.equal(after.logMaxMb, before.logMaxMb);
  assert.equal(after.logEnabled, before.logEnabled);
  assert.equal(after.logVerbose, true);
});

test("configureLog 传 null / 非对象不抛异常", () => {
  assert.doesNotThrow(() => configureLog(null));
  assert.doesNotThrow(() => configureLog(undefined));
  assert.doesNotThrow(() => configureLog("nonsense"));
  assert.doesNotThrow(() => configureLog(123));
});

test("configureLog 接受 camelCase 运行态字段", () => {
  configureLog({ logVerbose: true });
  assert.equal(getLogConfig().logVerbose, true);
  configureLog({ logVerbose: false });
  assert.equal(getLogConfig().logVerbose, false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/unit/log-config.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 log-config.js**

创建 `src/proxy/logging/log-config.js`：

```js
// 日志配置。env 解析 + 运行态热更新入口。
// 依赖方向（强制）: models.js -> logging/*，反向禁止。
// 因此热更新由 models.js 的 setRuntimeConfig 主动调用 configureLog 推入。

const DEFAULTS = Object.freeze({
  logEnabled: true,
  logVerbose: false,
  logMaxMb: 10,
  logRetainDays: 7,
});

const MAX_MB_LIMIT = 1024;
const RETAIN_DAYS_LIMIT = 365;

function toBool(value, fallback) {
  if (value === true || value === false) {
    return value;
  }
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "true") {
    return true;
  }
  if (s === "false") {
    return false;
  }
  return fallback;
}

function toInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(n) || n < min) {
    return fallback;
  }
  return Math.min(n, max);
}

export function readLogConfigFromEnv(env = process.env) {
  const src = env && typeof env === "object" ? env : {};
  return {
    logEnabled: toBool(src.LOG_ENABLED, DEFAULTS.logEnabled),
    logVerbose: toBool(src.LOG_VERBOSE, DEFAULTS.logVerbose),
    logMaxMb: toInt(src.LOG_MAX_MB, DEFAULTS.logMaxMb, 1, MAX_MB_LIMIT),
    logRetainDays: toInt(src.LOG_RETAIN_DAYS, DEFAULTS.logRetainDays, 1, RETAIN_DAYS_LIMIT),
  };
}

let _config = readLogConfigFromEnv();

export function getLogConfig() {
  return { ..._config };
}

// 热更新。接受 UPPER_CASE（env / .env patch）与 camelCase（运行态）两种键名。
// 只覆盖传入的键；任何异常一律吞掉，绝不打断调用方（models.js 的配置流程）。
export function configureLog(patch) {
  try {
    if (!patch || typeof patch !== "object") {
      return getLogConfig();
    }
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
    const next = { ..._config };
    if (has("LOG_ENABLED")) {
      next.logEnabled = toBool(patch.LOG_ENABLED, next.logEnabled);
    }
    if (has("logEnabled")) {
      next.logEnabled = toBool(patch.logEnabled, next.logEnabled);
    }
    if (has("LOG_VERBOSE")) {
      next.logVerbose = toBool(patch.LOG_VERBOSE, next.logVerbose);
    }
    if (has("logVerbose")) {
      next.logVerbose = toBool(patch.logVerbose, next.logVerbose);
    }
    if (has("LOG_MAX_MB")) {
      next.logMaxMb = toInt(patch.LOG_MAX_MB, next.logMaxMb, 1, MAX_MB_LIMIT);
    }
    if (has("logMaxMb")) {
      next.logMaxMb = toInt(patch.logMaxMb, next.logMaxMb, 1, MAX_MB_LIMIT);
    }
    if (has("LOG_RETAIN_DAYS")) {
      next.logRetainDays = toInt(patch.LOG_RETAIN_DAYS, next.logRetainDays, 1, RETAIN_DAYS_LIMIT);
    }
    if (has("logRetainDays")) {
      next.logRetainDays = toInt(patch.logRetainDays, next.logRetainDays, 1, RETAIN_DAYS_LIMIT);
    }
    _config = next;
  } catch {
    // 配置热更新失败不影响运行，保持旧配置
  }
  return getLogConfig();
}
```

- [ ] **Step 4: 运行测试确认全绿**

Run: `node --test test/unit/log-config.test.mjs`
Expected: 9 tests PASS, 0 FAIL

- [ ] **Step 5: Commit**

```
git add src/proxy/logging/log-config.js test/unit/log-config.test.mjs
```
使用 `/git-commit` 提交。

---

### Task 4: log-file.js — 路径、轮转、清理

**Files:**
- Create: `src/proxy/logging/log-file.js`
- Create: `test/unit/log-file.test.mjs`

**设计要点:** 轮转与清理的判定逻辑做成**纯函数**（输入文件名/大小/时间，输出决策），这样单测不必真写满 10MB 或等待 7 天。

- [ ] **Step 1: 先写测试**

创建 `test/unit/log-file.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dailyFileName,
  blobFileName,
  isExpired,
  nextRotationPath,
  needsRotation,
  ensureLogDir,
  cleanupExpired,
} from "../../src/proxy/logging/log-file.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "byok-log-test-"));
}

test("dailyFileName 按日期生成", () => {
  const d = new Date("2026-07-29T10:00:00Z");
  assert.equal(dailyFileName(d), "proxy-2026-07-29.jsonl");
});

test("blobFileName 按 turnId + kind 生成", () => {
  assert.equal(blobFileName("msg_abc", "sse"), "msg_abc.sse.txt");
});

test("blobFileName 清洗路径穿越字符", () => {
  const name = blobFileName("../../etc/passwd", "sse");
  assert.ok(!name.includes(".."), "不得包含 ..");
  assert.ok(!name.includes("/"), "不得包含 /");
  assert.ok(!name.includes("\\"), "不得包含反斜杠");
});

test("needsRotation: 超过阈值返回 true", () => {
  const maxBytes = 10 * 1024 * 1024;
  assert.equal(needsRotation(maxBytes + 1, maxBytes), true);
  assert.equal(needsRotation(maxBytes - 1, maxBytes), false);
  assert.equal(needsRotation(0, maxBytes), false);
});

test("nextRotationPath 递增序号", () => {
  const dir = tmpDir();
  const base = path.join(dir, "proxy-2026-07-29.jsonl");
  fs.writeFileSync(base, "x");
  assert.equal(path.basename(nextRotationPath(base)), "proxy-2026-07-29.1.jsonl");
  fs.writeFileSync(path.join(dir, "proxy-2026-07-29.1.jsonl"), "x");
  assert.equal(path.basename(nextRotationPath(base)), "proxy-2026-07-29.2.jsonl");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("isExpired: 按天数判断", () => {
  const now = new Date("2026-07-29T00:00:00Z").getTime();
  const eightDaysAgo = now - 8 * 86400000;
  const oneDayAgo = now - 1 * 86400000;
  assert.equal(isExpired(eightDaysAgo, 7, now), true);
  assert.equal(isExpired(oneDayAgo, 7, now), false);
});

test("ensureLogDir 创建目录与 blobs 子目录", () => {
  const dir = path.join(tmpDir(), "logs");
  ensureLogDir(dir);
  assert.ok(fs.existsSync(dir));
  assert.ok(fs.existsSync(path.join(dir, "blobs")));
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test("ensureLogDir 重复调用不抛异常", () => {
  const dir = path.join(tmpDir(), "logs");
  ensureLogDir(dir);
  assert.doesNotThrow(() => ensureLogDir(dir));
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test("cleanupExpired 只删过期的 jsonl, 保留新文件", () => {
  const dir = tmpDir();
  const oldFile = path.join(dir, "proxy-2026-07-01.jsonl");
  const newFile = path.join(dir, "proxy-2026-07-29.jsonl");
  fs.writeFileSync(oldFile, "old");
  fs.writeFileSync(newFile, "new");
  const past = Date.now() - 30 * 86400000;
  fs.utimesSync(oldFile, past / 1000, past / 1000);

  const removed = cleanupExpired(dir, 7);
  assert.ok(removed >= 1);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(newFile), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cleanupExpired 不碰非日志文件", () => {
  const dir = tmpDir();
  const other = path.join(dir, "important.txt");
  fs.writeFileSync(other, "keep me");
  const past = Date.now() - 30 * 86400000;
  fs.utimesSync(other, past / 1000, past / 1000);

  cleanupExpired(dir, 7);
  assert.equal(fs.existsSync(other), true, "非 proxy-*.jsonl 文件不得删除");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cleanupExpired 目录不存在时不抛异常", () => {
  assert.doesNotThrow(() => cleanupExpired("/no/such/dir/at/all", 7));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/unit/log-file.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 log-file.js**

创建 `src/proxy/logging/log-file.js`：

```js
// 日志文件路径、轮转判定与过期清理。
// 判定逻辑保持纯函数，便于单测不必真写满阈值。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE_PREFIX = "proxy-";
const FILE_EXT = ".jsonl";
const BLOB_DIR = "blobs";
const DAILY_RE = /^proxy-\d{4}-\d{2}-\d{2}(\.\d+)?\.jsonl$/;

export function getLogDir() {
  return path.join(os.homedir(), ".devin-byok-plus", "logs");
}

export function getBlobDir(dir = getLogDir()) {
  return path.join(dir, BLOB_DIR);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

export function dailyFileName(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  return FILE_PREFIX + y + "-" + m + "-" + d + FILE_EXT;
}

export function dailyFilePath(dir = getLogDir(), date = new Date()) {
  return path.join(dir, dailyFileName(date));
}

// 清洗 turnId / kind，防止路径穿越写到目录外。
function safeSegment(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, 120) || "unknown";
}

export function blobFileName(turnId, kind) {
  return safeSegment(turnId) + "." + safeSegment(kind) + ".txt";
}

export function needsRotation(currentBytes, maxBytes) {
  return Number(currentBytes) > Number(maxBytes);
}

// 找到下一个可用的轮转序号路径: proxy-<date>.1.jsonl, .2.jsonl ...
export function nextRotationPath(basePath) {
  const dir = path.dirname(basePath);
  const stem = path.basename(basePath, FILE_EXT);
  for (let i = 1; i < 10000; i++) {
    const candidate = path.join(dir, stem + "." + i + FILE_EXT);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(dir, stem + "." + Date.now() + FILE_EXT);
}

export function isExpired(mtimeMs, retainDays, now = Date.now()) {
  return now - Number(mtimeMs) > Number(retainDays) * 86400000;
}

export function ensureLogDir(dir = getLogDir()) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, BLOB_DIR), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// 轮转当前文件（超阈值时改名）。返回是否发生轮转。
export function rotateIfNeeded(filePath, maxMb) {
  try {
    const st = fs.statSync(filePath);
    if (!needsRotation(st.size, Number(maxMb) * 1024 * 1024)) {
      return false;
    }
    fs.renameSync(filePath, nextRotationPath(filePath));
    return true;
  } catch {
    return false;
  }
}

// 启动时清理过期日志与 blob。只处理 proxy-*.jsonl 与 blobs/ 下文件，
// 绝不触碰目录里的其他文件。返回删除数量。
export function cleanupExpired(dir = getLogDir(), retainDays = 7, now = Date.now()) {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!DAILY_RE.test(name)) {
        continue;
      }
      const full = path.join(dir, name);
      try {
        if (isExpired(fs.statSync(full).mtimeMs, retainDays, now)) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch {
        // 单个文件失败不影响其余
      }
    }
  } catch {
    return removed;
  }
  try {
    const blobs = path.join(dir, BLOB_DIR);
    for (const name of fs.readdirSync(blobs)) {
      const full = path.join(blobs, name);
      try {
        if (isExpired(fs.statSync(full).mtimeMs, retainDays, now)) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch {
        // 忽略
      }
    }
  } catch {
    // blobs 目录可能不存在
  }
  return removed;
}
```

- [ ] **Step 4: 运行测试确认全绿**

Run: `node --test test/unit/log-file.test.mjs`
Expected: 11 tests PASS, 0 FAIL

- [ ] **Step 5: Commit**

```
git add src/proxy/logging/log-file.js test/unit/log-file.test.mjs
```
使用 `/git-commit` 提交。

---

### Task 5: log-queue.js — 攒批、背压、退出兜干

**Files:**
- Create: `src/proxy/logging/log-queue.js`
- Create: `test/unit/log-queue.test.mjs`

**设计要点:** 队列通过构造参数注入 `appendAsync` / `appendSync` 两个写函数，测试时替换为内存假实现，无需真实 IO。这是能把攒批/串行/背压/兜干都测到的关键。

- [ ] **Step 1: 先写测试**

创建 `test/unit/log-queue.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogQueue } from "../../src/proxy/logging/log-queue.js";

function fakeSinks() {
  const asyncWrites = [];
  const syncWrites = [];
  let inFlight = 0;
  let maxConcurrent = 0;
  return {
    asyncWrites,
    syncWrites,
    maxConcurrent: () => maxConcurrent,
    appendAsync: (text) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      return new Promise((resolve) => {
        setTimeout(() => {
          asyncWrites.push(text);
          inFlight--;
          resolve();
        }, 1);
      });
    },
    appendSync: (text) => {
      syncWrites.push(text);
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test("多条普通事件攒批合并为一次写入", async () => {
  const s = fakeSinks();
  const q = createLogQueue({ appendAsync: s.appendAsync, appendSync: s.appendSync });
  q.push("a", false);
  q.push("b", false);
  q.push("c", false);
  await tick();
  assert.equal(s.asyncWrites.length, 1, "应合并为单次写入");
  assert.ok(s.asyncWrites[0].includes("a"));
  assert.ok(s.asyncWrites[0].includes("b"));
  assert.ok(s.asyncWrites[0].includes("c"));
});

test("写入串行, 不并发交错", async () => {
  const s = fakeSinks();
  const q = createLogQueue({ appendAsync: s.appendAsync, appendSync: s.appendSync });
  for (let i = 0; i < 20; i++) {
    q.push("line" + i, false);
    await new Promise((r) => setTimeout(r, 0));
  }
  await tick();
  assert.equal(s.maxConcurrent(), 1, "同时最多一个 in-flight 写");
});

test("high 事件立即触发 flush", async () => {
  const s = fakeSinks();
  const q = createLogQueue({ appendAsync: s.appendAsync, appendSync: s.appendSync });
  q.push("urgent", true);
  await tick();
  assert.equal(s.asyncWrites.length, 1);
  assert.ok(s.asyncWrites[0].includes("urgent"));
});

test("背压: 超过行数上限丢最旧的普通事件", async () => {
  const s = fakeSinks();
  const q = createLogQueue({
    appendAsync: () => new Promise(() => {}), // 永不 resolve，堆积队列
    appendSync: s.appendSync,
    maxLines: 5,
  });
  q.push("high-1", true);
  for (let i = 0; i < 50; i++) {
    q.push("normal-" + i, false);
  }
  assert.ok(q.size() <= 6, "队列不得无限增长, 实际=" + q.size());
  assert.ok(q.droppedCount() > 0, "应记录丢弃计数");
});

test("背压: high 事件优先保留", async () => {
  const s = fakeSinks();
  const q = createLogQueue({
    appendAsync: () => new Promise(() => {}),
    appendSync: s.appendSync,
    maxLines: 4,
  });
  q.push("HIGHMARK", true);
  for (let i = 0; i < 40; i++) {
    q.push("normal-" + i, false);
  }
  const remaining = q.peekAll().join("\n");
  assert.ok(remaining.includes("HIGHMARK"), "high 事件不得被丢弃");
});

test("flushSync 写出队列剩余内容", () => {
  const s = fakeSinks();
  const q = createLogQueue({
    appendAsync: () => new Promise(() => {}),
    appendSync: s.appendSync,
  });
  q.push("tail-1", false);
  q.push("tail-2", false);
  q.flushSync();
  assert.equal(s.syncWrites.length, 1);
  assert.ok(s.syncWrites[0].includes("tail-1"));
  assert.ok(s.syncWrites[0].includes("tail-2"));
  assert.equal(q.size(), 0, "兜干后队列应清空");
});

test("flushSync 队列为空时不写入", () => {
  const s = fakeSinks();
  const q = createLogQueue({ appendAsync: s.appendAsync, appendSync: s.appendSync });
  q.flushSync();
  assert.equal(s.syncWrites.length, 0);
});

test("appendAsync 抛错不冒泡, 后续写入仍工作", async () => {
  let calls = 0;
  const ok = [];
  const q = createLogQueue({
    appendAsync: (text) => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new Error("disk full"));
      }
      ok.push(text);
      return Promise.resolve();
    },
    appendSync: () => {},
  });
  q.push("first", false);
  await tick();
  q.push("second", false);
  await tick();
  assert.ok(ok.some((t) => t.includes("second")), "第一次失败不应阻断后续写入");
});

test("appendSync 抛错不冒泡", () => {
  const q = createLogQueue({
    appendAsync: () => Promise.resolve(),
    appendSync: () => {
      throw new Error("boom");
    },
  });
  q.push("x", false);
  assert.doesNotThrow(() => q.flushSync());
});

test("每行以换行结尾, 可逐行解析", async () => {
  const s = fakeSinks();
  const q = createLogQueue({ appendAsync: s.appendAsync, appendSync: s.appendSync });
  q.push(JSON.stringify({ a: 1 }), false);
  q.push(JSON.stringify({ b: 2 }), false);
  await tick();
  const lines = s.asyncWrites[0].split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.doesNotThrow(() => lines.forEach((l) => JSON.parse(l)));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/unit/log-queue.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 log-queue.js**

创建 `src/proxy/logging/log-queue.js`：

```js
// 异步写入队列。三档策略（spec 第 4 节）:
//   1. 普通事件 -> setImmediate 攒批, 合并为一次 appendAsync
//   2. high 事件 -> 立即调度 flush, 不等批量窗口
//   3. 退出路径 -> flushSync 用同步写兜干队列剩余内容
// 写操作串行化（单条 in-flight promise 链），避免并发 append 撕裂 JSONL 行。

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export function createLogQueue({
  appendAsync,
  appendSync,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const queue = [];
  let bytes = 0;
  let dropped = 0;
  let scheduled = false;
  let writing = false;

  function currentSize() {
    return queue.length;
  }

  // 背压: 超限时丢最旧的【普通】事件, high 一律保留。
  function applyBackpressure() {
    while ((queue.length > maxLines || bytes > maxBytes) && queue.length > 0) {
      const idx = queue.findIndex((e) => !e.high);
      if (idx === -1) {
        break; // 全是 high, 不丢
      }
      const [removed] = queue.splice(idx, 1);
      bytes -= removed.text.length;
      dropped++;
    }
  }

  function drainText() {
    if (queue.length === 0) {
      return "";
    }
    const lines = queue.map((e) => e.text);
    if (dropped > 0) {
      lines.push(JSON.stringify({ type: "log_dropped", ts: Date.now(), count: dropped }));
      dropped = 0;
    }
    queue.length = 0;
    bytes = 0;
    return lines.join("\n") + "\n";
  }

  function flushAsync() {
    scheduled = false;
    if (writing || queue.length === 0) {
      return;
    }
    const text = drainText();
    if (!text) {
      return;
    }
    writing = true;
    let p;
    try {
      p = appendAsync(text);
    } catch {
      writing = false;
      return;
    }
    Promise.resolve(p)
      .catch(() => {
        // IO 失败一律吞（spec 第 9 节）
      })
      .then(() => {
        writing = false;
        if (queue.length > 0) {
          schedule();
        }
      });
  }

  function schedule() {
    if (scheduled || writing) {
      return;
    }
    scheduled = true;
    setImmediate(flushAsync);
  }

  return {
    push(text, high = false) {
      try {
        if (typeof text !== "string" || text.length === 0) {
          return;
        }
        queue.push({ text, high: !!high });
        bytes += text.length;
        applyBackpressure();
        if (high) {
          // 不等批量窗口, 立即调度
          if (!writing) {
            scheduled = true;
            setImmediate(flushAsync);
          }
        } else {
          schedule();
        }
      } catch {
        // 入队失败不影响业务
      }
    },
    // 退出路径同步兜干。此时进程即将结束, 阻塞几毫秒可接受。
    flushSync() {
      try {
        const text = drainText();
        if (!text) {
          return;
        }
        appendSync(text);
      } catch {
        // 尽力而为
      }
    },
    size: currentSize,
    droppedCount() {
      return dropped;
    },
    peekAll() {
      return queue.map((e) => e.text);
    },
  };
}
```

- [ ] **Step 4: 运行测试确认全绿**

Run: `node --test test/unit/log-queue.test.mjs`
Expected: 10 tests PASS, 0 FAIL

- [ ] **Step 5: Commit**

```
git add src/proxy/logging/log-queue.js test/unit/log-queue.test.mjs
```
使用 `/git-commit` 提交。

---

### Task 6: log-writer.js — 门面（对外仅 2 个方法）

**Files:**
- Create: `src/proxy/logging/log-writer.js`
- Create: `test/unit/log-writer.test.mjs`

**设计要点:**
- 对外只暴露 `logEvent` / `logBlob`，**不暴露 `isVerbose()`**（spec 3.4）。
- `logBlob` 第三参是 **supplier**，verbose 关闭时根本不调用，不构造大字符串。
- 字段白名单 + 单字段 2KB 截断（spec 5.3）。
- 整个函数体裹 `try/catch`，任何异常一律吞（spec 第 9 节）。

- [ ] **Step 1: 先写测试**

创建 `test/unit/log-writer.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogWriter } from "../../src/proxy/logging/log-writer.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "byok-writer-test-"));
}

function readLines(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) {
    return [];
  }
  return fs
    .readFileSync(path.join(dir, files[0]), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test("logEvent 产出可逐行 JSON.parse 的 JSONL", async () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true, logVerbose: false } });
  w.logEvent({ type: "chat_turn", turnId: "t1", stopReason: "stop" });
  w.flushSync();
  const lines = readLines(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "chat_turn");
  assert.equal(lines[0].turnId, "t1");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("信封含 ts / pid / proc 字段", () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, proc: "hybrid", config: { logEnabled: true } });
  w.logEvent({ type: "lifecycle", event: "start" });
  w.flushSync();
  const [line] = readLines(dir);
  assert.equal(typeof line.ts, "number");
  assert.equal(line.pid, process.pid);
  assert.equal(line.proc, "hybrid");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("白名单外的字段被丢弃", () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true } });
  w.logEvent({ type: "chat_turn", turnId: "t1", secretSocket: { weird: true } });
  w.flushSync();
  const [line] = readLines(dir);
  assert.equal(line.secretSocket, undefined, "非白名单字段不得写入");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("超长字段截断到 2KB 并标记 truncated", () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true } });
  w.logEvent({ type: "anomaly", code: "stream_error", detail: "x".repeat(10000) });
  w.flushSync();
  const [line] = readLines(dir);
  assert.ok(line.detail.length < 2200, "应被截断, 实际=" + line.detail.length);
  assert.ok(line.detail.includes("truncated"), "应标记 truncated");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("LOG_ENABLED=false 时零 IO", async () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: false } });
  w.logEvent({ type: "chat_turn", turnId: "t1" });
  w.flushSync();
  await tick();
  assert.equal(readLines(dir).length, 0, "关闭时不得写任何内容");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("LOG_VERBOSE=false 时 logBlob 的 supplier 不被调用", () => {
  const dir = tmpDir();
  let called = false;
  const w = createLogWriter({ dir, config: { logEnabled: true, logVerbose: false } });
  w.logBlob("t1", "sse", () => {
    called = true;
    return "big payload";
  });
  assert.equal(called, false, "关闭 verbose 时不得调用 supplier");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("LOG_VERBOSE=true 时写出 blob 文件并落指针行", () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true, logVerbose: true } });
  w.logBlob("msg_abc", "sse", () => "raw sse content");
  w.flushSync();
  const blobPath = path.join(dir, "blobs", "msg_abc.sse.txt");
  assert.ok(fs.existsSync(blobPath), "blob 文件应存在");
  assert.equal(fs.readFileSync(blobPath, "utf8"), "raw sse content");
  const pointer = readLines(dir).find((l) => l.type === "blob");
  assert.ok(pointer, "应落一条 blob 指针行");
  assert.equal(pointer.kind, "sse");
  assert.ok(pointer.file.includes("msg_abc.sse.txt"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("blob 指针行不内联大文本", () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true, logVerbose: true } });
  const big = "Z".repeat(50000);
  w.logBlob("t1", "request", () => big);
  w.flushSync();
  const raw = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("");
  assert.ok(!raw.includes("ZZZZZZZZZZ"), "主日志不得内联 blob 内容");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 不影响功能：任何畸形输入都不得抛错（spec 第 9 节）────────

test("循环引用不抛异常", () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true } });
  const circular = { type: "anomaly", code: "stream_error" };
  circular.detail = circular;
  assert.doesNotThrow(() => w.logEvent(circular));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("supplier 自身抛错不冒泡", () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true, logVerbose: true } });
  assert.doesNotThrow(() =>
    w.logBlob("t1", "sse", () => {
      throw new Error("supplier boom");
    })
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("null / undefined / 非对象入参不抛异常", () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true } });
  assert.doesNotThrow(() => w.logEvent(null));
  assert.doesNotThrow(() => w.logEvent(undefined));
  assert.doesNotThrow(() => w.logEvent("not an object"));
  assert.doesNotThrow(() => w.logBlob(null, null, null));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("目录不可写时不抛异常", () => {
  const w = createLogWriter({
    dir: "/definitely/not/writable/anywhere",
    config: { logEnabled: true },
  });
  assert.doesNotThrow(() => w.logEvent({ type: "chat_turn", turnId: "t1" }));
  assert.doesNotThrow(() => w.flushSync());
});

test("high severity 的 anomaly 立即落盘", async () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true } });
  w.logEvent({ type: "anomaly", code: "stream_aborted", severity: "high" });
  await tick();
  const lines = readLines(dir);
  assert.equal(lines.length, 1, "high 事件应立即 flush, 无需等批量窗口");
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/unit/log-writer.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 log-writer.js**

创建 `src/proxy/logging/log-writer.js`：

```js
// 日志门面。对外只暴露 logEvent / logBlob（spec 3.4）。
// 不 import 任何业务模块，避免循环依赖（ws-bridge.js / chat.js 都要引它）。
import fs from "node:fs";
import path from "node:path";
import { getLogConfig } from "./log-config.js";
import {
  blobFileName,
  cleanupExpired,
  dailyFilePath,
  ensureLogDir,
  getBlobDir,
  getLogDir,
  rotateIfNeeded,
} from "./log-file.js";
import { createLogQueue } from "./log-queue.js";
import { Severity, severityOf } from "./anomaly.js";

const MAX_FIELD_BYTES = 2048;

// 字段白名单（spec 5.2 / 5.3）。理由不是保密，而是 schema 稳定、
// 文件小、避免对象上挂着 socket/stream 引用导致 stringify 抛错或写出噪音。
const ALLOWED_FIELDS = new Set([
  // 信封
  "ts", "pid", "proc", "type", "turnId", "target",
  // chat_turn
  "initiator", "route", "model", "byokSlot", "promptLen", "requestBytes",
  "toolsOffered", "toolChoice", "stopReason", "toolsCalled", "usage",
  "retryCount", "soundEligible", "durationMs", "anomalies",
  // anomaly
  "code", "severity", "detail",
  // lifecycle
  "event", "port", "exitCode", "message",
  // blob
  "kind", "file", "bytes",
  // log_dropped
  "count",
]);

function truncate(value) {
  const s = String(value);
  if (s.length <= MAX_FIELD_BYTES) {
    return s;
  }
  return s.slice(0, MAX_FIELD_BYTES) + "...truncated(" + s.length + ")";
}

function sanitizeValue(value) {
  if (value == null) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncate(value);
  }
  if (Array.isArray(value)) {
    return truncate(value.map((v) => (typeof v === "string" ? v : String(v))).join(","))
      .split(",")
      .filter(Boolean);
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "number" || typeof v === "boolean") {
        out[k] = v;
      } else if (typeof v === "string") {
        out[k] = truncate(v);
      }
    }
    return out;
  }
  return truncate(String(value));
}

// 只保留白名单字段，逐字段截断。畸形值（循环引用等）在此被过滤掉。
function serialize(event, envelope) {
  const merged = { ...envelope };
  for (const [k, v] of Object.entries(event)) {
    if (!ALLOWED_FIELDS.has(k)) {
      continue;
    }
    merged[k] = sanitizeValue(v);
  }
  return JSON.stringify(merged);
}

export function createLogWriter({ dir = getLogDir(), proc = "proxy", config = null } = {}) {
  const readConfig = () => (config ? { ...getLogConfig(), ...config } : getLogConfig());
  let dirReady = false;
  let warned = false;

  function warnOnce(message) {
    if (warned) {
      return;
    }
    warned = true;
    // 经 proxyManager.log() 出现在输出面板；仅一次，避免刷屏。
    console.log("  ⚠️  日志写入失败，已停止告警: " + message);
  }

  function ensureReady(cfg) {
    if (dirReady) {
      return true;
    }
    if (!ensureLogDir(dir)) {
      warnOnce("无法创建日志目录 " + dir);
      return false;
    }
    dirReady = true;
    try {
      cleanupExpired(dir, cfg.logRetainDays);
    } catch {
      // 清理失败不影响写入
    }
    return true;
  }

  function targetPath(cfg) {
    const p = dailyFilePath(dir);
    rotateIfNeeded(p, cfg.logMaxMb);
    return p;
  }

  const queue = createLogQueue({
    appendAsync: (text) => {
      const cfg = readConfig();
      if (!ensureReady(cfg)) {
        return Promise.resolve();
      }
      return fs.promises.appendFile(targetPath(cfg), text, "utf8").catch((e) => {
        warnOnce(e && e.message ? e.message : String(e));
      });
    },
    appendSync: (text) => {
      const cfg = readConfig();
      if (!ensureReady(cfg)) {
        return;
      }
      try {
        fs.appendFileSync(targetPath(cfg), text, "utf8");
      } catch (e) {
        warnOnce(e && e.message ? e.message : String(e));
      }
    },
  });

  function logEvent(event) {
    try {
      const cfg = readConfig();
      if (!cfg.logEnabled) {
        return;
      }
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        return;
      }
      const envelope = { ts: Date.now(), pid: process.pid, proc };
      const line = serialize(event, envelope);
      const high =
        event.severity === Severity.HIGH ||
        (event.type === "anomaly" && severityOf(event.code) === Severity.HIGH) ||
        event.type === "lifecycle";
      queue.push(line, high);
    } catch {
      // 日志代码绝不打断业务（spec 第 9 节）
    }
  }

  // 第三参为 supplier：verbose 关闭时根本不调用，不构造大字符串。
  function logBlob(turnId, kind, supplier) {
    try {
      const cfg = readConfig();
      if (!cfg.logEnabled || !cfg.logVerbose) {
        return;
      }
      if (typeof supplier !== "function") {
        return;
      }
      if (!ensureReady(cfg)) {
        return;
      }
      let content;
      try {
        content = supplier();
      } catch {
        return; // supplier 自身抛错不冒泡
      }
      if (content == null) {
        return;
      }
      const text = typeof content === "string" ? content : String(content);
      const name = blobFileName(turnId, kind);
      const full = path.join(getBlobDir(dir), name);
      fs.promises.writeFile(full, text, "utf8").then(
        () => {
          logEvent({
            type: "blob",
            turnId: String(turnId ?? ""),
            kind: String(kind ?? ""),
            file: path.join("blobs", name),
            bytes: text.length,
          });
        },
        (e) => warnOnce(e && e.message ? e.message : String(e))
      );
    } catch {
      // 同上
    }
  }

  return {
    logEvent,
    logBlob,
    flushSync: () => queue.flushSync(),
  };
}

// 进程级单例 + 退出兜干（spec 第 4 节第 3 档）。
let _default = null;

export function initLogWriter(proc) {
  if (_default) {
    return _default;
  }
  _default = createLogWriter({ proc });
  const flush = () => _default.flushSync();
  process.on("exit", flush);
  process.on("SIGINT", flush);
  process.on("SIGTERM", flush);
  process.on("uncaughtException", (e) => {
    _default.logEvent({
      type: "lifecycle",
      event: "uncaughtException",
      message: e && e.message ? e.message : String(e),
    });
    flush();
  });
  process.on("unhandledRejection", (e) => {
    _default.logEvent({
      type: "lifecycle",
      event: "unhandledRejection",
      message: e && e.message ? e.message : String(e),
    });
    flush();
  });
  return _default;
}

export function logEvent(event) {
  return initLogWriter("proxy").logEvent(event);
}

export function logBlob(turnId, kind, supplier) {
  return initLogWriter("proxy").logBlob(turnId, kind, supplier);
}
```

> 注意：`uncaughtException` / `unhandledRejection` 监听器**只记录并兜干，不吞掉进程退出行为**——不调用 `process.exit`，也不阻止默认行为，保持 Node 原有语义，避免改变现有崩溃/重启逻辑（`proxyManager` 依赖退出码自动重启）。

- [ ] **Step 4: 运行测试确认全绿**

Run: `node --test test/unit/log-writer.test.mjs`
Expected: 13 tests PASS, 0 FAIL

- [ ] **Step 5: Commit**

```
git add src/proxy/logging/log-writer.js test/unit/log-writer.test.mjs
```
使用 `/git-commit` 提交。

---

### Task 7: turn-log.js — 单轮上下文

**Files:**
- Create: `src/proxy/logging/turn-log.js`
- Create: `test/unit/turn-log.test.mjs`

**设计要点:** 句柄只有 3 个方法（spec 3.4）：`set` 浅合并 / `anomaly` / `finish`。`finish` 必须幂等——对应现有 `streamFinished` 那类双重 finalize 风险（`chat.js:1113-1123`）。

- [ ] **Step 1: 先写测试**

创建 `test/unit/turn-log.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnLog } from "../../src/proxy/logging/turn-log.js";
import { Anomaly } from "../../src/proxy/logging/anomaly.js";

function fakeWriter() {
  const events = [];
  return {
    events,
    logEvent: (e) => events.push(e),
    logBlob: () => {},
  };
}

test("finish 落一条 chat_turn 汇总", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  ctx.set({ model: "gpt-5.5", stopReason: "stop" });
  ctx.finish();
  const turns = w.events.filter((e) => e.type === "chat_turn");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turnId, "t1");
  assert.equal(turns[0].model, "gpt-5.5");
  assert.equal(turns[0].stopReason, "stop");
});

test("set 浅合并, 多次调用累积", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  ctx.set({ model: "m1" });
  ctx.set({ route: "anthropic" });
  ctx.set({ model: "m2" });
  ctx.finish();
  const [turn] = w.events.filter((e) => e.type === "chat_turn");
  assert.equal(turn.model, "m2", "后写覆盖先写");
  assert.equal(turn.route, "anthropic");
});

test("anomaly 各落一条独立事件", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  ctx.anomaly(Anomaly.STREAM_ABORTED, "socket closed");
  ctx.anomaly(Anomaly.RETRY, "attempt 1");
  const anomalies = w.events.filter((e) => e.type === "anomaly");
  assert.equal(anomalies.length, 2);
  assert.equal(anomalies[0].code, Anomaly.STREAM_ABORTED);
  assert.equal(anomalies[0].severity, "high");
  assert.equal(anomalies[0].detail, "socket closed");
  assert.equal(anomalies[1].severity, "medium");
});

test("anomaly 汇总进 chat_turn.anomalies 且去重", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  ctx.anomaly(Anomaly.RETRY, "1");
  ctx.anomaly(Anomaly.RETRY, "2");
  ctx.anomaly(Anomaly.STREAM_ERROR, "boom");
  ctx.finish();
  const [turn] = w.events.filter((e) => e.type === "chat_turn");
  assert.deepEqual(turn.anomalies.sort(), [Anomaly.RETRY, Anomaly.STREAM_ERROR].sort());
});

test("finish 幂等: 重复调用只落一次", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  ctx.finish();
  ctx.finish();
  ctx.finish();
  assert.equal(w.events.filter((e) => e.type === "chat_turn").length, 1);
});

test("finish 后 set / anomaly 不再产生事件", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  ctx.finish();
  const before = w.events.length;
  ctx.set({ model: "late" });
  ctx.anomaly(Anomaly.RETRY, "late");
  assert.equal(w.events.length, before, "finish 后不应再记录");
});

test("durationMs 自动计算", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  ctx.finish();
  const [turn] = w.events.filter((e) => e.type === "chat_turn");
  assert.equal(typeof turn.durationMs, "number");
  assert.ok(turn.durationMs >= 0);
});

test("meta 里的 target / initiator 透传", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({
    turnId: "t1",
    target: "win2",
    writer: w,
    meta: { initiator: "agent" },
  });
  ctx.finish();
  const [turn] = w.events.filter((e) => e.type === "chat_turn");
  assert.equal(turn.target, "win2");
  assert.equal(turn.initiator, "agent");
});

// ── 不影响功能 ────────────────────────────────────────────────

test("畸形入参不抛异常", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  assert.doesNotThrow(() => ctx.set(null));
  assert.doesNotThrow(() => ctx.set("not object"));
  assert.doesNotThrow(() => ctx.anomaly(null, null));
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => ctx.anomaly(Anomaly.RETRY, circular));
  assert.doesNotThrow(() => ctx.finish());
});

test("writer 抛错不冒泡", () => {
  const bad = {
    logEvent: () => {
      throw new Error("writer boom");
    },
    logBlob: () => {},
  };
  const ctx = createTurnLog({ turnId: "t1", writer: bad });
  assert.doesNotThrow(() => ctx.anomaly(Anomaly.RETRY, "x"));
  assert.doesNotThrow(() => ctx.finish());
});

test("无 writer 时退化为静默, 不抛异常", () => {
  const ctx = createTurnLog({ turnId: "t1", writer: null });
  assert.doesNotThrow(() => ctx.set({ model: "m" }));
  assert.doesNotThrow(() => ctx.anomaly(Anomaly.RETRY, "x"));
  assert.doesNotThrow(() => ctx.finish());
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/unit/turn-log.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 turn-log.js**

创建 `src/proxy/logging/turn-log.js`：

```js
// 单轮（turn）日志上下文。句柄只有 3 个方法（spec 3.4）:
//   ctx.set(partialFields) / ctx.anomaly(code, detail) / ctx.finish()
// finish 幂等 —— 对应现有 streamFinished 那类双重 finalize 风险。
import { severityOf } from "./anomaly.js";
import { logEvent as defaultLogEvent } from "./log-writer.js";

function toDetail(value) {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createTurnLog({ turnId, target = null, meta = {}, writer = undefined } = {}) {
  const emit =
    writer === null
      ? () => {}
      : writer && typeof writer.logEvent === "function"
        ? (e) => writer.logEvent(e)
        : defaultLogEvent;

  const startedAt = Date.now();
  const fields = { ...(meta && typeof meta === "object" ? meta : {}) };
  const codes = new Set();
  let finished = false;

  function safeEmit(event) {
    try {
      emit(event);
    } catch {
      // 日志绝不打断业务
    }
  }

  return {
    set(partial) {
      try {
        if (finished || !partial || typeof partial !== "object" || Array.isArray(partial)) {
          return;
        }
        Object.assign(fields, partial);
      } catch {
        // 忽略
      }
    },
    anomaly(code, detail) {
      try {
        if (finished || !code) {
          return;
        }
        codes.add(code);
        safeEmit({
          type: "anomaly",
          turnId,
          target,
          code,
          severity: severityOf(code),
          detail: toDetail(detail),
        });
      } catch {
        // 忽略
      }
    },
    finish(extra) {
      try {
        if (finished) {
          return;
        }
        finished = true;
        if (extra && typeof extra === "object" && !Array.isArray(extra)) {
          Object.assign(fields, extra);
        }
        safeEmit({
          type: "chat_turn",
          turnId,
          target,
          ...fields,
          anomalies: [...codes],
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // 忽略
      }
    },
  };
}
```

- [ ] **Step 4: 运行测试确认全绿**

Run: `node --test test/unit/turn-log.test.mjs`
Expected: 11 tests PASS, 0 FAIL

- [ ] **Step 5: 阶段验证 — 全部日志模块单测**

Run: `node --test test/unit/anomaly.test.mjs test/unit/log-config.test.mjs test/unit/log-file.test.mjs test/unit/log-queue.test.mjs test/unit/log-writer.test.mjs test/unit/turn-log.test.mjs`
Expected: 全部 PASS。**此时日志子系统已完整且自洽，尚未接入任何业务代码——功能零风险。**

- [ ] **Step 6: Commit**

```
git add src/proxy/logging/turn-log.js test/unit/turn-log.test.mjs
```
使用 `/git-commit` 提交。

---

## 阶段二：接入业务代码

> 从这里开始改动现有文件。**每个 Task 结束都必须跑全量测试**，确保「不影响功能」这条强制要求不被破坏。

### Task 8: 打通配置热更新链路

**Files:**
- Modify: `src/proxy/handlers/models.js`（`setRuntimeConfig` 末尾）
- Modify: `test/unit/log-config.test.mjs`（追加集成断言）

**依赖方向（强制）:** `models.js` → `logging/*` 允许，反向禁止。

- [ ] **Step 1: 在 models.js 顶部加 import**

在现有 import 区（`models.js:1-4`）之后追加：

```js
import { configureLog } from "../logging/log-config.js";
```

- [ ] **Step 2: 在 setRuntimeConfig 末尾调用 configureLog**

`setRuntimeConfig`（`models.js:244`）在 `syncLegacyFromByok1();` 之后、`return` 之前插入：

```js
  // 把日志相关配置推给日志子系统（依赖方向单向: models -> logging）。
  // configureLog 内部吞掉一切异常，不会影响配置流程。
  configureLog(arg0);
```

- [ ] **Step 3: 追加集成测试**

在 `test/unit/log-config.test.mjs` 末尾追加：

```js
test("setRuntimeConfig 推送 LOG_* 到日志配置（单向依赖不产生循环引用）", async () => {
  const models = await import("../../src/proxy/handlers/models.js");
  models.setRuntimeConfig({ LOG_VERBOSE: "true", LOG_MAX_MB: "25" });
  const cfg = getLogConfig();
  assert.equal(cfg.logVerbose, true);
  assert.equal(cfg.logMaxMb, 25);
  // 复位，避免影响其他测试
  models.setRuntimeConfig({ LOG_VERBOSE: "false", LOG_MAX_MB: "10" });
});
```

- [ ] **Step 4: 验证**

Run: `node --test test/unit/log-config.test.mjs`
Expected: 全部 PASS（含新增的集成用例）

Run: `node --check src/proxy/handlers/models.js`
Expected: 无输出

- [ ] **Step 5: 全量回归**

Run: `node --test test/**/*.test.mjs`
Expected: 与基线一致（Task 1 记录的预存失败之外无新增失败）

- [ ] **Step 6: Commit**

```
git add src/proxy/handlers/models.js test/unit/log-config.test.mjs
```
使用 `/git-commit` 提交。

---

### Task 9: 子进程启动初始化 + 生命周期事件

**Files:**
- Modify: `src/proxy/hybrid-server.js`
- Modify: `src/proxy/inference-proxy.js`

- [ ] **Step 1: hybrid-server.js 加 import 与初始化**

在 import 区末尾追加：

```js
import { initLogWriter } from "./logging/log-writer.js";
```

在模块顶层（服务器启动前）插入：

```js
const logWriter = initLogWriter("hybrid");
logWriter.logEvent({ type: "lifecycle", event: "proxy_start" });
```

- [ ] **Step 2: hybrid-server.js 记录端口绑定**

在 server listen 成功的回调里（打印 `⚡ Devin BYOK Bridge hybrid on ...` 的位置）追加：

```js
logWriter.logEvent({ type: "lifecycle", event: "port_bound", port: PORT });
```

> 变量名 `PORT` 按该文件实际使用的端口变量替换。

- [ ] **Step 3: inference-proxy.js 同样处理**

```js
import { initLogWriter } from "./logging/log-writer.js";
```

```js
const logWriter = initLogWriter("inference");
logWriter.logEvent({ type: "lifecycle", event: "proxy_start" });
```

并在 listen 回调追加 `port_bound` 事件。

- [ ] **Step 4: 语法检查**

Run: `node --check src/proxy/hybrid-server.js`
Run: `node --check src/proxy/inference-proxy.js`
Expected: 均无输出

- [ ] **Step 5: 冒烟验证 — 真实启动子进程**

```powershell
$env:LOG_ENABLED="true"; node src/proxy/hybrid-server.js
```

启动后 Ctrl+C 停止，然后检查日志：

```powershell
Get-Content "$env:USERPROFILE\.devin-byok-plus\logs\proxy-*.jsonl" -Tail 5
```

Expected: 至少能看到 `proxy_start` 与 `port_bound` 两条 `lifecycle` 事件，且每行是合法 JSON。**这是第一次验证真实落盘链路。**

- [ ] **Step 6: 全量回归**

Run: `node --test test/**/*.test.mjs`
Expected: 与基线一致

- [ ] **Step 7: Commit**

```
git add src/proxy/hybrid-server.js src/proxy/inference-proxy.js
```
使用 `/git-commit` 提交。

---

### Task 10: chat.js 接入 turn log 与断流类 anomaly

**Files:**
- Modify: `src/proxy/handlers/chat.js`

**这是本计划风险最高的 Task。** 全部改动都是在既有分支旁**新增一行**调用，不修改任何既有判定条件、不改控制流。

- [ ] **Step 1: 加 import**

在 `chat.js` import 区末尾追加：

```js
import { createTurnLog } from "../logging/turn-log.js";
import { Anomaly } from "../logging/anomaly.js";
```

- [ ] **Step 2: 在 handleGetChatMessage 创建 turn log**

在 `handleGetChatMessage`（`chat.js:466`）中，`emitChatStart` 附近（已有 `🆔 Request identity` 打印处）创建上下文：

```js
  const turnLog = createTurnLog({
    turnId: messageId,
    target: monitorTargetId,
    meta: {
      initiator,
      promptLen: (systemPrompt || "").length,
      toolsOffered: (tools || []).map((t) => t.name).filter(Boolean),
      toolChoice: toolChoice ? String(toolChoice) : undefined,
    },
  });
```

> 变量名按该函数内实际的局部变量名替换（该文件为混淆命名，如 `tmp7` = messageId、`tmp9` = monitorTargetId）。务必先读取上下文确认，不要照抄。

- [ ] **Step 3: 把 turnLog 传给 streamAnthropic / streamOpenAI**

在两个流函数的 options 对象里新增 `turnLog` 字段，并在函数签名的解构里接收。

- [ ] **Step 4: 挂 anomaly 到既有断流分支**

在**不改动任何既有语句**的前提下，于以下位置各加一行：

| 位置 | 新增调用 |
|---|---|
| `chat.js:1104-1110`（OpenAI idle timeout） | `turnLog?.anomaly(Anomaly.STREAM_IDLE_TIMEOUT, 'idle ' + OPENAI_SSE_IDLE_TIMEOUT_MS + 'ms');` |
| `chat.js:1160`（OpenAI forced stop） | `turnLog?.anomaly(Anomaly.FORCED_STOP, 'no terminal event');` |
| `chat.js:1181-1183`（OpenAI aborted） | `turnLog?.anomaly(Anomaly.STREAM_ABORTED, 'aborted before completion');` |
| `chat.js:1191-1193`（OpenAI error） | `turnLog?.anomaly(Anomaly.STREAM_ERROR, arg03.message);` |
| `chat.js:1536-1543`（Anthropic idle timeout） | `turnLog?.anomaly(Anomaly.STREAM_IDLE_TIMEOUT, 'idle ' + ANTHROPIC_SSE_IDLE_TIMEOUT_MS + 'ms');` |
| `chat.js:1583`（Anthropic forced stop） | `turnLog?.anomaly(Anomaly.FORCED_STOP, 'no message_stop');` |
| `chat.js:1605-1606`（Anthropic aborted） | `turnLog?.anomaly(Anomaly.STREAM_ABORTED, 'aborted before completion');` |
| `chat.js:1614-1615`（Anthropic error） | `turnLog?.anomaly(Anomaly.STREAM_ERROR, arg03.message);` |
| `chat.js:1623`（Anthropic request timeout） | `turnLog?.anomaly(Anomaly.REQUEST_TIMEOUT, String(ANTHROPIC_REQUEST_TIMEOUT_MS) + 'ms');` |
| `chat.js:1721-1724`（retry） | `turnLog?.anomaly(Anomaly.RETRY, errorDesc);` |
| `circuitBreaker.recordFailure()` 各调用点 | `turnLog?.anomaly(Anomaly.CIRCUIT_BREAKER, 'failure recorded');` |
| 非 2xx 上游响应分支 | `turnLog?.anomaly(Anomaly.UPSTREAM_ERROR_STATUS, String(arg02.statusCode));` |

> 使用 `turnLog?.` 可选链，保证即便某条路径没拿到上下文也不会抛错。

- [ ] **Step 5: 在流结束处调用 finish**

在 `finishStream`（`chat.js:1114-1123`）与 Anthropic 的 `finalize` 收尾处调用：

```js
turnLog?.finish({
  route: /* 'openai-responses' | 'chat-completions' | 'anthropic' */,
  model: resolvedModel,
  byokSlot,
  stopReason: processor.stopReason,
  toolsCalled: /* processor 收集的工具名数组 */,
  usage: processor.getUsage(),
  retryCount,
});
```

`finish` 幂等，重复调用安全——这正是 Task 7 覆盖该行为的原因。

- [ ] **Step 6: 语法检查**

Run: `node --check src/proxy/handlers/chat.js`
Expected: 无输出

- [ ] **Step 7: 全量回归（关键）**

Run: `node --test test/**/*.test.mjs`
Expected: 与基线一致。**若出现任何新增失败，立即回退本 Task 的改动并排查，不得带着失败继续。**

- [ ] **Step 8: Commit**

```
git add src/proxy/handlers/chat.js
```
使用 `/git-commit` 提交。

---

### Task 11: stream processor 接入工具类 anomaly

**Files:**
- Modify: `src/proxy/handlers/openai-stream.js`
- Modify: `src/proxy/handlers/anthropic-stream.js`
- Modify: `src/proxy/handlers/tool-normalization.js`

**注入方式:** 沿用既有 `setAllowedTools` / `setSoundEligible` 风格，新增 `setTurnLog(ctx)`。

- [ ] **Step 1: openai-stream.js 加 setter**

两个 processor 类（`OpenAIStreamProcessor`、`ChatCompletionsStreamProcessor`）的构造函数各加 `this._turnLog = null;`，并新增方法：

```js
  setTurnLog(ctx) {
    this._turnLog = ctx || null;
  }
```

顶部加 import：

```js
import { Anomaly } from "../logging/anomaly.js";
```

- [ ] **Step 2: 挂 anomaly 到既有降级分支**

| 位置 | 新增调用 |
|---|---|
| `openai-stream.js:205`（工具名自动纠正） | `this._turnLog?.anomaly(Anomaly.TOOL_NAME_AUTOCORRECTED, arg0.name + ' -> ' + tmp03);` |
| `openai-stream.js:208`（未知工具透传） | `this._turnLog?.anomaly(Anomaly.TOOL_UNKNOWN_PASSTHROUGH, arg0.name);` |
| `openai-stream.js:218`（工具全被过滤） | `this._turnLog?.anomaly(Anomaly.TOOLS_ALL_FILTERED, 'fallback to text');` |
| `openai-stream.js:225`（文本兜底恢复） | `this._turnLog?.anomaly(Anomaly.TOOL_RECOVERED_FROM_TEXT, tmp12.map(a => a.name).join(','));` |
| `openai-stream.js:247`（tool_calls 降级） | `this._turnLog?.anomaly(Anomaly.TOOL_CALLS_DOWNGRADED, 'reported tool_calls but none found');` |
| `openai-stream.js:451`（ChatCompletions 工具全过滤） | 同 `TOOLS_ALL_FILTERED` |
| `openai-stream.js:456`（ChatCompletions 文本兜底） | 同 `TOOL_RECOVERED_FROM_TEXT` |
| `openai-stream.js:472-474`（ChatCompletions 降级） | 同 `TOOL_CALLS_DOWNGRADED` |

- [ ] **Step 3: anthropic-stream.js 同样处理**

加 `this._turnLog = null;` + `setTurnLog(ctx)` + import，并在：

| 位置 | 新增调用 |
|---|---|
| `anthropic-stream.js:176-181`（工具名归一化失败，回退文本） | `this._turnLog?.anomaly(Anomaly.TOOLS_ALL_FILTERED, 'normalize failed: ' + (this._toolName || ''));` |
| `anthropic-stream.js:207`（文本兜底恢复） | `this._turnLog?.anomaly(Anomaly.TOOL_RECOVERED_FROM_TEXT, tmp12.map(a => a.name).join(','));` |

- [ ] **Step 4: tool-normalization.js 记录非法 JSON**

`tool-normalization.js:56-63` 处（arguments 非法 JSON、原样返回字符串）已有注释说明该分支。此处不便持有 turnLog，改为**返回标记**：在返回对象中加 `argsInvalid: true`，由调用方（processor）读取后打 `TOOL_ARGS_INVALID_JSON`。

```js
  if (tmp3 === null || typeof tmp3 !== "object" || Array.isArray(tmp3)) {
    return {
      toolName: tmp2,
      params: tmp3,
      argsInvalid: true,
    };
  }
```

在 processor 调用 `normalizeToolInvocation` 后判断：

```js
if (tmp22.argsInvalid) {
  this._turnLog?.anomaly(Anomaly.TOOL_ARGS_INVALID_JSON, tmp12.name || '');
}
```

> 新增字段不影响既有解构（既有代码只取 `toolName` / `params`），保持向后行为一致。

- [ ] **Step 5: chat.js 注入 turnLog 到 processor**

在创建 processor 之后（已有 `setAllowedTools` / `setSoundEligible` 调用处）追加：

```js
processor.setTurnLog(turnLog);
```

- [ ] **Step 6: 语法检查**

Run: `node --check src/proxy/handlers/openai-stream.js`
Run: `node --check src/proxy/handlers/anthropic-stream.js`
Run: `node --check src/proxy/handlers/tool-normalization.js`
Expected: 均无输出

- [ ] **Step 7: 全量回归（关键）**

Run: `node --test test/**/*.test.mjs`
Expected: 与基线一致。特别关注 `tool-normalization-truncated.test.mjs` 与 `protocol-logic.test.mjs` —— 它们直接覆盖本 Task 改动的模块。

- [ ] **Step 8: Commit**

```
git add src/proxy/handlers/openai-stream.js src/proxy/handlers/anthropic-stream.js src/proxy/handlers/tool-normalization.js src/proxy/handlers/chat.js
```
使用 `/git-commit` 提交。

---

### Task 12: 扩展侧落盘 + .env 白名单

**Files:**
- Create: `src/managers/log-writer.js`（CJS）
- Modify: `src/managers/proxyManager.js`

- [ ] **Step 1: 创建 CJS 写入器**

创建 `src/managers/log-writer.js`：

```js
// 扩展侧日志写入器（CommonJS）。
// 与代理侧 src/proxy/logging/log-writer.js 同名、职责相同，
// 因 CJS/ESM 无法共用模块文件而分开实现，差异仅由路径体现。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_FIELD_CHARS = 2048;

function logDir() {
  return path.join(os.homedir(), '.devin-byok-plus', 'logs');
}

function dailyPath() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name =
    'proxy-' + d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + '.jsonl';
  return path.join(logDir(), name);
}

function truncate(value) {
  const s = String(value);
  return s.length <= MAX_FIELD_CHARS ? s : s.slice(0, MAX_FIELD_CHARS) + '...truncated(' + s.length + ')';
}

let warned = false;

// 扩展侧事件量极小（启停、退出码、热更），直接异步 append 即可，无需队列。
function logExtEvent(event) {
  try {
    if (!event || typeof event !== 'object') {
      return;
    }
    const line = {
      ts: Date.now(),
      pid: process.pid,
      proc: 'ext',
      type: 'lifecycle',
    };
    for (const [k, v] of Object.entries(event)) {
      if (typeof v === 'number' || typeof v === 'boolean') {
        line[k] = v;
      } else if (v != null) {
        line[k] = truncate(v);
      }
    }
    fs.mkdirSync(logDir(), { recursive: true });
    fs.appendFile(dailyPath(), JSON.stringify(line) + '\n', 'utf-8', (err) => {
      if (err && !warned) {
        warned = true;
        console.log('[Devin BYOK Bridge] 日志写入失败: ' + err.message);
      }
    });
  } catch {
    // 日志绝不打断扩展逻辑
  }
}

module.exports = { logExtEvent, logDir };
```

- [ ] **Step 2: proxyManager.js 加 require 与调用**

在 import 区（`proxyManager.js:16-18`）追加：

```js
const logWriter = require("./log-writer");
```

在以下已有位置各加一行（**不改既有语句**）：

| 位置 | 新增调用 |
|---|---|
| `start()` 成功后（`proxyManager.js:985`） | `logWriter.logExtEvent({ event: 'hybrid_started', port: tmp5 });` |
| hybrid `exit`（`proxyManager.js:953-954`） | `logWriter.logExtEvent({ event: 'hybrid_exit', exitCode: arg0 });` |
| inference `exit`（`proxyManager.js:1044-1045`） | `logWriter.logExtEvent({ event: 'inference_exit', exitCode: arg0 });` |
| 端口回退（`proxyManager.js:1011`） | `logWriter.logExtEvent({ event: 'port_fallback', port: tmp23 });` |
| `reloadRuntimeConfig` 结果处 | `logWriter.logExtEvent({ event: 'config_reload', message: tmp5.ok ? 'ok' : tmp5.errors.join('; ') });` |
| `setStartError`（`proxyManager.js` 内） | `logWriter.logExtEvent({ event: 'start_error', message: tmp0 });` |

- [ ] **Step 3: 加入 .env 白名单**

`writeEnvConfig` 的白名单 Set（`proxyManager.js:523`）末尾追加 4 项：

```js
"LOG_ENABLED", "LOG_VERBOSE", "LOG_MAX_MB", "LOG_RETAIN_DAYS"
```

并在「通用」段落写出（`proxyManager.js:562-575` 附近）：

```js
    tmp6.push("LOG_ENABLED=" + (tmp0.LOG_ENABLED || "true"));
    tmp6.push("LOG_VERBOSE=" + (tmp0.LOG_VERBOSE || "false"));
    tmp6.push("LOG_MAX_MB=" + (tmp0.LOG_MAX_MB || "10"));
    tmp6.push("LOG_RETAIN_DAYS=" + (tmp0.LOG_RETAIN_DAYS || "7"));
```

- [ ] **Step 4: 加入热更新 patch**

`buildRuntimeConfigPatch`（`proxyManager.js:587`）的返回对象追加：

```js
      LOG_ENABLED: tmp0.LOG_ENABLED || "true",
      LOG_VERBOSE: tmp0.LOG_VERBOSE || "false",
      LOG_MAX_MB: tmp0.LOG_MAX_MB || "10",
      LOG_RETAIN_DAYS: tmp0.LOG_RETAIN_DAYS || "7",
```

- [ ] **Step 5: 语法检查**

Run: `node --check src/managers/log-writer.js`
Run: `node --check src/managers/proxyManager.js`
Expected: 均无输出

- [ ] **Step 6: 全量回归**

Run: `node --test test/**/*.test.mjs`
Expected: 与基线一致。注意 `config-hotreload.test.mjs` 覆盖热更新逻辑。

- [ ] **Step 7: Commit**

```
git add src/managers/log-writer.js src/managers/proxyManager.js
```
使用 `/git-commit` 提交。

---

## 阶段三：收尾验证

### Task 13: 全量测试 + lint + 构建检查

- [ ] **Step 1: 全量单测**

Run: `node --test test/**/*.test.mjs`
Expected: 与 Task 1 记录的基线一致，且新增 6 个日志测试文件全绿。

- [ ] **Step 2: lint**

Run: `pnpm run lint`
Expected: 无 error（warning 数不超过 `--max-warnings 50`）。若 `node_modules` 不存在则跳过并记录。

- [ ] **Step 3: 构建检查（确认新目录被打包）**

Run: `node scripts/build.js`

**已实测确认（无需担心）：** `build.js:69` 用 `fs.cpSync(proxySource, proxyTarget, { recursive: true })` 整体复制，**完整保留目录结构**，不做平铺、不重写 import 路径。因此 `src/proxy/logging/` → `proxy-scripts/src/logging/`，`handlers/*.js` 里的 `../logging/log-writer.js` 在产物中天然成立，无需改 `build.js`。

验证产物：

```powershell
Get-ChildItem -Recurse "proxy-scripts\src\logging" -Filter "*.js" | Select-Object Name
```

Expected: 6 个日志模块（`anomaly.js`、`log-config.js`、`log-file.js`、`log-queue.js`、`log-writer.js`、`turn-log.js`）齐全。

- [ ] **Step 4: 集成测试**

Run: `node --test test/integration/build.test.mjs`
Expected: PASS

---

### Task 14: 同步运行副本并真机验证

- [ ] **Step 1: 确认运行副本路径**

```powershell
Get-ChildItem "C:\Users\cz\.windsurf\extensions" -Filter "jornlin.devin-byok-plus-*" | Select-Object Name
```

> **已实测确认（2.4.6）：** 运行副本**保留子目录结构**，`proxy-scripts\src\` 下是 `handlers\chat.js`、`hybrid-server.js`、`ws-bridge.js` 等，与工作区 `src\proxy\` 一一对应（仅少 `proxy` 这层目录名）。此前"flat 结构"的说法不成立。因此 `../logging/` 相对路径在运行副本中同样成立，**无需任何路径调整**。

- [ ] **Step 2: 备份运行副本待改文件**

```powershell
$ver = "2.4.6"  # 按 Step 1 实际结果替换
$dst = "C:\Users\cz\.windsurf\extensions\jornlin.devin-byok-plus-$ver\proxy-scripts\src"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
foreach ($f in @("handlers\chat.js","handlers\openai-stream.js","handlers\anthropic-stream.js","handlers\tool-normalization.js","handlers\models.js","hybrid-server.js","inference-proxy.js")) {
  Copy-Item "$dst\$f" "$dst\$f.logbak-$stamp"
}
```

- [ ] **Step 3: 同步改动文件（结构一一对应，直接覆盖）**

```powershell
$src = "d:\repository\devin-byok-plus\src\proxy"
Copy-Item "$src\handlers\chat.js"              "$dst\handlers\chat.js"
Copy-Item "$src\handlers\openai-stream.js"     "$dst\handlers\openai-stream.js"
Copy-Item "$src\handlers\anthropic-stream.js"  "$dst\handlers\anthropic-stream.js"
Copy-Item "$src\handlers\tool-normalization.js" "$dst\handlers\tool-normalization.js"
Copy-Item "$src\handlers\models.js"            "$dst\handlers\models.js"
Copy-Item "$src\hybrid-server.js"              "$dst\hybrid-server.js"
Copy-Item "$src\inference-proxy.js"            "$dst\inference-proxy.js"
New-Item -ItemType Directory -Force -Path "$dst\logging" | Out-Null
Copy-Item "$src\logging\*.js" "$dst\logging\"
```

- [ ] **Step 4: 语法检查运行副本**

```powershell
node --check "$dst\hybrid-server.js"
node --check "$dst\inference-proxy.js"
Get-ChildItem "$dst\handlers" -Filter "*.js" | ForEach-Object { node --check $_.FullName }
Get-ChildItem "$dst\logging" -Filter "*.js" | ForEach-Object { node --check $_.FullName }
```
Expected: 无输出

- [ ] **Step 5: 完全重启 Devin 并复现问题**

1. 完全退出 Devin（**非** reload window）
2. 重新打开，启动代理
3. 正常使用一段时间，特意触发几次问题场景（长对话、agent 调工具、Fast Context 子请求）

- [ ] **Step 6: 验证日志落盘**

```powershell
Get-ChildItem "$env:USERPROFILE\.devin-byok-plus\logs"
Get-Content "$env:USERPROFILE\.devin-byok-plus\logs\proxy-*.jsonl" -Tail 20
```

**验证清单：**
- [ ] 目录已创建，含 `blobs/` 子目录
- [ ] 每行都是合法 JSON（可 `ConvertFrom-Json`）
- [ ] 能看到 `proc:"hybrid"` / `proc:"inference"` / `proc:"ext"` 三种来源
- [ ] `chat_turn` 事件含 `toolsOffered` / `toolsCalled` / `stopReason` / `usage`
- [ ] agent 交互**无可感知延迟**（这是异步设计的核心验收点）

- [ ] **Step 7: 验证问题定位能力（本功能的真正验收）**

针对**断开**问题：
```powershell
Select-String -Path "$env:USERPROFILE\.devin-byok-plus\logs\proxy-*.jsonl" -Pattern '"severity":"high"'
```
Expected: 断开发生过的话，应能看到 `stream_aborted` / `stream_error` / `stream_idle_timeout` / `request_timeout` 之一，并可据此判断断在哪一层。

针对**弹窗工具未调用**问题（按 spec 6.3，手动 grep，无启发式打标）：
```powershell
Get-Content "$env:USERPROFILE\.devin-byok-plus\logs\proxy-*.jsonl" |
  ConvertFrom-Json |
  Where-Object { $_.type -eq 'chat_turn' -and $_.toolsOffered -contains 'ask_user_question' -and $_.toolsCalled -notcontains 'ask_user_question' -and $_.stopReason -eq 'stop' } |
  Select-Object turnId, initiator, stopReason, anomalies
```
Expected: 能筛出候选轮次。若某轮 `anomalies` 里带 `tool_calls_downgraded` 或 `tools_all_filtered`，即代理侧静默降级的**直接证据**。

- [ ] **Step 8: 验证 verbose 热更新（无需重启）**

在侧栏或 `.env` 里把 `LOG_VERBOSE` 改为 `true` 并保存配置（触发 `/api/config` 热更新），然后发一轮对话：

```powershell
Get-ChildItem "$env:USERPROFILE\.devin-byok-plus\logs\blobs"
```
Expected: 出现 blob 文件，且主日志里有对应的 `type:"blob"` 指针行。**不需要重启代理**。

- [ ] **Step 9: 回归确认功能未受影响**

- [ ] 正常对话、工具调用、编辑文件全部工作
- [ ] 完成声音仍正常触发（`__CHAT_DONE__` 链路未被破坏）
- [ ] 上下文窗口分母仍显示配置值（`GetUserStatus` 改写未受影响）
- [ ] 内联补全仍工作（inference 进程正常）

---

### Task 15: 提交文档与收尾

- [ ] **Step 1: 提交 plan 文档**

```
git add docs/superpowers/plans/2026-07-29-file-logging.md
```
使用 `/git-commit` 提交。

- [ ] **Step 2: 更新 CHANGELOG**

在 `CHANGELOG.md` 顶部加入本次改动条目（新增日志文件功能、4 个 `LOG_*` 配置项、日志位置 `~/.devin-byok-plus/logs/`）。

- [ ] **Step 3: 确认无临时文件残留**

```powershell
git status --short
```
Expected: 无意外的未跟踪文件。（已知 `docs/RETRY-AND-RESILIENCE.md` 为本次改动之前就存在的未跟踪文件，不纳入。）

- [ ] **Step 4: 提交 CHANGELOG**

使用 `/git-commit` 提交。

- [ ] **Step 5: 汇报完成状态**

向用户汇报：
- 日志位置与查看方式
- 4 个配置项及默认值
- 两类问题的 grep 方法（断开 → `severity:high`；工具降级 → `anomalies` 字段）
- 提醒：日志含完整系统提示词与代码，对外分享前需确认

---

## 附录：验收标准

本计划完成的判定：

| 项 | 标准 |
|---|---|
| 落盘 | `~/.devin-byok-plus/logs/proxy-<date>.jsonl` 存在，每行合法 JSON |
| 关联 | 同一轮的 `chat_turn` 与 `anomaly` 共享 `turnId`，跨进程可串联 |
| 不丢尾部 | 强杀代理进程后，队列中事件仍出现在文件里 |
| 不影响性能 | agent 交互无可感知延迟 |
| 不影响功能 | 全量测试与基线一致；声音/上下文窗口/补全全部正常 |
| 可定位断开 | 断开时能从 `severity:high` 事件判断断在哪一层 |
| 可定位工具异常 | 工具被静默降级时 `anomalies` 字段有对应 code |
| 热更新 | 改 `LOG_VERBOSE` 无需重启代理即生效 |
