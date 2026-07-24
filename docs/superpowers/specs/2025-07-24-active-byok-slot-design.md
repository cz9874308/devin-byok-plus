# Active BYOK Slot — 子请求槽位继承

## 问题

当用户选择 BYOK3（Claude Sonnet 4 BYOK）时，Devin 只在主请求中发送 `MODEL_CLAUDE_4_SONNET_BYOK` → 正确路由到 slot 3。但 Devin 内部的子请求（SWE Agent、标题生成、Fast Context 等）携带不同的模型标识符（如 `MODEL_SWE_1`、`MODEL_CHAT`），这些标识符：

1. 不在 `BYOK_SLOT_BY_REQUEST` 映射中 → `getByokSlot()` 返回 null
2. 在 `MODEL_MAP` 中被硬编码为 Claude 模型名 → 走 Anthropic 路由
3. `getProviderConfig(null)` 回退到 BYOK1 的配置

**结果**：子请求使用错误的模型、错误的密钥、错误的端点。当 BYOK1 和 BYOK3 使用不同提供商时直接报错。

## 根因

代理没有"活跃会话槽位"的概念。`handleGetChatMessage` 对每个请求独立调用 `getByokSlot(requestedModel)`，子请求的模型标识符不在映射中就丢失了会话级槽位信息。

## 设计原则

在 BYOK 场景下，用户选了哪个槽位，所有请求（包括子请求）都应该使用该槽位的模型和配置。子请求没有理由使用不同的模型——用户自己付费，不存在成本优化需求。

## 方案

### 状态追踪

在 `chat.js` 模块级添加 `_activeByokSlot` 状态变量：

```javascript
let _activeByokSlot = null;
export function getActiveByokSlot() { return _activeByokSlot; }
export function setActiveByokSlot(slot) { _activeByokSlot = slot; }
```

### 更新时机

在 `handleGetChatMessage` 入口：

```javascript
const tmp10 = getByokSlot(tmp7);       // 直接匹配
if (tmp10) {
  _activeByokSlot = tmp10;              // 任何 BYOK 请求都更新
}
const effectiveSlot = tmp10 || _activeByokSlot;  // 子请求继承
```

- 不检查 `initiator` — BYOK 模型标识符出现即意味着会话使用该槽位
- 不需要清除 — 新 BYOK 请求自动覆盖
- 首次未设置 → `effectiveSlot = null` → 走现有 MODEL_MAP 回退（向后兼容）

### effectiveSlot 替代 tmp10

`handleGetChatMessage` 中所有下游调用从 `tmp10` 改为 `effectiveSlot`：

| 原调用 | 改为 |
|--------|------|
| `requiresConfiguredDefaultModel(tmp7)` | `requiresConfiguredDefaultModel(tmp7, effectiveSlot)` |
| `resolveConfiguredModel(tmp7)` | `resolveConfiguredModel(tmp7, effectiveSlot)` |
| `buildThinkingOptions(tmp11, ..., tmp10)` | `buildThinkingOptions(tmp11, ..., effectiveSlot)` |
| `getProviderConfig(tmp10)` | `getProviderConfig(effectiveSlot)` |
| `getServiceTier(tmp7, tmp11, tmp10)` | `getServiceTier(tmp7, tmp11, effectiveSlot)` |
| `byokSlot: tmp10` | `byokSlot: effectiveSlot` |

### resolveConfiguredModel 签名变更

```javascript
function resolveConfiguredModel(arg0, fallbackSlot = null) {
  const tmp1 = String(arg0 || '').trim();
  const tmp2 = getByokSlot(tmp1);
  const slot = tmp2 || fallbackSlot;
  if (slot) {
    const tmp02 = getSlotModel(slot);
    if (!tmp02) { return ''; }
    return MODEL_MAP[tmp02] && MODEL_MAP[tmp02] !== '__DEFAULT__' ? MODEL_MAP[tmp02] : tmp02;
  }
  // 以下不变（仅在无任何槽位时才走 MODEL_MAP 回退）
}
```

### requiresConfiguredDefaultModel 签名变更

```javascript
function requiresConfiguredDefaultModel(arg0, fallbackSlot = null) {
  const tmp1 = String(arg0 || '').trim();
  const tmp2 = getByokSlot(tmp1);
  const slot = tmp2 || fallbackSlot;
  if (slot) {
    return !getSlotModel(slot);
  }
  // 以下不变
}
```

### 日志增强

子请求继承槽位时输出：

```javascript
if (!tmp10 && effectiveSlot) {
  console.log('  🔗 Sub-request ' + (tmp7 || 'unknown') + ' inheriting active BYOK slot ' + effectiveSlot);
}
```

## 改动范围

| 文件 | 改动内容 |
|------|----------|
| `src/proxy/handlers/chat.js` | 添加 `_activeByokSlot` + getter/setter；修改 `resolveConfiguredModel`、`requiresConfiguredDefaultModel` 签名；`handleGetChatMessage` 用 `effectiveSlot` 替代 `tmp10` |
| `test/unit/active-byok-slot.test.mjs` | 新建单元测试 |

不改 `models.js`、`byok-slots.js`、`hybrid-server.js`。

## 测试用例

1. BYOK 请求设置 `_activeByokSlot`
2. 子请求（`MODEL_SWE_1`）继承 `_activeByokSlot` → 返回槽位模型
3. 直接 BYOK 匹配优先于继承槽位
4. 用户切换槽位 → `_activeByokSlot` 更新
5. 未设置 `_activeByokSlot` → 回退到 MODEL_MAP（向后兼容）
6. `resolveConfiguredModel` + `fallbackSlot` 正确使用槽位模型
7. `requiresConfiguredDefaultModel` + `fallbackSlot` 正确检查槽位

## 边界情况

- **代理刚启动，无 BYOK 请求**：`_activeByokSlot = null`，走现有 MODEL_MAP 回退，向后兼容
- **用户切换槽位**：下一个 BYOK 请求自动更新 `_activeByokSlot`
- **并发请求**：Devin 单用户单会话，不存在并发冲突
