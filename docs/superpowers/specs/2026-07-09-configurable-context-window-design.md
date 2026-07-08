# 可配置 BYOK 上下文窗口 — 设计文档

- **日期**: 2026-07-09
- **分支**: `feat/configurable-context-window`
- **状态**: 已实现（四槽位 model ID 277/278/279/280 均已抓包确认并落地）

## 背景与目标

Devin 中的 BYOK 模型（如 "Claude Opus 4 BYOK"）在界面上显示的上下文窗口固定为 200K。经抓包与验证，该显示值来源于 `GetUserStatus` RPC 响应中模型数组里对应模型条目的 `field4`（contextWindow）字段。将其改写为更大的值（如 1000000）后，Devin UI 会显示并按该值运作。

**目标**：让每个 BYOK 槽位（BYOK1~4）可独立配置上下文窗口档位（**原始 / 500K / 1M**），通过改写 `GetUserStatus` 响应中对应模型条目的 `field4` 实现。默认"原始"= 不改写，保持官方 200K。

## 根因（已确认）

- UI 上下文分母来源 = `GetUserStatus` 响应模型数组（路径 `1.33.1.23`，repeated）里对应模型条目的 `field4`（contextWindow）。
- 规律：空会话显示占位默认 200K；发出第一条消息后客户端读取被改写的 `field4`，显示真实值。
- `GetUserStatus` RPC 位于 `server.self-serve.windsurf.com`，走 MITM/直连路径，body 整体 gzip（magic `1f 8b`），需 `gunzip → 解析/改写 → gzip` 重压。
- 槽位与模型映射（`byok-slots.js` 的 `BYOK_SLOT_BY_REQUEST`）：OPUS=1, OPUS_THINKING=2, SONNET=3, SONNET_THINKING=4。
- BYOK 模型条目 `field1`（模型数值 ID）四个均已抓包确认：OPUS=277、OPUS_THINKING=278、SONNET=279、SONNET_THINKING=280。

## 关键设计决策

1. **配置粒度**：每槽位独立可配（BYOK1~4 各有独立 `CONTEXT_WINDOW`）。
2. **输入形式**：预设档位下拉。
3. **档位集合**：原始（0，不改写）/ 500K / 1M；默认"原始"。
4. **模型映射**：按槽位映射对应模型（BYOK1→OPUS，BYOK2→OPUS_THINKING，BYOK3→SONNET，BYOK4→SONNET_THINKING），各条目用其独有 field1 ID 定位。
5. **定位方式**：结构化解析模型数组（非硬编码字节锚点），一劳永逸适应官方变更并正确处理变长 varint。

## 架构与数据流

### 配置下行链路（复用现有 per-slot 配置架构）

```
侧栏下拉(每槽一个: 原始/500K/1M)
   │  postMessage
   ▼
sidebarProvider  ──写▶  .env: BYOK{N}_CONTEXT_WINDOW=<0|500000|1000000>
   │                │
   │ reloadRuntimeConfig      │ 进程启动时
   ▼ (/api/config 热更新)      ▼
proxyManager.buildRuntimeConfigPatch      models.js readSlotConfigFromEnv
   │                          │
   └──────────┬───────────────┘
              ▼
   models.js _runtimeConfig.byok{N}.contextWindow  (运行态权威值)
```

### 改写执行链路

```
Devin ──GetUserStatus──▶ hybrid-server.proxyToCodeium (非流式响应分支)
                              ▼
              rewriteUserStatusContextWindow(payload):
                gunzip ▶ 结构化解析模型数组(1.33.1.23)
                       ▶ 对每个模型条目, 按模型 ID 匹配到 BYOK 槽位
                       ▶ 若该槽位 contextWindow > 0, 重建其 field4
                       ▶ 重算受影响的父级 length ▶ gzipSync
                              ▼
                     改写后的响应回传 Devin
```

### 设计原则

- **运行态权威**：改写逻辑只读 `_runtimeConfig.byok{N}.contextWindow`，不自读 env，使热更新即时生效。
- **结构化重建、非字节替换**：用 `parseFields` 解析并重建，任意档位值都能正确编码，不受 varint 长度变化影响。
- **默认零副作用**：槽位为"原始"档（值 0）时完全不碰该条目。

## 模块职责与接口

### 1. `src/proxy/handlers/byok-slots.js` — 槽位常量与模型映射

- `SLOT_CONFIG_FIELDS` 加入 `"CONTEXT_WINDOW"`。
- 新增 `CONTEXT_WINDOW_PRESETS = { 0: "原始", 500000: "500K", 1000000: "1M" }`。
- 新增 `sanitizeContextWindow(value)` → 返回 `0 | 500000 | 1000000`（非法值归 0）。
- 新增 `SLOT_MODEL_ID`：槽位 → GetUserStatus 模型条目 field1 数值 ID 映射（OPUS=277 已确认，其余待抓包填入）。
- 依赖：无。

### 2. `src/proxy/handlers/models.js` — 配置读取与运行态

- `readSlotConfigFromEnv(slot)` 增读 `BYOK{N}_CONTEXT_WINDOW`，经 `sanitizeContextWindow` 写入 slot 的 `contextWindow` 字段。
- `_emptySlot` / `_legacySlotFallback` 加 `contextWindow: 0`。
- 新增导出 `getSlotContextWindow(slot) → number`。

### 3. `src/proxy/handlers/context-window-rewrite.js` — 新建，纯改写逻辑

- 导出 `rewriteUserStatusContextWindow(decodedBuffer, slotWindowResolver) → { buffer, changed, count }`。
- 入参：已 gunzip 的 payload；`(modelId) → window` 解析函数。
- 纯函数，不碰 gzip/网络，便于单元测试。
- 依赖：`proto.js`（parseFields/encodeVarint/writeVarintField）。

### 4. `src/proxy/hybrid-server.js` — 改写钩子接入

- 在 `proxyToCodeium` 非流式响应分支，`GetUserStatus` 且 gzip 时：`tryGunzip → rewriteUserStatusContextWindow → 若 changed 则 gzipSync 回写`。仅胶水代码。
- 依赖：模块 2、3，及 `connect.js`（gzipSync/tryGunzip）。

### 5. `proxyManager.js` + `sidebarProvider.js` + webview — 配置持久化与 UI

- `writeEnvConfig` 白名单加 4 个 `BYOK{N}_CONTEXT_WINDOW`；`buildRuntimeConfigPatch` 带上。
- `sidebarProvider` 处理下拉 postMessage 写入配置。
- webview 每个槽位加三档下拉。
- 依赖：模块 1。

## 改写算法（结构化解析与重建）

### 嵌套结构

```
顶层
└─ field1  (msg)
   └─ field33 (msg)
      └─ field1 (msg)
         └─ field23 (repeated msg)   ← 每个元素是一个模型条目
            ├─ field1 = 模型数值ID   (如 OPUS_BYOK = 277)
            └─ field4 = contextWindow (200000)
```

### 路径导向的局部重建

```
rewrite(buf, path=[1,33,1]):
  fields = parseFields(buf)
  重编每个 field:
    - 若 field 号是 path 首元素(中间节点, wireType2):
        递归 rewrite(inner, path[1:]) 后用 writeBytesField 重新包裹
    - 其余字段: 用原 value 原样重编(无损)
  path 走完(到达含 repeated field23 的层):
    遍历每个 field23 条目:
      读条目内 field1(模型ID)
      若 resolver(模型ID) 返回窗口值 > 0:
        用该值重建条目的 field4(writeVarintField)
        其余字段原样保留 → writeBytesField 重新包裹条目
      否则整条原样保留
```

- **父级 length 自动正确**：每层用 `writeBytesField`（内部按新长度写 length 前缀），无需手工算偏移，变长自动沿链传播。
- **有利观察**：三档值 varint 恰好都是 3 字节（`200000=C0 9A 0C`、`500000=A0 C2 1E`、`1000000=C0 84 3D`），当前档位下天然等长；但算法仍按变长正确处理，未来加档位无需改代码。

## 错误处理与边界

### 核心原则：改写永不破坏响应

任何环节出问题必须优雅退化为原样透传。

### 分层防护

1. **顶层 try/catch**：整个改写包在 try/catch，异常 → `{ changed: false }`，回传原始未解压字节。
2. **changed 标志门控**：只有真正命中并改动时才 gzipSync 重压；无命中直接透传原 gzip 字节（零开销）。
3. **解析健壮性**：任一层结构不符预期 → 该层原样保留。

### 关键边界

- **条目锁定**：仅 field1 精确等于 `SLOT_MODEL_ID` 登记的 ID 时才改，官方新增/未登记模型跳过。
- **幂等性**：反复经过不累积副作用。
- **gzip magic 校验**：仅 `1f 8b` 开头才进改写路径。
- **MITM 与直连双路径**：钩子在 `proxyToCodeium` 内，两条路径自动覆盖。
- **空/超短 payload**：透传。

### 可观测性

命中时打印一行简洁日志（model ID + 新窗口值 + 改动条目数）；失败打印 `ctx-rewrite error`。不写临时文件、不引入探针。

## 测试策略

沿用 `node:test` + `node:assert/strict`，直接 import 模块函数。

### 单元测试 — `test/unit/context-window-rewrite.test.mjs`

- **核心正确性**：构造含嵌套 `1.33.1.23` 模型数组的 buffer，resolver 返回 1M → 断言目标条目 field4=1000000，其余条目逐字节不变；500K 档 → 500000；"原始"档 → `changed=false`，输出与输入一致。
- **多槽位**：两个 BYOK 条目分别配 500K/1M → 各自正确，互不干扰。
- **round-trip 无损**：未改动 buffer 重建 → 输出 === 输入。
- **变长健壮性**：临时用 4 字节 varint 值 → 父级 length 前缀正确增长，整体可完整解回。
- **边界/防护**：截断/畸形 buffer → `changed=false` 不抛异常；未登记 ID 不改；幂等。

### 配置层测试

- `sanitizeContextWindow`：合法透传、非法归 0。
- `readSlotConfigFromEnv` 读 `BYOK{N}_CONTEXT_WINDOW` → `contextWindow`。
- `getSlotContextWindow(1..4)` 返回运行态值，热更新后变化。

### 不做的测试（YAGNI）

- 不测真实网络 `GetUserStatus`。
- 不测 UI 渲染，仅测 sidebarProvider 配置读写逻辑。

## 实现阶段前置任务（已完成）

`SLOT_MODEL_ID` 四个模型的 field1 数值 ID 已通过一次 `GetUserStatus` 抓包全部确认并落地：OPUS_BYOK=277、OPUS_THINKING_BYOK=278、SONNET_BYOK=279、SONNET_THINKING_BYOK=280。抓包用的临时 dump 代码与解析脚本已按"用完即删"清理。四个槽位现均端到端可用。
