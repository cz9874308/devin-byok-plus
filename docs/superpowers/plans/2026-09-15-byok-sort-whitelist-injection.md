# BYOK sorts 白名单注入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 代理在 `GetUserStatus` 响应的 `client_model_sorts` 白名单中补入 BYOK 分组，使四个 BYOK 条目在新版 Devin 模型下拉列表（默认视图）恢复显示。

**Architecture:** 沿用 2026-07-31 确立的分层：报文形状知识集中在 `userstatus-shape.js`（新增 sorts 维度的常量与 transform），业务注入逻辑在 `byok-entry-inject.js`（新增 `BYOK_MODEL_LABELS` 单一来源与 `upsertByokSortGroup` 两趟组合），`hybrid-server.js` 仅串联 ①模型数组注入 → ②窗口改写 → ③sorts 注入。任一 transform 异常降级原样透传，`changed` 门控重压。

**Tech Stack:** Node.js 原生 protobuf 手工编解码（`proto.js` varint/bytes writer）、`node:test` + `node:assert/strict`、pnpm。

**Spec:** `docs/superpowers/specs/2026-09-15-byok-sort-whitelist-injection-design.md`

## Global Constraints

- 4 条 BYOK label 必须与模型数组注入条目的 f1 **逐字节精确一致**（UI 按 label 查字典，错一字即丢弃）：`Claude Opus 4 BYOK`、`Claude Opus 4 Thinking BYOK`、`Claude Sonnet 4 BYOK`、`Claude Sonnet 4 Thinking BYOK`——label 从 `BYOK_ENTRY_TEMPLATES` payload 解析，不允许手抄字符串
- `transformModelSorts` 的 handler 契约与 `transformModelArray` 一致：`mapSort` / `appendSorts` **二选一**，同传抛错
- 每个 transform 顶层 try/catch，异常退化为 `{ buffer: 原样, changed: false, count: 0 }`；无实际改动不重压
- 报文形状常量只允许出现在 `userstatus-shape.js`（单一归属）
- `hybrid-server.js` 改动仅限 GetUserStatus 分支的串联与 import（仅胶水）
- 提交信息格式：`<gitmoji> v0.0.<N> <20字内中文描述>`；本主题延续 BYOK 注入批次，从 **v0.0.23** 起
- 禁止手改运行副本 `~/.windsurf/extensions/jornlin.devin-byok-plus-2.6.0/`（会被整包覆盖）；运行时产物同步只走 `pnpm run build`
- 测试运行命令：`node --test test/unit/<file>.test.mjs`（单文件）/ `pnpm test`（全量）

## File Structure

```
src/proxy/handlers/userstatus-shape.js     # Modify: 新增 SORTS 常量、readSortName、transformModelSorts
src/proxy/handlers/byok-entry-inject.js    # Modify: 新增 BYOK_MODEL_LABELS、upsertByokSortGroup（两趟组合）
src/proxy/hybrid-server.js                 # Modify: GetUserStatus 分支串联 ③（约 5 行）
test/unit/userstatus-shape.test.mjs        # Modify: 追加 sorts 用例
test/unit/byok-entry-inject.test.mjs       # Modify: 追加 upsert/label/组合用例
proxy-scripts/src/**                       # Build: pnpm run build 从 src/proxy 自动复制（不手编）
```

---

### Task 1: userstatus-shape.js — sorts 形状变换

**Files:**
- Modify: `src/proxy/handlers/userstatus-shape.js`
- Test: `test/unit/userstatus-shape.test.mjs`（追加用例）

**Interfaces:**
- Consumes: 既有 `parseWithRaw(buf)`、`MODEL_ARRAY_PATH = [1, 33]`、`writeBytesField`（来自 `../proto.js`）
- Produces（Task 2/3 依赖，签名精确）:
  - `CMCD_SORTS_FIELD = 2`、`SORT_NAME_FIELD = 1`、`SORT_GROUPS_FIELD = 2`、`GROUP_NAME_FIELD = 1`、`GROUP_LABELS_FIELD = 2`（具名导出常量）
  - `readSortName(sortBuf: Buffer) → string | null`
  - `transformModelSorts(decoded: Buffer, handler) → { buffer: Buffer, changed: boolean, count: number }`；handler 为 `{ mapSort: (sortBuf, sortName) => Buffer | null }` 或 `{ appendSorts: (existingSortNames: Set<string>) => Buffer[] }` 二选一

- [ ] **Step 1: 写失败测试**

在 `test/unit/userstatus-shape.test.mjs` 顶部 import 行改为：

```js
import { transformModelArray, transformModelSorts, readSortName, readModelUid } from "../../src/proxy/handlers/userstatus-shape.js";
```

文件末尾追加（复用文件内既有的 `writeStringField` / `writeBytesField` import）：

```js
// ── sorts 白名单（2026-09-15 新版 UI 渲染机制）──────────────────────────
// ClientModelSort: f1=name(string), repeated f2=ClientModelGroup
// ClientModelGroup: f1=groupName(string), repeated f2=modelLabels(string)
function buildGroup(name, labels) {
  return Buffer.concat([
    writeStringField(1, name),
    ...labels.map((l) => writeStringField(2, l)),
  ]);
}

function buildSort(name, groups) {
  return Buffer.concat([
    writeStringField(1, name),
    ...groups.map((g) => writeBytesField(2, g)),
  ]);
}

function buildCascadeData(sorts) {
  return writeBytesField(1, writeBytesField(33, Buffer.concat(sorts.map((s) => writeBytesField(2, s)))));
}

test("readSortName 读出 field1", () => {
  assert.equal(readSortName(buildSort("All", [])), "All");
  assert.equal(readSortName(Buffer.from([0x08, 0x01])), null);
});

test("transformModelSorts mapSort 全 null: round-trip 无损", () => {
  const input = buildCascadeData([buildSort("All", [buildGroup("Recommended", ["A"])])]);
  const { buffer, changed } = transformModelSorts(input, { mapSort: () => null });
  assert.equal(changed, false);
  assert.deepEqual(buffer, input);
});

test("transformModelSorts mapSort 改写命中 sort, 其余原样", () => {
  const input = buildCascadeData([buildSort("All", []), buildSort("Other", [])]);
  const { buffer, changed, count } = transformModelSorts(input, {
    mapSort: (buf, name) => (name === "All" ? buildSort("All", [buildGroup("BYOK", ["X"])]) : null),
  });
  assert.equal(changed, true);
  assert.equal(count, 1);
  assert.ok(buffer.includes(Buffer.from("BYOK", "utf8")));
  assert.ok(!buffer.includes(Buffer.from("Other-CHANGED", "utf8")));
});

test("transformModelSorts appendSorts 拿到现有 name 集合并追加", () => {
  const input = buildCascadeData([buildSort("Recommended", [])]);
  let seen = null;
  const { buffer, changed, count } = transformModelSorts(input, {
    appendSorts: (names) => {
      seen = names;
      return [buildSort("All", [buildGroup("BYOK", ["L1"])])];
    },
  });
  assert.equal(changed, true);
  assert.equal(count, 1);
  assert.ok(seen.has("Recommended"));
  assert.ok(buffer.includes(Buffer.from("All", "utf8")));
  assert.ok(buffer.includes(Buffer.from("L1", "utf8")));
});

test("transformModelSorts appendSorts 空数组: changed=false 字节不变", () => {
  const input = buildCascadeData([buildSort("All", [])]);
  const { buffer, changed } = transformModelSorts(input, { appendSorts: () => [] });
  assert.equal(changed, false);
  assert.deepEqual(buffer, input);
});

test("transformModelSorts 不触碰同层 field1 模型数组", () => {
  const models = writeBytesField(1, writeBytesField(1, buildEntry("MODEL_A", 100)));
  const input = writeBytesField(1, writeBytesField(33, Buffer.concat([models, writeBytesField(2, buildSort("All", []))])));
  const { buffer, changed } = transformModelSorts(input, { appendSorts: () => [buildSort("X", [])] });
  assert.equal(changed, true);
  assert.ok(buffer.includes(Buffer.from("MODEL_A", "utf8")));
});

test("transformModelSorts 两键同传: 抛错", () => {
  assert.throws(() => transformModelSorts(Buffer.alloc(0), { mapSort: () => null, appendSorts: () => [] }));
});

test("transformModelSorts 畸形 buffer: 不抛异常", () => {
  const garbage = Buffer.from([0x08, 0xff, 0xff, 0xff]);
  let r;
  assert.doesNotThrow(() => {
    r = transformModelSorts(garbage, { mapSort: () => null });
  });
  assert.equal(r.changed, false);
  assert.deepEqual(r.buffer, garbage);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node --test test/unit/userstatus-shape.test.mjs`
Expected: FAIL（`transformModelSorts` / `readSortName` 未导出，import 报错或用例失败）；既有用例仍全绿

- [ ] **Step 3: 最小实现**

在 `src/proxy/handlers/userstatus-shape.js` 的常量区（`export const MI_CONTEXT_WINDOW_FIELD = 4;` 之后）追加：

```js
// ── sorts 白名单（2026-09-15 新版 UI 渲染机制）──────────────────────────
// CascadeModelConfigData: f1=client_model_configs(repeated), f2=client_model_sorts(repeated)
// ClientModelSort: f1=name(string), f2=groups(repeated ClientModelGroup)
// ClientModelGroup: f1=groupName(string), f2=modelLabels(repeated string)
// UI 按 sorts[].groups[].modelLabels 白名单渲染模型; name 为 "All"/"Recommended" 的 sort 为默认视图。
export const CMCD_SORTS_FIELD = 2;
export const SORT_NAME_FIELD = 1;
export const SORT_GROUPS_FIELD = 2;
export const GROUP_NAME_FIELD = 1;
export const GROUP_LABELS_FIELD = 2;
```

在 `readModelUid` 函数之后追加：

```js
// 读取 ClientModelSort 条目的 name(field1)。
export function readSortName(sortBuf) {
  const parsed = parseWithRaw(sortBuf);
  if (!parsed.ok) {
    return null;
  }
  for (const f of parsed.fields) {
    if (f.field === SORT_NAME_FIELD && f.wireType === 2 && f.value) {
      return f.value.toString("utf8");
    }
  }
  return null;
}
```

在文件末尾（`transformModelArray` 之后）追加。结构与 `transformModelArray` 平行但独立演进：下探 `MODEL_ARRAY_PATH` 后操作 `CMCD_SORTS_FIELD` 条目，避免改动既有 `descend` 危及模型数组注入路径：

```js
function descendSortsTop(buf, handler, state) {
  const parsed = parseWithRaw(buf);
  if (!parsed.ok) {
    return buf;
  }
  const parts = [];
  for (const f of parsed.fields) {
    if (f.field === MODEL_ARRAY_PATH[0] && f.wireType === 2) {
      parts.push(writeBytesField(f.field, descendSortsMid(f.value, handler, state)));
    } else {
      parts.push(f.raw);
    }
  }
  return Buffer.concat(parts);
}

function descendSortsMid(buf, handler, state) {
  const parsed = parseWithRaw(buf);
  if (!parsed.ok) {
    return buf;
  }
  const parts = [];
  for (const f of parsed.fields) {
    if (f.field === MODEL_ARRAY_PATH[1] && f.wireType === 2) {
      parts.push(writeBytesField(f.field, transformSortsLevel(f.value, handler, state)));
    } else {
      parts.push(f.raw);
    }
  }
  return Buffer.concat(parts);
}

function transformSortsLevel(buf, handler, state) {
  const parsed = parseWithRaw(buf);
  if (!parsed.ok) {
    return buf;
  }
  const parts = [];
  for (const f of parsed.fields) {
    if (f.field === CMCD_SORTS_FIELD && f.wireType === 2) {
      const name = readSortName(f.value);
      state.existingNames.push(name);
      if (handler.mapSort) {
        const rebuilt = handler.mapSort(f.value, name);
        if (rebuilt !== null && rebuilt !== undefined) {
          parts.push(writeBytesField(CMCD_SORTS_FIELD, rebuilt));
          state.count++;
          continue;
        }
      }
      parts.push(f.raw);
      continue;
    }
    parts.push(f.raw);
  }
  if (handler.appendSorts) {
    const names = state.existingNames.filter(Boolean);
    for (const payload of handler.appendSorts(new Set(names))) {
      parts.push(writeBytesField(CMCD_SORTS_FIELD, payload));
      state.count++;
    }
  }
  return Buffer.concat(parts);
}

// 沿 MODEL_ARRAY_PATH 下探到 CascadeModelConfigData 层, 按 handler 语义变换 sorts 数组。
// handler 契约与 transformModelArray 一致: mapSort / appendSorts 二选一, 同传抛错。
// 任何异常退化为原样透传。
export function transformModelSorts(decoded, handler) {
  if (handler.mapSort && handler.appendSorts) {
    throw new Error("transformModelSorts: mapSort 与 appendSorts 只能提供其一");
  }
  const state = { count: 0, existingNames: [] };
  try {
    const buffer = descendSortsTop(decoded, handler, state);
    return { buffer, changed: state.count > 0, count: state.count };
  } catch {
    return { buffer: decoded, changed: false, count: 0 };
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test test/unit/userstatus-shape.test.mjs`
Expected: PASS（既有用例 + 新增 8 例全绿）

- [ ] **Step 5: Commit**

```bash
git add src/proxy/handlers/userstatus-shape.js test/unit/userstatus-shape.test.mjs
git commit -m "✨ v0.0.23 形状模块新增sorts白名单变换"
```

---

### Task 2: byok-entry-inject.js — BYOK_MODEL_LABELS 与 upsertByokSortGroup

**Files:**
- Modify: `src/proxy/handlers/byok-entry-inject.js`
- Test: `test/unit/byok-entry-inject.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `transformModelSorts` / `parseWithRaw` / `CMC_LABEL_FIELD` / `SORT_NAME_FIELD` / `SORT_GROUPS_FIELD` / `GROUP_NAME_FIELD` / `GROUP_LABELS_FIELD`；既有 `VERIFIED_ENTRIES`（`{ uid, payload }[]`）、`transformModelArray`、`readModelUid`；`writeStringField` / `writeBytesField`（`../proto.js`，本文件此前未 import，需新增）
- Produces（Task 3 依赖，签名精确）:
  - `BYOK_MODEL_LABELS: string[]`（4 条，从 VERIFIED_ENTRIES payload 的 f1 解析）
  - `upsertByokSortGroup(decoded: Buffer) → { buffer: Buffer, changed: boolean, count: number }`；行为：趟1 保证存在 `name="All"` 的 sort（无则追加 `{name:"All", groups:[BYOK组]}`），趟2 向 `name="All"` 的 sort 追加 `groupName="BYOK"` 组（含 4 条 label，已有则幂等跳过）

- [ ] **Step 1: 写失败测试**

在 `test/unit/byok-entry-inject.test.mjs` 顶部 import 改为（保留该文件既有 import，合并进去）：

```js
import {
  upsertByokSortGroup,
  injectMissingByokEntries,
  BYOK_MODEL_LABELS,
  getVerifiedByokUids,
} from "../../src/proxy/handlers/byok-entry-inject.js";
import { transformModelArray, transformModelSorts, readModelUid } from "../../src/proxy/handlers/userstatus-shape.js";
import { writeVarintField, writeBytesField, writeStringField } from "../../src/proxy/proto.js";
```

文件末尾追加：

```js
function buildEntry(uid, maxTokens) {
  return Buffer.concat([writeStringField(22, uid), writeVarintField(18, maxTokens)]);
}

function buildUserStatus(entries, sorts = []) {
  const inner = Buffer.concat([
    ...entries.map((e) => writeBytesField(1, e)),
    ...sorts.map((s) => writeBytesField(2, s)),
  ]);
  return writeBytesField(1, writeBytesField(33, inner));
}

function buildSort(name, groupNames) {
  return Buffer.concat([
    writeStringField(1, name),
    ...groupNames.map((g) => writeBytesField(2, writeBytesField(1, writeStringField(1, g)))),
  ]);
}

function listSortNames(buf) {
  const names = [];
  transformModelSorts(buf, { mapSort: (sortBuf, name) => { names.push(name); return null; } });
  return names.filter(Boolean);
}

test("BYOK_MODEL_LABELS 与模板 f1 逐字节一致(4 条)", () => {
  assert.equal(BYOK_MODEL_LABELS.length, 4);
  assert.deepEqual(BYOK_MODEL_LABELS, [
    "Claude Opus 4 BYOK",
    "Claude Opus 4 Thinking BYOK",
    "Claude Sonnet 4 BYOK",
    "Claude Sonnet 4 Thinking BYOK",
  ]);
});

test("upsert sorts 为空: 新建 All sort + BYOK 组", () => {
  const input = buildUserStatus([]);
  const { buffer, changed } = upsertByokSortGroup(input);
  assert.equal(changed, true);
  assert.deepEqual(listSortNames(buffer), ["All"]);
  assert.ok(buffer.includes(Buffer.from("BYOK", "utf8")));
  for (const label of BYOK_MODEL_LABELS) {
    assert.ok(buffer.includes(Buffer.from(label, "utf8")));
  }
});

test("upsert 已有 All sort: 组内追加 BYOK 组", () => {
  const input = buildUserStatus([], [buildSort("All", ["Recommended"])]);
  const { buffer, changed } = upsertByokSortGroup(input);
  assert.equal(changed, true);
  assert.ok(buffer.includes(Buffer.from("Recommended", "utf8")));
  assert.ok(buffer.includes(Buffer.from("BYOK", "utf8")));
  assert.ok(buffer.includes(Buffer.from("Claude Opus 4 BYOK", "utf8")));
});

test("upsert 已有 All + BYOK 组: 幂等字节不变", () => {
  const once = upsertByokSortGroup(buildUserStatus([], [buildSort("All", ["Recommended"])]));
  const twice = upsertByokSortGroup(once.buffer);
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.buffer, once.buffer);
});

test("upsert 无 All sort 但有其他 sort: 追加新 All sort, 原有保留", () => {
  const input = buildUserStatus([], [buildSort("Custom", [])]);
  const { buffer, changed } = upsertByokSortGroup(input);
  assert.equal(changed, true);
  const names = listSortNames(buffer);
  assert.ok(names.includes("All"));
  assert.ok(names.includes("Custom"));
});

test("upsert 畸形输入: 不抛异常且原样透传", () => {
  const garbage = Buffer.from([0x08, 0xff, 0xff, 0xff]);
  let r;
  assert.doesNotThrow(() => {
    r = upsertByokSortGroup(garbage);
  });
  assert.equal(r.changed, false);
  assert.deepEqual(r.buffer, garbage);
});

test("组合 ①③: 注入数组条目 + sorts 分组同步生效", () => {
  const input = buildUserStatus([]);
  const pass1 = injectMissingByokEntries(input);
  assert.equal(pass1.count, 4);
  const pass2 = upsertByokSortGroup(pass1.buffer);
  assert.equal(pass2.changed, true);
  const uids = [];
  transformModelArray(pass2.buffer, { mapEntry: (buf) => { uids.push(readModelUid(buf)); return null; } });
  for (const uid of getVerifiedByokUids()) {
    assert.ok(uids.includes(uid));
  }
  assert.ok(pass2.buffer.includes(Buffer.from("All", "utf8")));
  assert.ok(pass2.buffer.includes(Buffer.from("BYOK", "utf8")));
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node --test test/unit/byok-entry-inject.test.mjs`
Expected: FAIL（`upsertByokSortGroup` / `BYOK_MODEL_LABELS` 未导出）

- [ ] **Step 3: 最小实现**

修改 `src/proxy/handlers/byok-entry-inject.js`：

import 区（第 1 行）替换为：

```js
import {
  transformModelArray,
  transformModelSorts,
  readModelUid,
  parseWithRaw,
  CMC_LABEL_FIELD,
  SORT_NAME_FIELD,
  SORT_GROUPS_FIELD,
  GROUP_NAME_FIELD,
  GROUP_LABELS_FIELD,
} from "./userstatus-shape.js";
import { writeStringField, writeBytesField } from "../proto.js";
```

在 `VERIFIED_ENTRIES` 定义之后追加 `BYOK_MODEL_LABELS`：

```js
// ③ sorts 注入与 ① 模型数组注入共用的 label 单一来源:
// 从 VERIFIED_ENTRIES payload 的 f1(label) 解析, 保证 sorts.modelLabels 与数组条目 f1 逐字节一致。
export const BYOK_MODEL_LABELS = VERIFIED_ENTRIES.map((e) => {
  const parsed = parseWithRaw(e.payload);
  if (!parsed.ok) {
    return null;
  }
  for (const f of parsed.fields) {
    if (f.field === CMC_LABEL_FIELD && f.wireType === 2 && f.value) {
      return f.value.toString("utf8");
    }
  }
  return null;
}).filter(Boolean);
```

文件末尾追加：

```js
const BYOK_GROUP_NAME = "BYOK";
const DEFAULT_SORT_NAME = "All";

function buildByokGroup() {
  return Buffer.concat([
    writeStringField(GROUP_NAME_FIELD, BYOK_GROUP_NAME),
    ...BYOK_MODEL_LABELS.map((l) => writeStringField(GROUP_LABELS_FIELD, l)),
  ]);
}

function buildByokSort() {
  return Buffer.concat([
    writeStringField(SORT_NAME_FIELD, DEFAULT_SORT_NAME),
    writeBytesField(SORT_GROUPS_FIELD, buildByokGroup()),
  ]);
}

function hasByokGroup(sortBuf) {
  const parsed = parseWithRaw(sortBuf);
  if (!parsed.ok) {
    return false;
  }
  for (const f of parsed.fields) {
    if (f.field === SORT_GROUPS_FIELD && f.wireType === 2) {
      const gp = parseWithRaw(f.value);
      if (!gp.ok) {
        continue;
      }
      for (const g of gp.fields) {
        if (g.field === GROUP_NAME_FIELD && g.wireType === 2 && g.value && g.value.toString("utf8") === BYOK_GROUP_NAME) {
          return true;
        }
      }
    }
  }
  return false;
}

function appendByokGroup(sortBuf) {
  const parsed = parseWithRaw(sortBuf);
  if (!parsed.ok) {
    return null;
  }
  return Buffer.concat([...parsed.fields.map((f) => f.raw), writeBytesField(SORT_GROUPS_FIELD, buildByokGroup())]);
}

// 向 GetUserStatus 已解压 payload 的 sorts 白名单补入 BYOK 分组。
// 两趟组合(handler 契约二选一, 无法单趟同时改写与追加; RPC 低频, 两趟代价可忽略):
//   趟1 appendSorts  无 name="All" 的 sort 时追加完整 {name:"All", groups:[BYOK组]}
//   趟2 mapSort      向 name="All" 的 sort 追加 groupName="BYOK" 组(已有则幂等跳过)
// 返回 { buffer, changed, count }; 任何异常退化为原样透传。
export function upsertByokSortGroup(decoded) {
  try {
    const pass1 = transformModelSorts(decoded, {
      appendSorts: (names) => (names.has(DEFAULT_SORT_NAME) ? [] : [buildByokSort()]),
    });
    const pass2 = transformModelSorts(pass1.buffer, {
      mapSort: (buf, name) => (name === DEFAULT_SORT_NAME && !hasByokGroup(buf) ? appendByokGroup(buf) : null),
    });
    return {
      buffer: pass2.buffer,
      changed: pass1.changed || pass2.changed,
      count: pass1.count + pass2.count,
    };
  } catch {
    return { buffer: decoded, changed: false, count: 0 };
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test test/unit/byok-entry-inject.test.mjs && node --test test/unit/userstatus-shape.test.mjs`
Expected: PASS（两文件全部用例全绿，含组合 ①③ 用例）

- [ ] **Step 5: Commit**

```bash
git add src/proxy/handlers/byok-entry-inject.js test/unit/byok-entry-inject.test.mjs
git commit -m "✨ v0.0.24 新增BYOK sorts分组upsert注入"
```
---

### Task 3: hybrid-server.js — GetUserStatus 串联 ③

**Files:**
- Modify: `src/proxy/hybrid-server.js`（GetUserStatus 分支，约 206-227 行区域 + import 区第 13 行附近）

**Interfaces:**
- Consumes: Task 2 的 `upsertByokSortGroup(decoded) → { buffer, changed, count }`
- Produces: 串联后的完整数据流 ①→②→③（无新导出；③ 日志行 `🔄 GetUserStatus BYOK sort group upserted (x<count>)` 供实机验收比对）

- [ ] **Step 1: 修改 import**

`src/proxy/handlers/byok-entry-inject.js` 的既有 import 行（第 13 行）：

```js
import { injectMissingByokEntries } from "./handlers/byok-entry-inject.js";
```

替换为：

```js
import { injectMissingByokEntries, upsertByokSortGroup } from "./handlers/byok-entry-inject.js";
```

- [ ] **Step 2: 串联 ③**

GetUserStatus 分支中，既有 ② 之后、重压判断之前：

```js
              // ② 改写上下文窗口(数值) —— 注入条目在此一并被处理
              const tmp14 = rewriteUserStatusContextWindow(injected.buffer, resolveContextWindowByModelUid);
              if (tmp14.changed) {
                console.log("  [#" + arg3 + "] 🔄 GetUserStatus contextWindow rewritten (x" + tmp14.count + ")");
              }
```

在其后插入：

```js
              // ③ sorts 白名单补 BYOK 分组 —— 新版 UI 按 client_model_sorts 渲染, 缺组则条目不显示
              const sorted = upsertByokSortGroup(tmp14.buffer);
              if (sorted.changed) {
                console.log("  [#" + arg3 + "] 🔄 GetUserStatus BYOK sort group upserted (x" + sorted.count + ")");
              }
```

重压判断与压缩行：

```js
              if (injected.changed || tmp14.changed) {
                tmp03 = gzipSync(tmp14.buffer);
              }
```

替换为：

```js
              if (injected.changed || tmp14.changed || sorted.changed) {
                tmp03 = gzipSync(sorted.buffer);
              }
```

- [ ] **Step 3: lint 验证**

Run: `pnpm run lint`
Expected: 0 error（warning 计数不超过 `--max-warnings 50`）

- [ ] **Step 4: Commit**

```bash
git add src/proxy/hybrid-server.js
git commit -m "🔊 v0.0.25 GetUserStatus串联sorts白名单注入"
```

---

### Task 4: 全量验证与构建产物同步

**Files:**
- Build（自动复制，不手编）: `proxy-scripts/src/**` ← `pnpm run build` 从 `src/proxy/` 同步
- Test: 全量 `test/unit/` + `test/integration/`

**Interfaces:**
- Consumes: Task 1-3 的全部产物
- Produces: 与仓库源码一致的代理运行时产物（后续 `pnpm run package` 打 VSIX 的直接输入）

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: PASS——既有全部用例（含 `context-window-rewrite.test.mjs`、`byok-entry-inject.test.mjs` 既有用例）+ 本计划新增用例全绿

- [ ] **Step 2: lint**

Run: `pnpm run lint`
Expected: 0 error

- [ ] **Step 3: 构建同步运行时产物**

Run: `pnpm run build`
Expected: `proxy-scripts/src/handlers/userstatus-shape.js` 含 `transformModelSorts` 导出；`byok-entry-inject.js` 含 `upsertByokSortGroup` 导出；`hybrid-server.js` 含 `BYOK sort group upserted` 日志行。可用以下命令核验：

```bash
grep -c "transformModelSorts" proxy-scripts/src/handlers/userstatus-shape.js
grep -c "upsertByokSortGroup" proxy-scripts/src/handlers/byok-entry-inject.js
grep -c "sort group upserted" proxy-scripts/src/hybrid-server.js
```

Expected: 各输出 ≥ 1

- [ ] **Step 4: Commit**

```bash
git add proxy-scripts/src/
git commit -m "🔨 v0.0.26 构建同步sorts注入运行时产物"
```

- [ ] **Step 5: 实机验收（人工步骤，不在本计划自动执行）**

1. `pnpm run package` 产出 VSIX → 在 Devin Desktop 安装
2. 一键启动代理 → 重载窗口 → 再一键启动（重载杀代理子进程）
3. 打开模型下拉列表：默认视图出现 "BYOK" 分组及 4 条条目，可选中
4. 侧栏日志出现 `🔄 GetUserStatus BYOK entries injected (x4)` 与 `🔄 GetUserStatus BYOK sort group upserted`
5. 选中 BYOK 条目发起聊天：代理日志出现 `GetChatMessage` 且请求按槽位路由到用户网关