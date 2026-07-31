# BYOK 模型条目注入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 服务端已下架四条 BYOK 模型条目。在代理层向 `GetUserStatus` 响应回放 2026-07-09 抓包字节补回条目，使下拉列表恢复可选。

**Architecture:** 抽出 `userstatus-shape.js` 作为报文形状知识的唯一归属，供「注入」与「改窗口」两个 transform 共用。`hybrid-server.js` 内串联 ① 注入 → ② 改窗口。

**Tech Stack:** Node.js, `node:test`, protobuf 二进制操作 (`proto.js`)

**设计文档:** `docs/superpowers/specs/2026-07-31-byok-entry-injection-design.md`

---

## File Structure

| 文件 | 角色 | 改动类型 |
|---|---|---|
| `src/proxy/handlers/userstatus-shape.js` | 报文形状知识（路径/字段号/无损遍历） | **Create** |
| `src/proxy/handlers/byok-entry-inject.js` | 4 条复刻字节 + 补齐缺失 | **Create** |
| `src/proxy/handlers/context-window-rewrite.js` | 只保留「改窗口」规则 | **Modify** — 删私有解析器，改用 shape |
| `src/proxy/hybrid-server.js` | 编排（仅胶水） | **Modify** — 串联 ①→② |
| `test/unit/userstatus-shape.test.mjs` | shape 模块单测 | **Create** |
| `test/unit/byok-entry-inject.test.mjs` | 注入模块单测 | **Create** |
| `test/unit/context-window-rewrite.test.mjs` | 既有 15 个测试 | **不改** — 重构的回归网 |

---

### Task 1: 创建功能分支

- [ ] **Step 1: 从 main 创建分支**

```bash
git checkout -b feat/byok-entry-injection
```

- [ ] **Step 2: 确认分支与基线**

Run: `git branch --show-current`
Expected: `feat/byok-entry-injection`

Run: `node --test test/unit/context-window-rewrite.test.mjs`
Expected: 15 tests PASS — 记录此基线，后续重构必须保持

---

### Task 2: 新建 userstatus-shape.js

**动机:** 报文形状知识目前私有在 `context-window-rewrite.js`。注入需要同一份知识，复制或塞进改写器都不合适。

**Files:**
- Create: `src/proxy/handlers/userstatus-shape.js`

- [ ] **Step 1: 写模块**

```js
import { decodeVarint, writeBytesField } from "../proto.js";

// GetUserStatus 模型数组嵌套路径: 顶层.field1 -> field33 -> (repeated field1 = ClientModelConfig 条目)
export const MODEL_ARRAY_PATH = [1, 33];
export const CMC_ENTRY_FIELD = 1;
export const CMC_LABEL_FIELD = 1;
export const CMC_MAX_TOKENS_FIELD = 18;
export const CMC_MODEL_UID_FIELD = 22;
export const CMC_MODEL_INFO_FIELD = 23;
export const CMC_ACCESS_FIELD = 24;
export const MI_CONTEXT_WINDOW_FIELD = 4;

// 带偏移的 protobuf 解析: 为每个字段保留其完整原始字节(tag+value),
// 便于未改动字段原样重编, 保证无损 round-trip。
export function parseWithRaw(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const tagStart = pos;
    const tagDec = decodeVarint(buf, pos);
    pos += tagDec.bytesRead;
    const field = Number(tagDec.value >> 0x3n);
    const wireType = Number(tagDec.value & 0x7n);
    if (field === 0) {
      break;
    }
    let value = null;
    switch (wireType) {
      case 0: {
        const dec = decodeVarint(buf, pos);
        pos += dec.bytesRead;
        value = dec.value;
        break;
      }
      case 1: {
        value = buf.subarray(pos, pos + 8);
        pos += 8;
        break;
      }
      case 2: {
        const lenDec = decodeVarint(buf, pos);
        pos += lenDec.bytesRead;
        const len = Number(lenDec.value);
        value = buf.subarray(pos, pos + len);
        pos += len;
        break;
      }
      case 5: {
        value = buf.subarray(pos, pos + 4);
        pos += 4;
        break;
      }
      default:
        return { fields, ok: false };
    }
    fields.push({ field, wireType, value, raw: buf.subarray(tagStart, pos) });
  }
  return { fields, ok: true };
}

// 读取 ClientModelConfig 条目的 model_uid(field22)。
export function readModelUid(entryBuf) {
  const parsed = parseWithRaw(entryBuf);
  if (!parsed.ok) {
    return null;
  }
  for (const f of parsed.fields) {
    if (f.field === CMC_MODEL_UID_FIELD && f.wireType === 2 && f.value) {
      return f.value.toString("utf8");
    }
  }
  return null;
}

function descend(buf, path, handler, state) {
  const parsed = parseWithRaw(buf);
  if (!parsed.ok) {
    return buf;
  }
  const parts = [];
  for (const f of parsed.fields) {
    if (path.length > 0) {
      if (f.field === path[0] && f.wireType === 2) {
        parts.push(writeBytesField(f.field, descend(f.value, path.slice(1), handler, state)));
      } else {
        parts.push(f.raw);
      }
      continue;
    }
    if (f.field === CMC_ENTRY_FIELD && f.wireType === 2) {
      const uid = readModelUid(f.value);
      state.existingUids.push(uid);
      if (handler.mapEntry) {
        const rebuilt = handler.mapEntry(f.value, uid);
        if (rebuilt !== null && rebuilt !== undefined) {
          parts.push(writeBytesField(CMC_ENTRY_FIELD, rebuilt));
          state.count++;
          continue;
        }
      }
      parts.push(f.raw);
      continue;
    }
    parts.push(f.raw);
  }
  if (path.length === 0 && handler.appendEntries) {
    const uids = state.existingUids.filter(Boolean);
    for (const payload of handler.appendEntries(new Set(uids))) {
      parts.push(writeBytesField(CMC_ENTRY_FIELD, payload));
      state.count++;
    }
  }
  return Buffer.concat(parts);
}

// 沿 MODEL_ARRAY_PATH 下探到模型数组层, 按 handler 语义变换。
// handler 必须且只能提供 mapEntry / appendEntries 其一:
//   mapEntry(entryBuf, modelUid) -> Buffer | null   逐条改写, null = 原样保留
//   appendEntries(existingUids)  -> Buffer[]        数组级补齐, 返回待追加 payload
// 两键同传视为契约违用直接抛错, 避免隐式顺序依赖。
// 任何异常退化为原样透传。
export function transformModelArray(decoded, handler) {
  if (handler.mapEntry && handler.appendEntries) {
    throw new Error("transformModelArray: mapEntry 与 appendEntries 只能提供其一");
  }
  const state = { count: 0, existingUids: [] };
  try {
    const buffer = descend(decoded, MODEL_ARRAY_PATH, handler, state);
    return { buffer, changed: state.count > 0, count: state.count };
  } catch {
    return { buffer: decoded, changed: false, count: 0 };
  }
}
```

- [ ] **Step 2: 语法检查**

Run: `node --check src/proxy/handlers/userstatus-shape.js`
Expected: 无输出

- [ ] **Step 3: 写单测 `test/unit/userstatus-shape.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { transformModelArray, readModelUid, parseWithRaw } from "../../src/proxy/handlers/userstatus-shape.js";
import { writeVarintField, writeBytesField, writeStringField } from "../../src/proxy/proto.js";

function buildEntry(uid, maxTokens) {
  return Buffer.concat([writeStringField(22, uid), writeVarintField(18, maxTokens)]);
}

function buildUserStatus(entries) {
  return writeBytesField(1, writeBytesField(33, Buffer.concat(entries.map((e) => writeBytesField(1, e)))));
}

test("readModelUid 读出 field22", () => {
  assert.equal(readModelUid(buildEntry("MODEL_X", 200000)), "MODEL_X");
});

test("mapEntry 全返回 null: round-trip 无损", () => {
  const input = buildUserStatus([buildEntry("A", 1), buildEntry("B", 2)]);
  const { buffer, changed } = transformModelArray(input, { mapEntry: () => null });
  assert.equal(changed, false);
  assert.deepEqual(buffer, input);
});

test("mapEntry 改写命中条目, 其余原样", () => {
  const input = buildUserStatus([buildEntry("A", 1), buildEntry("B", 2)]);
  const { buffer, changed, count } = transformModelArray(input, {
    mapEntry: (buf, uid) => (uid === "B" ? buildEntry("B", 999) : null),
  });
  assert.equal(changed, true);
  assert.equal(count, 1);
  assert.ok(buffer.includes(Buffer.from("A", "utf8")));
});

test("appendEntries 拿到已存在 uid 集合并追加", () => {
  const input = buildUserStatus([buildEntry("A", 1)]);
  let seen = null;
  const { buffer, changed, count } = transformModelArray(input, {
    appendEntries: (uids) => {
      seen = uids;
      return [buildEntry("NEW", 5)];
    },
  });
  assert.equal(changed, true);
  assert.equal(count, 1);
  assert.ok(seen.has("A"));
  assert.ok(buffer.includes(Buffer.from("NEW", "utf8")));
});

test("appendEntries 返回空数组: changed=false 且字节不变", () => {
  const input = buildUserStatus([buildEntry("A", 1)]);
  const { buffer, changed } = transformModelArray(input, { appendEntries: () => [] });
  assert.equal(changed, false);
  assert.deepEqual(buffer, input);
});

test("两键同传: 抛错", () => {
  assert.throws(() => transformModelArray(Buffer.alloc(0), { mapEntry: () => null, appendEntries: () => [] }));
});

test("畸形 buffer: 不抛异常", () => {
  const garbage = Buffer.from([0x08, 0xff, 0xff, 0xff]);
  let r;
  assert.doesNotThrow(() => {
    r = transformModelArray(garbage, { mapEntry: () => null });
  });
  assert.equal(r.changed, false);
});
```

- [ ] **Step 4: 运行测试**

Run: `node --test test/unit/userstatus-shape.test.mjs`
Expected: 7 tests PASS

- [ ] **Step 5: Commit**

```
git add src/proxy/handlers/userstatus-shape.js test/unit/userstatus-shape.test.mjs
```
使用 `/git-commit` 提交。

---

### Task 3: context-window-rewrite.js 改用 shape 模块

**动机:** 删除私有 `parseWithRaw` / `descend`（约 90 行），形状知识归一。对外签名不变。

**Files:**
- Modify: `src/proxy/handlers/context-window-rewrite.js`

- [ ] **Step 1: 整体替换文件内容**

```js
import { writeVarintField, writeBytesField } from "../proto.js";
import {
  parseWithRaw,
  transformModelArray,
  CMC_MAX_TOKENS_FIELD,
  CMC_MODEL_INFO_FIELD,
  MI_CONTEXT_WINDOW_FIELD,
} from "./userstatus-shape.js";

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
  return replaced ? Buffer.concat(parts) : null;
}

// 重建单个 ClientModelConfig 条目: 按 model_uid 解析出目标窗口,
// 替换本级 field18(max_tokens, UI 分母) 及 field23 内的 field4(压缩阈值)。
// 返回 null 表示原样保留。
function rewriteModelEntry(entryBuf, modelUid, resolver) {
  if (!modelUid) {
    return null;
  }
  const window = resolver(modelUid);
  if (!Number.isInteger(window) || window <= 0) {
    return null;
  }
  const parsed = parseWithRaw(entryBuf);
  if (!parsed.ok) {
    return null;
  }
  const parts = [];
  let replaced = false;
  let hasMaxTokens = false;
  for (const f of parsed.fields) {
    if (f.field === CMC_MAX_TOKENS_FIELD && f.wireType === 0) {
      hasMaxTokens = true;
      if (Number(f.value) === window) {
        parts.push(f.raw);
      } else {
        parts.push(writeVarintField(CMC_MAX_TOKENS_FIELD, window));
        replaced = true;
      }
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
  }
  // 原条目无 field18 时补一个, 确保 UI 有分母可读。
  if (!hasMaxTokens) {
    parts.push(writeVarintField(CMC_MAX_TOKENS_FIELD, window));
    replaced = true;
  }
  return replaced ? Buffer.concat(parts) : null;
}

// 改写 GetUserStatus 已解压 payload, 把命中模型的上下文窗口替换为 resolver 给出的值。
// resolver: (modelUid:string) => number   返回 0 或非正数表示不改写。
// 返回 { buffer, changed, count }; 任何异常退化为原样透传。
export function rewriteUserStatusContextWindow(decoded, resolver) {
  return transformModelArray(decoded, {
    mapEntry: (entryBuf, modelUid) => rewriteModelEntry(entryBuf, modelUid, resolver),
  });
}
```

- [ ] **Step 2: 语法检查**

Run: `node --check src/proxy/handlers/context-window-rewrite.js`
Expected: 无输出

- [ ] **Step 3: 跑既有 15 个测试（关键回归验证）**

Run: `node --test test/unit/context-window-rewrite.test.mjs`
Expected: **15 tests PASS, 0 FAIL** — 与 Task 1 基线一致。任一失败必须修复后再继续。

- [ ] **Step 4: Commit**

```
git add src/proxy/handlers/context-window-rewrite.js
```
使用 `/git-commit` 提交。

---

### Task 4: 新建 byok-entry-inject.js

**Files:**
- Create: `src/proxy/handlers/byok-entry-inject.js`

- [ ] **Step 1: 写模块**

base64 为 2026-07-09 `GetUserStatus` 抓包的 ClientModelConfig payload 原文（不含外层 tag+len）。

```js
import { transformModelArray, readModelUid } from "./userstatus-shape.js";

// 2026-07-09 抓包的四条 BYOK 条目 payload(base64, 不含外层 tag+len)。
// 服务端于 2026-07-31 下架这些条目, 此处原样回放补回。
// 各条字段(以 OPUS 为例):
//   f1  = "Claude Opus 4 BYOK"       label
//   f18 = 200000                      max_tokens(交由 context-window-rewrite 改为配置值)
//   f22 = "MODEL_CLAUDE_4_OPUS_BYOK"  路由键, 代理靠它匹配 BYOK 槽位
//   f23 = <opaque 105B>               model_info, 内含 f4=context_window
//   f24 = 4                           访问途径门控; 193 样本证实: 有=可选, 无=Pro 灰显
const BYOK_ENTRY_TEMPLATES = {
  MODEL_CLAUDE_4_OPUS_BYOK:
    "ChJDbGF1ZGUgT3B1cyA0IEJZT0sSAwiVAigBMAFCLFJlZ2lzdGVyIHlvdXIgQW50aHJvcGljIEFQSSBrZXkgaW4gc2V0dGluZ3MuSAFQA2gDkAHAmgyyARhNT0RFTF9DTEFVREVfNF9PUFVTX0JZT0u6AWkIlQIYAiDAmgwqEkxMQU1BX1dJVEhfU1BFQ0lBTDIGQAFYAWABaID6AYoBGE1PREVMX0NMQVVERV80X09QVVNfQllPS5IBGmh0dHBzOi8vc2VydmVyLmNvZGVpdW0uY29tqgEFFQAAX0PAAQQ=",
  MODEL_CLAUDE_4_OPUS_THINKING_BYOK:
    "ChtDbGF1ZGUgT3B1cyA0IFRoaW5raW5nIEJZT0sSAwiWAigBMAFCLFJlZ2lzdGVyIHlvdXIgQW50aHJvcGljIEFQSSBrZXkgaW4gc2V0dGluZ3MuSAFQA2gDkAHAmgyyASFNT0RFTF9DTEFVREVfNF9PUFVTX1RISU5LSU5HX0JZT0u6AWwIlgIYAiDAmgwqEkxMQU1BX1dJVEhfU1BFQ0lBTDIIQAFYAWABeAFogPoBigEhTU9ERUxfQ0xBVURFXzRfT1BVU19USElOS0lOR19CWU9LkgEaaHR0cHM6Ly9zZXJ2ZXIuY29kZWl1bS5jb23AAQQ=",
  MODEL_CLAUDE_4_SONNET_BYOK:
    "ChRDbGF1ZGUgU29ubmV0IDQgQllPSxIDCJcCKAEwAVADaAOQAcCaDLIBGk1PREVMX0NMQVVERV80X1NPTk5FVF9CWU9LugFmCJcCGAIgwJoMKhJMTEFNQV9XSVRIX1NQRUNJQUwyCUABWAFgAagBAWiA9AOKARpNT0RFTF9DTEFVREVfNF9TT05ORVRfQllPS5IBGmh0dHBzOi8vc2VydmVyLmNvZGVpdW0uY29twAEE",
  MODEL_CLAUDE_4_SONNET_THINKING_BYOK:
    "Ch1DbGF1ZGUgU29ubmV0IDQgVGhpbmtpbmcgQllPSxIDCJgCKAEwAVADaAOQAcCaDLIBI01PREVMX0NMQVVERV80X1NPTk5FVF9USElOS0lOR19CWU9LugF5CJgCGAIgwJoMKhJMTEFNQV9XSVRIX1NQRUNJQUwyC0ABWAFgAXgBqAEBaID0A4oBI01PREVMX0NMQVVERV80X1NPTk5FVF9USElOS0lOR19CWU9LkgEaaHR0cHM6Ly9zZXJ2ZXIuY29kZWl1bS5jb22qAQUVAACqQsABBA==",
};

// 模块加载期自检: 解码并验证每条 payload 的 model_uid 与键名一致。
// 损坏者剔除, 绝不使代理崩溃。
const VERIFIED_ENTRIES = (() => {
  const out = [];
  for (const [uid, b64] of Object.entries(BYOK_ENTRY_TEMPLATES)) {
    try {
      const payload = Buffer.from(b64, "base64");
      if (readModelUid(payload) === uid) {
        out.push({ uid, payload });
      } else {
        console.error("[byok-inject] 模板 model_uid 不匹配, 已剔除: " + uid);
      }
    } catch (e) {
      console.error("[byok-inject] 模板解析失败, 已剔除: " + uid + " — " + e.message);
    }
  }
  return out;
})();

export function getVerifiedByokUids() {
  return VERIFIED_ENTRIES.map((e) => e.uid);
}

// 向 GetUserStatus 已解压 payload 补回服务端未下发的 BYOK 条目。
// 已存在的 uid 不重复追加 —— 服务端恢复下发后自动让路。
// 返回 { buffer, changed, count }; 任何异常退化为原样透传。
export function injectMissingByokEntries(decoded) {
  return transformModelArray(decoded, {
    appendEntries: (existingUids) =>
      VERIFIED_ENTRIES.filter((e) => !existingUids.has(e.uid)).map((e) => e.payload),
  });
}
```

- [ ] **Step 2: 语法检查**

Run: `node --check src/proxy/handlers/byok-entry-inject.js`
Expected: 无输出

- [ ] **Step 3: 写单测 `test/unit/byok-entry-inject.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { injectMissingByokEntries, getVerifiedByokUids } from "../../src/proxy/handlers/byok-entry-inject.js";
import { rewriteUserStatusContextWindow } from "../../src/proxy/handlers/context-window-rewrite.js";
import { parseWithRaw, readModelUid, MODEL_ARRAY_PATH } from "../../src/proxy/handlers/userstatus-shape.js";
import { writeVarintField, writeBytesField, writeStringField } from "../../src/proxy/proto.js";

const OPUS = "MODEL_CLAUDE_4_OPUS_BYOK";
const ALL = [
  "MODEL_CLAUDE_4_OPUS_BYOK",
  "MODEL_CLAUDE_4_OPUS_THINKING_BYOK",
  "MODEL_CLAUDE_4_SONNET_BYOK",
  "MODEL_CLAUDE_4_SONNET_THINKING_BYOK",
];

function buildEntry(uid, maxTokens) {
  return Buffer.concat([writeStringField(22, uid), writeVarintField(18, maxTokens)]);
}

function buildUserStatus(entries) {
  return writeBytesField(1, writeBytesField(33, Buffer.concat(entries.map((e) => writeBytesField(1, e)))));
}

// 从结果 buffer 中列出所有条目的 uid
function listUids(buf) {
  const top = parseWithRaw(buf).fields.find((f) => f.field === 1 && f.wireType === 2);
  const arr = parseWithRaw(top.value).fields.find((f) => f.field === 33 && f.wireType === 2);
  return parseWithRaw(arr.value).fields
    .filter((f) => f.field === 1 && f.wireType === 2)
    .map((f) => readModelUid(f.value));
}

function fieldOf(buf, uid, fieldNo) {
  const top = parseWithRaw(buf).fields.find((f) => f.field === 1 && f.wireType === 2);
  const arr = parseWithRaw(top.value).fields.find((f) => f.field === 33 && f.wireType === 2);
  for (const e of parseWithRaw(arr.value).fields.filter((f) => f.field === 1 && f.wireType === 2)) {
    if (readModelUid(e.value) === uid) {
      const hit = parseWithRaw(e.value).fields.find((f) => f.field === fieldNo);
      return hit ? Number(hit.value) : null;
    }
  }
  return null;
}

test("四条模板均通过加载期自检", () => {
  assert.deepEqual(getVerifiedByokUids().sort(), [...ALL].sort());
});

test("服务端零 BYOK: 补齐四条", () => {
  const input = buildUserStatus([buildEntry("swe-1-6-slow", 200000)]);
  const { buffer, changed, count } = injectMissingByokEntries(input);
  assert.equal(changed, true);
  assert.equal(count, 4);
  const uids = listUids(buffer);
  for (const u of ALL) assert.ok(uids.includes(u), "缺 " + u);
  assert.ok(uids.includes("swe-1-6-slow"), "原有条目被丢失");
});

test("注入条目携带正确的 f24 门控与 max_tokens", () => {
  const { buffer } = injectMissingByokEntries(buildUserStatus([]));
  assert.equal(fieldOf(buffer, OPUS, 24), 4);
  assert.equal(fieldOf(buffer, OPUS, 18), 200000);
});

test("已有两条: 只补缺的两条", () => {
  const input = buildUserStatus([buildEntry(ALL[0], 200000), buildEntry(ALL[1], 200000)]);
  const { changed, count } = injectMissingByokEntries(input);
  assert.equal(changed, true);
  assert.equal(count, 2);
});

test("四条齐全: 幂等, 字节完全不变", () => {
  const input = buildUserStatus(ALL.map((u) => buildEntry(u, 200000)));
  const { buffer, changed, count } = injectMissingByokEntries(input);
  assert.equal(changed, false);
  assert.equal(count, 0);
  assert.deepEqual(buffer, input);
});

test("连续两次注入结果一致(幂等)", () => {
  const input = buildUserStatus([]);
  const first = injectMissingByokEntries(input);
  const second = injectMissingByokEntries(first.buffer);
  assert.equal(second.changed, false);
  assert.deepEqual(second.buffer, first.buffer);
});

test("畸形 buffer: 不抛异常", () => {
  const garbage = Buffer.from([0x08, 0xff, 0xff, 0xff]);
  let r;
  assert.doesNotThrow(() => {
    r = injectMissingByokEntries(garbage);
  });
  assert.equal(r.changed, false);
});

test("串联 ①注入 → ②改窗口: 注入条目的 f18 升到 1M", () => {
  const injected = injectMissingByokEntries(buildUserStatus([]));
  assert.equal(injected.changed, true);
  const rewritten = rewriteUserStatusContextWindow(injected.buffer, (uid) =>
    uid === OPUS ? 1000000 : 0
  );
  assert.equal(rewritten.changed, true);
  assert.equal(fieldOf(rewritten.buffer, OPUS, 18), 1000000);
  assert.equal(fieldOf(rewritten.buffer, ALL[1], 18), 200000, "未配置槽位不应被改");
});
```

- [ ] **Step 4: 运行测试**

Run: `node --test test/unit/byok-entry-inject.test.mjs`
Expected: 8 tests PASS

- [ ] **Step 5: Commit**

```
git add src/proxy/handlers/byok-entry-inject.js test/unit/byok-entry-inject.test.mjs
```
使用 `/git-commit` 提交。

---

### Task 5: hybrid-server.js 接线

**Files:**
- Modify: `src/proxy/hybrid-server.js`

- [ ] **Step 1: 新增 import**

在 `import { rewriteUserStatusContextWindow } from "./handlers/context-window-rewrite.js";` 之后添加：

```js
import { injectMissingByokEntries } from "./handlers/byok-entry-inject.js";
```

- [ ] **Step 2: 替换 GetUserStatus 处理分支**

将现有分支（`if (tmp5 === "GetUserStatus" && ...)` 整块）替换为：

```js
        if (tmp5 === "GetUserStatus" && arg02.statusCode === 200 && tmp03[0] === 0x1f && tmp03[1] === 0x8b) {
          try {
            const tmp04 = tryGunzip(tmp03);
            if (tmp04) {
              // ① 补回服务端已下架的 BYOK 条目(存在性)
              const injected = injectMissingByokEntries(tmp04);
              if (injected.changed) {
                console.log("  [#" + arg3 + "] 🔄 GetUserStatus BYOK entries injected (x" + injected.count + ")");
              }
              // ② 改写上下文窗口(数值) —— 注入条目在此一并被处理
              const tmp14 = rewriteUserStatusContextWindow(injected.buffer, resolveContextWindowByModelUid);
              if (tmp14.changed) {
                console.log("  [#" + arg3 + "] 🔄 GetUserStatus contextWindow rewritten (x" + tmp14.count + ")");
              }
              if (injected.changed || tmp14.changed) {
                tmp03 = gzipSync(tmp14.buffer);
              }
            }
          } catch (tmp04) {
            console.error("  [#" + arg3 + "] GetUserStatus rewrite error: " + tmp04.message);
          }
        }
```

- [ ] **Step 3: 语法检查**

Run: `node --check src/proxy/hybrid-server.js`
Expected: 无输出

- [ ] **Step 4: Commit**

```
git add src/proxy/hybrid-server.js
```
使用 `/git-commit` 提交。

---

### Task 6: 全量测试与代码检查

- [ ] **Step 1: 全量单测**

Run: `node --test test/unit/`
Expected: 与 Task 1 记录的基线逐项对比 —— 通过数只增不减，失败集合不得新增成员。
`context-window-rewrite.test.mjs` 必须仍为 15 PASS。
若出现任何新失败，先定位修复再继续；不得以「预存失败」为由放过。

- [ ] **Step 2: Lint**

Run: `pnpm run lint`
Expected: 无新增错误

- [ ] **Step 3: 构建（验证 src/proxy → proxy-scripts/src 同步）**

Run: `pnpm run build`
Expected: 成功；确认 `proxy-scripts/src/handlers/byok-entry-inject.js` 与 `userstatus-shape.js` 已生成

- [ ] **Step 4: Commit plan 文档**

```
git add docs/superpowers/plans/2026-07-31-byok-entry-injection.md
```
使用 `/git-commit` 提交。

---

### Task 7: 打包安装与实机验证

**约束:** 2026-07-31 实测手改运行副本会被整包覆盖，必须走 VSIX 正规安装。

- [ ] **Step 1: 打包**

Run: `pnpm run package`
Expected: `build/devin-byok-plus-<version>.vsix` 生成

- [ ] **Step 2: 安装**

在 Devin 中：`Ctrl+Shift+P` → **Extensions: Install from VSIX...** → 选择 `build/` 下的 VSIX

- [ ] **Step 3: 重启代理**

侧栏「停止代理」→「一键启动」（Node 不热重载，必须重启进程）

- [ ] **Step 4: 触发 GetUserStatus**

`Ctrl+Shift+P` → **Developer: Reload Window**

- [ ] **Step 5: 验证日志**

侧栏日志区应出现：

```
🔄 GetUserStatus BYOK entries injected (x4)
🔄 GetUserStatus contextWindow rewritten (x4)
```

- [ ] **Step 6: 验证下拉列表（关键验证点）**

打开模型下拉，确认：

| 检查项 | 期望 |
|---|---|
| 四条 BYOK 条目出现 | ✓ |
| **条目可选而非 Pro 灰显** | ✓ ← 验证 f24 门控推断 |
| 上下文窗口显示 1M | ✓ |

- [ ] **Step 7: 端到端验证**

选中 `Claude Opus 4 BYOK`，发一条消息。确认：

1. 请求走通，回复正常
2. 侧栏日志出现对应 `chat_turn`，模型为槽位配置的实际模型（`claude-opus-5`）
3. 无 `upstream_error_status` 异常

**若失败:** 记录侧栏日志与 `~/.devin-byok-plus/logs/proxy-*.jsonl` 中的 anomaly，对照 spec「风险」章节两项（`f23` 内含 `server.codeium.com`；客户端其他 RPC 可能带上已下架 uid 被服务端校验）判断。