# BYOK 上下文压缩阈值修复 — 设计文档

- **日期**: 2026-07-26
- **分支**: TBD（实施前创建功能分支）
- **状态**: 设计已批准，待实施
- **前置文档**: [`2026-07-09-byok-context-window-display-fix.md`](./2026-07-09-byok-context-window-display-fix.md)

## 背景

前置文档修复了 UI 上下文分母显示问题：将 `GetUserStatus` 响应中 `ClientModelConfig` 本级 `field18` (max_tokens) 从 200K 改写为配置值（如 1M），使 UI 正确显示 `151K / 1M`。

但用户发现实际使用中上下文在 **~150K（约 15%）就自动触发压缩/摘要**，之后回落到 ~130K（约 13%），永远无法真正利用 1M 窗口。UI 分母虽然显示 1M，但压缩行为仍然按 200K 窗口运作。

## 根因

### 客户端双字段分离读取

`GetUserStatus` 的每个 `ClientModelConfig` 条目包含两个上下文相关字段：

| 字段 | 位置 | 作用 | 当前改写状态 |
|---|---|---|---|
| `field18` (max_tokens) | CMC 本级 | UI 显示分母 | ✅ 已改为 1M |
| `field23.field4` (context_window) | model_info 子消息内 | 客户端上下文压缩阈值 | ❌ 仍为 200K |

Devin 客户端存在两套独立的读取路径：
1. **UI 显示逻辑** `wtt()` → 读 `maxTokens` (field18) → 显示 1M
2. **上下文管理/压缩逻辑** → 读 `model_info.context_window` (field23.field4) → 200K → 在 ~75% = 150K 触发压缩

### 观测证据

- UI 显示 `15% (151K / 1M)` → field18 改写生效 ✓
- 到 15% 就停涨、回落到 13% → 压缩阈值 ≈ 150K = 200K × 75%
- 200K 是 field23.field4 的官方默认值 → 未被改写

### 结论

前置文档修复了**显示层**但遗漏了**行为层**。需要同时改写 field23.field4 才能让 1M 窗口真正生效。

## 目标

在现有 `field18` 改写的基础上，**同时改写** `field23.field4` (model_info.context_window)，使两个字段保持一致。

确保：
1. UI 显示正确（field18 = 配置值）✓ 已有
2. 压缩阈值正确（field23.field4 = 配置值）← **新增**
3. 不影响非 BYOK 条目
4. 改写仍然无损、幂等、异常安全

## 改写算法

### 新增常量

```js
const CMC_MODEL_INFO_FIELD = 23;   // model_info 子消息的 field 号
const MI_CONTEXT_WINDOW_FIELD = 4; // model_info 内 context_window 的 field 号
```

### 现有流程（不变）

```
rewriteModelEntry(entryBuf, resolver, state):
  parseWithRaw(entryBuf) → fields[]
  读 field22 (model_uid) → resolver(modelUid) → window
  遍历 fields:
    field18 (wireType=0) → writeVarintField(18, window)
    其余 → f.raw 原样保留
```

### 扩展后流程

```
rewriteModelEntry(entryBuf, resolver, state):
  parseWithRaw(entryBuf) → fields[]
  读 field22 (model_uid) → resolver(modelUid) → window
  遍历 fields:
    field18 (max_tokens, wireType=0) → writeVarintField(18, window)     ← 已有
    field23 (model_info, wireType=2) → rewriteModelInfo(f.value, window) ← 新增
    其余 → f.raw 原样保留

新增函数 rewriteModelInfo(modelInfoBuf, targetWindow):
  parseWithRaw(modelInfoBuf) → infoFields[]
  遍历 infoFields:
    field4 (context_window, wireType=0):
      若值 ≠ targetWindow → writeVarintField(4, targetWindow)
      否则 → f.raw 原样
    其余 → f.raw 原样
  若无 field4 → 不追加（保守策略）
  有变更 → return 重建后的 Buffer
  无变更 → return null（原样保留）
```

### 关键设计点

- **`rewriteModelInfo` 与 `rewriteModelEntry` 结构一致**：先解析、后遍历、按需改写、其余原样保留
- **父级 length 自动重算**：field23 改写后通过 `writeBytesField(23, rebuilt)` 重新包裹，length 前缀自动按新大小计算
- **变长安全**：200K→1M 恰好等长（3字节 varint: C0 9A 0C → C0 84 3D），但算法不依赖等长假设
- **保守策略**：field23 不存在或内部无 field4 时不追加，仅改 field18（维持当前行为）

### protobuf 结构示意

```
ClientModelConfig 条目 (field1, repeated)
├─ field1  = label          (string, e.g. 'Claude Opus 4 BYOK')
├─ field18 = max_tokens     (varint, 200000 → 改为 1000000)   ← 已有
├─ field22 = model_uid      (string, 用于匹配 BYOK 槽位)
└─ field23 = model_info     (message, 子消息)                  ← 新增改写
   ├─ field1 = model_id     (varint, e.g. 277)
   ├─ field4 = context_window (varint, 200000 → 改为 1000000) ← 新增目标
   └─ ...其余字段原样保留
```

## 涉及文件

| 文件 | 改动 |
|---|---|
| `src/proxy/handlers/context-window-rewrite.js` | 新增 `CMC_MODEL_INFO_FIELD`、`MI_CONTEXT_WINDOW_FIELD` 常量；新增 `rewriteModelInfo()` 函数；`rewriteModelEntry()` 中对 field23 增加递归改写分支 |

**仅改动 1 个文件**。`hybrid-server.js`、`byok-slots.js`、`models.js`、`proxyManager.js` 等均无需变更。

## 测试策略

### 补充单元测试 — `test/unit/context-window-rewrite.test.mjs`

1. **field23.field4 改写正确性**：构造含 field23 子消息（内含 field4=200000）的条目，resolver 返回 1M → 断言 field18=1M 且 field23 内 field4=1M
2. **无 field23 的条目**：条目没有 field23 → 只改 field18，不报错
3. **field23 无 field4 的条目**：field23 存在但内部无 field4 → 不追加，仅改 field18
4. **幂等性**：两次改写结果一致（输出 buffer 完全相同）

### 不做的测试（YAGNI）

- 不测真实 GetUserStatus 网络请求
- 不测客户端压缩行为（客户端黑盒）

## 错误处理

与现有策略完全一致，新增函数遵循相同模式：

1. `rewriteModelInfo` 内部 `parseWithRaw` 失败 → 返回 null（field23 原样保留）
2. `rewriteModelEntry` 顶层对 field23 处理异常 → 该字段原样保留，不影响 field18 改写
3. 最外层 `rewriteUserStatusContextWindow` 的 try/catch 兜底 → `{ changed: false }`
4. **永不破坏响应**

## 验证流程

1. 单元测试全通过
2. 同步到运行副本 `C:\Users\cz\.windsurf\extensions\jornlin.devin-byok-plus-<ver>\proxy-scripts\src\`
3. **完全重启 Devin**（清除 GetUserStatus 缓存）
4. 开始长对话，观察 context used 是否能超过 150K 继续增长到更高值
5. 确认 UI 分母仍显示 1M
6. 确认代理日志中 `GetUserStatus contextWindow rewritten` 仍正常打印

## 教训

在前置修复中，确认 "UI 不读 field23.field4" 后就完全放弃了该字段。但客户端有**多套消费路径**——UI 显示是一套，上下文管理/压缩是另一套。修复显示层问题时，需同步考虑行为层是否也依赖同源数据的不同字段。
