# BYOK 上下文压缩阈值修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在改写 GetUserStatus 的 field18 (max_tokens, UI 显示) 同时，也改写 field23.field4 (model_info.context_window, 客户端压缩阈值)，使 1M 上下文窗口真正生效。

**Architecture:** 扩展 `context-window-rewrite.js` 的 `rewriteModelEntry` 函数，对命中的 BYOK 条目同时改写两个字段。新增 `rewriteModelInfo` 辅助函数处理 field23 子消息的递归改写。同时修复已有测试 fixtures（它们使用旧版 proto 结构，5 个测试当前失败）。

**Tech Stack:** Node.js, `node:test`, protobuf 二进制操作 (`proto.js`)

---

## File Structure

| 文件 | 角色 | 改动类型 |
|---|---|---|
| `src/proxy/handlers/context-window-rewrite.js` | 改写核心逻辑 | **Modify** — 新增常量 + `rewriteModelInfo()` + 扩展 `rewriteModelEntry()` |
| `test/unit/context-window-rewrite.test.mjs` | 单元测试 | **Modify** — 修复 fixtures 匹配新代码结构 + 新增 field23.field4 测试 |

---

### Task 1: 创建功能分支

- [ ] **Step 1: 从 main 创建分支**

```bash
git checkout -b fix/context-compression-threshold
```

- [ ] **Step 2: 确认分支**

Run: `git branch --show-current`
Expected: `fix/context-compression-threshold`

---

### Task 2: 修复已有测试 fixtures

**问题:** 现有测试 fixtures 使用旧版 proto 结构（field1=modelId varint + field4=ctxWindow，包裹在 field23 里），但代码已改为新结构（field22=model_uid string + field18=max_tokens，作为 CMC level 的 field1 条目）。5 个测试当前失败。

**Files:**
- Modify: `test/unit/context-window-rewrite.test.mjs:1-166`

- [ ] **Step 1: 重写 fixture 构造函数和常量**

将文件开头的 imports、fixture 函数和常量替换为：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteUserStatusContextWindow } from "../../src/proxy/handlers/context-window-rewrite.js";
import { writeVarintField, writeBytesField, writeStringField, parseFields, getField } from "../../src/proxy/proto.js";

// ── fixture 构造 ──────────────────────────────────────────────
// 结构(匹配当前代码):
//   顶层.field1 -> field33 -> (repeated) field1 = ClientModelConfig 条目
//   每个 CMC 条目本级: field18=max_tokens, field22=model_uid(string)

function buildModelEntry(modelUid, maxTokens, extraTailField) {
  const parts = [
    writeStringField(22, modelUid),
    writeVarintField(18, maxTokens),
  ];
  if (extraTailField) {
    parts.push(writeBytesField(7, Buffer.from(extraTailField, "utf8")));
  }
  return Buffer.concat(parts);
}

function buildUserStatus(entries) {
  const cmcEntries = Buffer.concat(entries.map((e) => writeBytesField(1, e)));
  const level33 = writeBytesField(33, cmcEntries);
  const top = writeBytesField(1, level33);
  return top;
}

// 从 fixture 中取出某个 CMC 条目的 field18 值(用于断言)
function readMaxTokens(buf, modelUid) {
  const top = getField(parseFields(buf), 1, 2);
  const l33 = getField(parseFields(top.value), 33, 2);
  const entries = parseFields(l33.value).filter((f) => f.field === 1 && f.wireType === 2);
  for (const e of entries) {
    const fields = parseFields(e.value);
    const uidField = getField(fields, 22, 2);
    if (uidField && uidField.value.toString("utf8") === modelUid) {
      const mtField = getField(fields, 18, 0);
      return mtField ? mtField.value : null;
    }
  }
  return null;
}

const OPUS = "MODEL_CLAUDE_4_OPUS_BYOK";
const SONNET = "MODEL_CLAUDE_4_SONNET_BYOK";
const OFFICIAL = "MODEL_OFFICIAL_TEST";
```

- [ ] **Step 2: 重写所有测试用例**

替换文件余下的所有测试为：

```js
// ── 核心正确性 ────────────────────────────────────────────────

test("改写命中条目的 field18 到 1M, 其余条目字节不变", () => {
  const input = buildUserStatus([
    buildModelEntry(OFFICIAL, 200000, "official-model"),
    buildModelEntry(OPUS, 200000, "opus-byok"),
  ]);
  const resolver = (uid) => (uid === OPUS ? 1000000 : 0);
  const { buffer, changed, count } = rewriteUserStatusContextWindow(input, resolver);

  assert.equal(changed, true);
  assert.equal(count, 1);
  assert.equal(readMaxTokens(buffer, OPUS), 1000000);
  assert.equal(readMaxTokens(buffer, OFFICIAL), 200000);
  assert.ok(buffer.includes(Buffer.from("official-model", "utf8")));
  assert.ok(buffer.includes(Buffer.from("opus-byok", "utf8")));
});

test("500K 档位正确写入", () => {
  const input = buildUserStatus([buildModelEntry(OPUS, 200000)]);
  const { buffer, changed } = rewriteUserStatusContextWindow(input, () => 500000);
  assert.equal(changed, true);
  assert.equal(readMaxTokens(buffer, OPUS), 500000);
});

test("原始档(resolver 返回 0): 不改写, 输出与输入完全一致", () => {
  const input = buildUserStatus([
    buildModelEntry(OFFICIAL, 200000),
    buildModelEntry(OPUS, 200000),
  ]);
  const { buffer, changed, count } = rewriteUserStatusContextWindow(input, () => 0);
  assert.equal(changed, false);
  assert.equal(count, 0);
  assert.deepEqual(buffer, input);
});

// ── 多槽位 ────────────────────────────────────────────────────

test("多个条目分别配 500K / 1M, 各自正确且互不干扰", () => {
  const input = buildUserStatus([
    buildModelEntry(OPUS, 200000),
    buildModelEntry(SONNET, 200000),
    buildModelEntry(OFFICIAL, 200000),
  ]);
  const resolver = (uid) => (uid === OPUS ? 1000000 : uid === SONNET ? 500000 : 0);
  const { buffer, changed, count } = rewriteUserStatusContextWindow(input, resolver);

  assert.equal(changed, true);
  assert.equal(count, 2);
  assert.equal(readMaxTokens(buffer, OPUS), 1000000);
  assert.equal(readMaxTokens(buffer, SONNET), 500000);
  assert.equal(readMaxTokens(buffer, OFFICIAL), 200000);
});

// ── round-trip 无损 ──────────────────────────────────────────

test("未改动的 buffer 经解析重建后与输入完全一致(无损)", () => {
  const input = buildUserStatus([
    buildModelEntry(OFFICIAL, 200000, "a"),
    buildModelEntry(OPUS, 200000, "b"),
  ]);
  const { buffer, changed } = rewriteUserStatusContextWindow(input, (uid) =>
    uid === OPUS ? 200000 : 0
  );
  assert.equal(changed, false);
  assert.deepEqual(buffer, input);
});

// ── 变长健壮性 ────────────────────────────────────────────────

test("变长 varint(2M, 4字节): 父级 length 正确增长且整体可解析", () => {
  const input = buildUserStatus([buildModelEntry(OPUS, 200000, "tail")]);
  const target = 2000000;
  const { buffer, changed } = rewriteUserStatusContextWindow(input, () => target);

  assert.equal(changed, true);
  assert.equal(readMaxTokens(buffer, OPUS), target);
  assert.doesNotThrow(() => readMaxTokens(buffer, OPUS));
  assert.ok(buffer.includes(Buffer.from("tail", "utf8")));
});

// ── 边界 / 防护 ──────────────────────────────────────────────

test("模型 UID 未登记(resolver 全返回 0): 不改", () => {
  const input = buildUserStatus([buildModelEntry("MODEL_UNKNOWN", 200000)]);
  const { buffer, changed } = rewriteUserStatusContextWindow(input, () => 0);
  assert.equal(changed, false);
  assert.deepEqual(buffer, input);
});

test("畸形/截断 buffer: 不抛异常, changed=false", () => {
  const garbage = Buffer.from([0x08, 0xff, 0xff, 0xff]);
  let result;
  assert.doesNotThrow(() => {
    result = rewriteUserStatusContextWindow(garbage, () => 1000000);
  });
  assert.equal(result.changed, false);
});

test("空 buffer: 不抛异常, changed=false", () => {
  const { changed } = rewriteUserStatusContextWindow(Buffer.alloc(0), () => 1000000);
  assert.equal(changed, false);
});

test("幂等性: 改写输出再喂一次, 结果一致", () => {
  const input = buildUserStatus([buildModelEntry(OPUS, 200000)]);
  const resolver = () => 1000000;
  const first = rewriteUserStatusContextWindow(input, resolver);
  assert.equal(first.changed, true);
  const second = rewriteUserStatusContextWindow(first.buffer, resolver);
  assert.equal(second.changed, false);
  assert.deepEqual(second.buffer, first.buffer);
});
```

- [ ] **Step 3: 运行测试验证全部通过**

Run: `node --test test/unit/context-window-rewrite.test.mjs`
Expected: 10 tests PASS, 0 FAIL

- [ ] **Step 4: Commit**

```
git add test/unit/context-window-rewrite.test.mjs
```
使用 `/git-commit` 提交。

---

### Task 3: 新增 field23.field4 改写逻辑

**Files:**
- Modify: `src/proxy/handlers/context-window-rewrite.js:8-12` (注释 + 常量)
- Modify: `src/proxy/handlers/context-window-rewrite.js:60-107` (rewriteModelEntry 函数)

- [ ] **Step 1: 写失败测试 — field23.field4 改写正确性**

在 `test/unit/context-window-rewrite.test.mjs` 末尾追加（在最后一个 `test(...)` 之后）：

```js
// ── field23.field4 (model_info.context_window) 改写 ──────────

// 构造含 field23 子消息的 CMC 条目
function buildModelEntryWithModelInfo(modelUid, maxTokens, modelInfoCtxWindow) {
  const modelInfo = Buffer.concat([
    writeVarintField(1, 277),  // model_info.field1 = model numeric id
    writeVarintField(4, modelInfoCtxWindow),  // model_info.field4 = context_window
  ]);
  const parts = [
    writeStringField(22, modelUid),
    writeVarintField(18, maxTokens),
    writeBytesField(23, modelInfo),
  ];
  return Buffer.concat(parts);
}

// 从 fixture 中读取 field23.field4 值
function readModelInfoContextWindow(buf, modelUid) {
  const top = getField(parseFields(buf), 1, 2);
  const l33 = getField(parseFields(top.value), 33, 2);
  const entries = parseFields(l33.value).filter((f) => f.field === 1 && f.wireType === 2);
  for (const e of entries) {
    const fields = parseFields(e.value);
    const uidField = getField(fields, 22, 2);
    if (uidField && uidField.value.toString("utf8") === modelUid) {
      const miField = getField(fields, 23, 2);
      if (!miField) return null;
      const miFields = parseFields(miField.value);
      const ctxField = getField(miFields, 4, 0);
      return ctxField ? ctxField.value : null;
    }
  }
  return null;
}

test("同时改写 field18 和 field23.field4", () => {
  const input = buildUserStatus([
    buildModelEntryWithModelInfo(OPUS, 200000, 200000),
  ]);
  const resolver = (uid) => (uid === OPUS ? 1000000 : 0);
  const { buffer, changed } = rewriteUserStatusContextWindow(input, resolver);

  assert.equal(changed, true);
  assert.equal(readMaxTokens(buffer, OPUS), 1000000);
  assert.equal(readModelInfoContextWindow(buffer, OPUS), 1000000);
});

test("field23 存在但无 field4: 仅改 field18, 不追加 field4", () => {
  // model_info 只有 field1(model numeric id), 没有 field4
  const modelInfo = writeVarintField(1, 277);
  const entry = Buffer.concat([
    writeStringField(22, OPUS),
    writeVarintField(18, 200000),
    writeBytesField(23, modelInfo),
  ]);
  const input = buildUserStatus([entry]);
  const resolver = () => 1000000;
  const { buffer, changed } = rewriteUserStatusContextWindow(input, resolver);

  assert.equal(changed, true);
  assert.equal(readMaxTokens(buffer, OPUS), 1000000);
  // field23 内无 field4, 不追加 → 仍无
  assert.equal(readModelInfoContextWindow(buffer, OPUS), null);
});

test("无 field23 的条目: 仅改 field18, 不报错", () => {
  const input = buildUserStatus([buildModelEntry(OPUS, 200000)]);
  const resolver = () => 1000000;
  const { buffer, changed } = rewriteUserStatusContextWindow(input, resolver);

  assert.equal(changed, true);
  assert.equal(readMaxTokens(buffer, OPUS), 1000000);
  // 无 field23 → readModelInfoContextWindow 返回 null
  assert.equal(readModelInfoContextWindow(buffer, OPUS), null);
});

test("field23.field4 幂等: 已是目标值时不改动", () => {
  const input = buildUserStatus([
    buildModelEntryWithModelInfo(OPUS, 200000, 200000),
  ]);
  const resolver = () => 1000000;
  const first = rewriteUserStatusContextWindow(input, resolver);
  assert.equal(first.changed, true);
  assert.equal(readModelInfoContextWindow(first.buffer, OPUS), 1000000);

  const second = rewriteUserStatusContextWindow(first.buffer, resolver);
  assert.equal(second.changed, false);
  assert.deepEqual(second.buffer, first.buffer);
});

test("非 BYOK 条目的 field23.field4 不受影响", () => {
  const input = buildUserStatus([
    buildModelEntryWithModelInfo(OPUS, 200000, 200000),
    buildModelEntryWithModelInfo(OFFICIAL, 200000, 200000),
  ]);
  const resolver = (uid) => (uid === OPUS ? 1000000 : 0);
  const { buffer } = rewriteUserStatusContextWindow(input, resolver);

  assert.equal(readModelInfoContextWindow(buffer, OPUS), 1000000);
  assert.equal(readModelInfoContextWindow(buffer, OFFICIAL), 200000);
});
```

- [ ] **Step 2: 运行测试验证新增 5 个测试失败（field23.field4 未实现）**

Run: `node --test test/unit/context-window-rewrite.test.mjs`
Expected: 原有 10 个 PASS, 新增 5 个中 3 个 FAIL (`同时改写`, `field23.field4 幂等`, `非 BYOK 不受影响`)。`field23 无 field4` 和 `无 field23` 应 PASS（保守策略 = 当前行为已满足）。

- [ ] **Step 3: 在 context-window-rewrite.js 新增常量**

在 `const CMC_MODEL_UID_FIELD = 22;` 后面添加：

```js
const CMC_MODEL_INFO_FIELD = 23;
const MI_CONTEXT_WINDOW_FIELD = 4;
```

- [ ] **Step 4: 新增 rewriteModelInfo 函数**

在 `rewriteModelEntry` 函数**之前**插入：

```js
// 改写 model_info 子消息中的 field4(context_window)。
// 若 field4 存在且值 ≠ targetWindow, 则替换; 无 field4 不追加(保守策略)。
// 返回重建后的 Buffer, 若无变更返回 null。
function rewriteModelInfo(modelInfoBuf, targetWindow) {
  const parsed = parseWithRaw(modelInfoBuf);
  if (!parsed.ok) {
    return null;
  }
  const parts = [];
  let replaced = false;
  for (const f of parsed.fields) {
    if (f.field === MI_CONTEXT_WINDOW_FIELD && f.wireType === 0) {
      if (Number(f.value) === targetWindow) {
        parts.push(f.raw);
      } else {
        parts.push(writeVarintField(MI_CONTEXT_WINDOW_FIELD, targetWindow));
        replaced = true;
      }
    } else {
      parts.push(f.raw);
    }
  }
  if (!replaced) {
    return null;
  }
  return Buffer.concat(parts);
}
```

- [ ] **Step 5: 扩展 rewriteModelEntry 的遍历循环**

在 `rewriteModelEntry` 函数的 `for (const f of parsed.fields)` 循环内，将现有的 `else` 分支：

```js
    } else {
      parts.push(f.raw);
    }
```

替换为：

```js
    } else if (f.field === CMC_MODEL_INFO_FIELD && f.wireType === 2) {
      const rebuilt = rewriteModelInfo(f.value, window);
      if (rebuilt !== null) {
        parts.push(writeBytesField(CMC_MODEL_INFO_FIELD, rebuilt));
        replaced = true;
      } else {
        parts.push(f.raw);
      }
    } else {
      parts.push(f.raw);
    }
```

- [ ] **Step 6: 更新文件顶部注释**

将第 8 行的注释：

```js
//   field23 = model_info(子消息, 内部另有 context_window, 但 UI 分母不读它)
```

替换为：

```js
//   field23 = model_info(子消息, 内部 field4 = context_window, 客户端上下文压缩阈值读取此字段)
```

- [ ] **Step 7: 运行全部测试**

Run: `node --test test/unit/context-window-rewrite.test.mjs`
Expected: 15 tests PASS, 0 FAIL

- [ ] **Step 8: Commit**

```
git add src/proxy/handlers/context-window-rewrite.js test/unit/context-window-rewrite.test.mjs
```
使用 `/git-commit` 提交。

---

### Task 4: 运行全量测试 + 代码检查

- [ ] **Step 1: 运行全部单元测试**

Run: `node --test test/unit/*.test.mjs`
Expected: 全部 PASS（除已知的 `sidebarTemplate.test.mjs` 预存失败外）

- [ ] **Step 2: 语法检查改动文件**

Run: `node --check src/proxy/handlers/context-window-rewrite.js`
Expected: 无输出（语法正确）

- [ ] **Step 3: Commit spec 和 plan 文档**

```
git add docs/superpowers/specs/2026-07-26-context-compression-threshold-fix-design.md docs/superpowers/plans/2026-07-26-context-compression-threshold-fix.md
```
使用 `/git-commit` 提交。

---

### Task 5: 同步到运行副本并真机验证

- [ ] **Step 1: 确认运行副本路径**

查找当前安装版本：
```powershell
Get-ChildItem "C:\Users\cz\.windsurf\extensions" -Filter "jornlin.devin-byok-plus-*" | Select-Object Name
```

- [ ] **Step 2: 备份运行副本原文件**

```powershell
$ver = "<版本号>"  # 从 Step 1 获得
$src = "C:\Users\cz\.windsurf\extensions\jornlin.devin-byok-plus-$ver\proxy-scripts\src"
Copy-Item "$src\context-window-rewrite.js" "$src\context-window-rewrite.js.ctxfix-bak"
```

- [ ] **Step 3: 同步改动文件到运行副本**

注意：运行副本是 flat 结构（无 `proxy/handlers` 子目录），`src/proxy/handlers/context-window-rewrite.js` 映射到 `proxy-scripts/src/context-window-rewrite.js`。

```powershell
Copy-Item "d:\repository\devin-byok-plus\src\proxy\handlers\context-window-rewrite.js" "$src\context-window-rewrite.js"
```

- [ ] **Step 4: 语法检查运行副本**

```powershell
node --check "$src\context-window-rewrite.js"
```
Expected: 无输出

- [ ] **Step 5: 完全重启 Devin 并验证**

1. 完全退出 Devin（非 reload window）
2. 重新打开
3. 开始一个长对话
4. 观察 context used：
   - UI 分母仍显示 1M ✓
   - context used 能超过 150K 继续增长 ✓ ← **关键验证点**
5. 查看代理日志确认 `GetUserStatus contextWindow rewritten` 仍正常打印
