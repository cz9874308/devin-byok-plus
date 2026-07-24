# Active BYOK Slot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让子请求（SWE Agent、标题生成、Fast Context 等）自动继承用户选择的 BYOK 槽位，统一使用该槽位的模型、密钥和端点。

**Architecture:** 在 `chat.js` 模块级添加 `_activeByokSlot` 状态。当直接匹配到 BYOK 槽位时记录，后续子请求通过 `effectiveSlot = directSlot || _activeByokSlot` 继承。修改 `resolveConfiguredModel` 和 `requiresConfiguredDefaultModel` 接受 `fallbackSlot` 参数。

**Tech Stack:** Node.js, `node:test`, `node:assert/strict`

**Spec:** `docs/superpowers/specs/2025-07-24-active-byok-slot-design.md`

---

### Task 1: 添加 _activeByokSlot 状态 + getter/setter 并导出

**Files:**
- Modify: `src/proxy/handlers/chat.js:67-80` (exports), `src/proxy/handlers/chat.js:100` (state declaration)

- [ ] **Step 1: 在 chat.js 模块级添加状态变量和访问函数**

在 `const _ENV_DEFAULT_MODEL` 行之前添加：

```javascript
let _activeByokSlot = null;
function getActiveByokSlot() { return _activeByokSlot; }
function setActiveByokSlot(slot) { _activeByokSlot = slot; }
```

- [ ] **Step 2: 将 getter/setter 加入导出列表**

在 `chat.js` 的 `export { ... }` 块中添加 `getActiveByokSlot` 和 `setActiveByokSlot`：

```javascript
export {
  requiresConfiguredDefaultModel,
  synthesizeToolsFromMessages,
  collectToolUseNames,
  ensureNamedToolChoiceTool,
  toInjectedTailMessage,
  isAuxiliaryRequest,
  getActiveByokSlot,
  setActiveByokSlot,
};
```

- [ ] **Step 3: 运行 node --check 验证语法**

Run: `node --check src/proxy/handlers/chat.js`
Expected: 无输出，退出码 0

- [ ] **Step 4: Commit**

使用 `/git-commit`

---

### Task 2: 修改 resolveConfiguredModel 接受 fallbackSlot

**Files:**
- Modify: `src/proxy/handlers/chat.js:108-136`

- [ ] **Step 1: 写失败测试 — resolveConfiguredModel 使用 fallbackSlot**

新建 `test/unit/active-byok-slot.test.mjs`：

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requiresConfiguredDefaultModel,
  getActiveByokSlot,
  setActiveByokSlot,
} from "../../src/proxy/handlers/chat.js";
import { setRuntimeConfig } from "../../src/proxy/handlers/models.js";

// ── resolveConfiguredModel fallbackSlot ──

test("requiresConfiguredDefaultModel with fallbackSlot uses slot model", () => {
  setRuntimeConfig({
    defaultModel: "",
    BYOK1_MODEL: "",
    BYOK3_MODEL: "gpt-5.5",
  });

  // MODEL_SWE_1 无 fallbackSlot → 不需要默认模型（MODEL_MAP 硬编码了 claude-sonnet-4）
  assert.equal(
    requiresConfiguredDefaultModel("MODEL_SWE_1"),
    false,
    "无 fallbackSlot 时 MODEL_SWE_1 有硬编码回退"
  );

  // MODEL_SWE_1 + fallbackSlot=3 → 检查 BYOK3 是否配置了模型
  assert.equal(
    requiresConfiguredDefaultModel("MODEL_SWE_1", 3),
    false,
    "fallbackSlot=3 已配置 gpt-5.5，应允许"
  );
});

test("requiresConfiguredDefaultModel with fallbackSlot blocks unconfigured slot", () => {
  setRuntimeConfig({
    defaultModel: "",
    BYOK1_MODEL: "",
    BYOK3_MODEL: "",
  });

  assert.equal(
    requiresConfiguredDefaultModel("MODEL_SWE_1", 3),
    true,
    "fallbackSlot=3 未配置模型，应拦截"
  );
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node --test test/unit/active-byok-slot.test.mjs`
Expected: FAIL — `requiresConfiguredDefaultModel` 不接受第二参数，fallbackSlot 被忽略

- [ ] **Step 3: 修改 resolveConfiguredModel 实现**

`src/proxy/handlers/chat.js` 中 `resolveConfiguredModel` 函数签名和开头：

原代码：
```javascript
function resolveConfiguredModel(arg0) {
  const tmp1 = String(arg0 || '').trim();
  const tmp2 = getByokSlot(tmp1);
  if (tmp2) {
```

改为：
```javascript
function resolveConfiguredModel(arg0, fallbackSlot = null) {
  const tmp1 = String(arg0 || '').trim();
  const tmp2 = getByokSlot(tmp1);
  const tmp2e = tmp2 || fallbackSlot;
  if (tmp2e) {
```

同时将 `if (tmp2)` 块内的 `tmp2` 改为 `tmp2e`：
```javascript
  if (tmp2e) {
    const tmp02 = getSlotModel(tmp2e);
    if (!tmp02) {
      return '';
    }
    return MODEL_MAP[tmp02] && MODEL_MAP[tmp02] !== '__DEFAULT__' ? MODEL_MAP[tmp02] : tmp02;
  }
```

- [ ] **Step 4: 修改 requiresConfiguredDefaultModel 实现**

原代码：
```javascript
function requiresConfiguredDefaultModel(arg0) {
  const tmp1 = String(arg0 || '').trim();
  const tmp2 = getByokSlot(tmp1);

  // BYOK 槽位模型检查
  if (tmp2) {
    return !getSlotModel(tmp2);
  }
```

改为：
```javascript
function requiresConfiguredDefaultModel(arg0, fallbackSlot = null) {
  const tmp1 = String(arg0 || '').trim();
  const tmp2 = getByokSlot(tmp1);
  const tmp2e = tmp2 || fallbackSlot;

  // BYOK 槽位模型检查
  if (tmp2e) {
    return !getSlotModel(tmp2e);
  }
```

- [ ] **Step 5: 运行测试验证通过**

Run: `node --test test/unit/active-byok-slot.test.mjs`
Expected: PASS

- [ ] **Step 6: 运行已有测试确保无回归**

Run: `node --test test/unit/model-validation.test.mjs`
Expected: PASS（所有已有测试保持通过，因为 fallbackSlot 默认 null 不改变行为）

- [ ] **Step 7: Commit**

使用 `/git-commit`

---

### Task 3: handleGetChatMessage 中引入 effectiveSlot

**Files:**
- Modify: `src/proxy/handlers/chat.js:467-636`

- [ ] **Step 1: 写失败测试 — _activeByokSlot 状态追踪**

在 `test/unit/active-byok-slot.test.mjs` 追加：

```javascript
test("setActiveByokSlot / getActiveByokSlot 状态管理", () => {
  setActiveByokSlot(null);
  assert.equal(getActiveByokSlot(), null);

  setActiveByokSlot(3);
  assert.equal(getActiveByokSlot(), 3);

  setActiveByokSlot(1);
  assert.equal(getActiveByokSlot(), 1, "新槽位覆盖旧值");
});

test("requiresConfiguredDefaultModel + activeByokSlot 继承验证", () => {
  setRuntimeConfig({
    defaultModel: "",
    BYOK1_MODEL: "",
    BYOK3_MODEL: "gpt-5.5",
  });

  // 模拟：先有 BYOK3 主请求设置了 activeSlot
  setActiveByokSlot(3);

  // 子请求 MODEL_SWE_1 + fallbackSlot=3（来自 activeByokSlot）
  assert.equal(
    requiresConfiguredDefaultModel("MODEL_SWE_1", 3),
    false,
    "继承 slot 3 的 gpt-5.5 配置"
  );

  // 清理
  setActiveByokSlot(null);
});
```

- [ ] **Step 2: 运行测试验证通过**

Run: `node --test test/unit/active-byok-slot.test.mjs`
Expected: PASS（getter/setter 和 requiresConfiguredDefaultModel 已在 Task 1-2 实现）

- [ ] **Step 3: 修改 handleGetChatMessage — effectiveSlot 计算 + 日志**

在 `handleGetChatMessage` 中，`const tmp10 = getByokSlot(tmp7);` 之后添加 effectiveSlot 逻辑：

原代码：
```javascript
  const tmp10 = getByokSlot(tmp7);

  // ✅ 提前验证模型配置
  if (requiresConfiguredDefaultModel(tmp7)) {
```

改为：
```javascript
  const tmp10 = getByokSlot(tmp7);
  if (tmp10) {
    _activeByokSlot = tmp10;
  }
  const effectiveSlot = tmp10 || _activeByokSlot;
  if (!tmp10 && effectiveSlot) {
    console.log('  🔗 Sub-request ' + (tmp7 || 'unknown') + ' inheriting active BYOK slot ' + effectiveSlot);
  }

  // ✅ 提前验证模型配置
  if (requiresConfiguredDefaultModel(tmp7, effectiveSlot)) {
```

- [ ] **Step 4: 替换所有下游 tmp10 → effectiveSlot**

在 `handleGetChatMessage` 函数内，将以下所有 `tmp10` 引用改为 `effectiveSlot`：

1. 错误消息分支（约 line 482-493）：`if (tmp10 === 2)` → `if (effectiveSlot === 2)` 等
2. `let tmp11 = resolveConfiguredModel(tmp7);` → `let tmp11 = resolveConfiguredModel(tmp7, effectiveSlot);`
3. `const tmp13 = buildThinkingOptions(tmp11, isOpenAIModel(tmp11), tmp10);` → `..., effectiveSlot);`
4. `if (!tmp10) tmp11 = stripThinkingSuffix(tmp11);` → `if (!effectiveSlot) tmp11 = stripThinkingSuffix(tmp11);`
5. `const tmp14 = getProviderConfig(tmp10);` → `getProviderConfig(effectiveSlot);`
6. `const tmp16 = getServiceTier(tmp7, tmp11, tmp10);` → `..., effectiveSlot);`
7. `byokSlot: tmp10,`（两处：streamOpenAI 和 streamAnthropic 的选项对象）→ `byokSlot: effectiveSlot,`

**注意**：`tmp10` 的原始声明 `const tmp10 = getByokSlot(tmp7);` 保留不变，仅下游引用改为 `effectiveSlot`。

- [ ] **Step 5: 运行 node --check 验证语法**

Run: `node --check src/proxy/handlers/chat.js`
Expected: 无输出，退出码 0

- [ ] **Step 6: 运行所有单元测试**

Run: `node --test test/unit/active-byok-slot.test.mjs test/unit/model-validation.test.mjs test/unit/byok-503-fallback-title-guard.test.mjs`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

使用 `/git-commit`

---

### Task 4: 完整场景测试

**Files:**
- Modify: `test/unit/active-byok-slot.test.mjs`

- [ ] **Step 1: 添加完整场景测试**

在 `test/unit/active-byok-slot.test.mjs` 追加：

```javascript
test("直接 BYOK 匹配优先于继承槽位", () => {
  setRuntimeConfig({
    BYOK1_MODEL: "claude-opus-4",
    BYOK3_MODEL: "gpt-5.5",
  });

  setActiveByokSlot(3);

  // MODEL_CLAUDE_4_OPUS_BYOK 直接匹配 slot 1，不继承 slot 3
  assert.equal(
    requiresConfiguredDefaultModel("MODEL_CLAUDE_4_OPUS_BYOK", 1),
    false,
    "直接匹配 slot 1"
  );
});

test("用户切换槽位更新 _activeByokSlot", () => {
  setActiveByokSlot(1);
  assert.equal(getActiveByokSlot(), 1);

  setActiveByokSlot(3);
  assert.equal(getActiveByokSlot(), 3, "切换到 slot 3");

  setActiveByokSlot(2);
  assert.equal(getActiveByokSlot(), 2, "切换到 slot 2");
});

test("未设置 _activeByokSlot 时向后兼容", () => {
  setRuntimeConfig({
    defaultModel: "",
    BYOK1_MODEL: "",
  });

  setActiveByokSlot(null);

  // MODEL_CHAT 映射到 __DEFAULT__，无默认模型 → 应拦截
  assert.equal(
    requiresConfiguredDefaultModel("MODEL_CHAT"),
    true,
    "无 activeSlot 时走原有 MODEL_MAP 回退"
  );

  // MODEL_SWE_1 有硬编码回退 → 不拦截
  assert.equal(
    requiresConfiguredDefaultModel("MODEL_SWE_1"),
    false,
    "MODEL_SWE_1 有硬编码 claude-sonnet-4 回退"
  );
});
```

- [ ] **Step 2: 运行全部测试**

Run: `node --test test/unit/active-byok-slot.test.mjs`
Expected: 全部 PASS

- [ ] **Step 3: 运行完整测试套件**

Run: `node --test test/unit/*.test.mjs`
Expected: 全部 PASS，无回归

- [ ] **Step 4: Commit**

使用 `/git-commit`
