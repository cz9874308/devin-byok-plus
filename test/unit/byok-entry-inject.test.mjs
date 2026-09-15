import { test } from "node:test";
import assert from "node:assert/strict";
import {
  injectMissingByokEntries,
  getVerifiedByokUids,
  upsertByokSortGroup,
  BYOK_MODEL_LABELS,
} from "../../src/proxy/handlers/byok-entry-inject.js";
import { rewriteUserStatusContextWindow } from "../../src/proxy/handlers/context-window-rewrite.js";
import { parseWithRaw, readModelUid, transformModelArray, transformModelSorts } from "../../src/proxy/handlers/userstatus-shape.js";
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

function buildUserStatus(entries, sorts = []) {
  const inner = Buffer.concat([
    ...entries.map((e) => writeBytesField(1, e)),
    ...sorts.map((s) => writeBytesField(2, s)),
  ]);
  return writeBytesField(1, writeBytesField(33, inner));
}

// 下探到模型数组层, 取出所有条目
function entriesOf(buf) {
  const top = parseWithRaw(buf).fields.find((f) => f.field === 1 && f.wireType === 2);
  const arr = parseWithRaw(top.value).fields.find((f) => f.field === 33 && f.wireType === 2);
  return parseWithRaw(arr.value).fields.filter((f) => f.field === 1 && f.wireType === 2);
}

function listUids(buf) {
  return entriesOf(buf).map((f) => readModelUid(f.value));
}

function fieldOf(buf, uid, fieldNo) {
  for (const e of entriesOf(buf)) {
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
  for (const u of ALL) {
    assert.ok(uids.includes(u), "缺 " + u);
  }
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

test("组合 ①②③: 三趟串联后注入/窗口改写/sorts分组同时生效", () => {
  const pass1 = injectMissingByokEntries(buildUserStatus([], [buildSort("All", ["Recommended"])]));
  assert.equal(pass1.count, 4);
  assert.equal(pass1.changed, true);
  const resolveWindow = (uid) => (uid === OPUS ? 1000000 : 0);
  const pass2 = rewriteUserStatusContextWindow(pass1.buffer, resolveWindow);
  assert.equal(pass2.changed, true);
  const pass3 = upsertByokSortGroup(pass2.buffer);
  assert.equal(pass3.changed, true);
  assert.equal(pass3.count, 1, "趟1 因已有 All 不追加, 趟2 追加一个 BYOK 组");
  assert.equal(fieldOf(pass3.buffer, OPUS, 18), 1000000, "趟2 的 f18 改写在趟3 后仍生效");
  for (const label of BYOK_MODEL_LABELS) {
    assert.ok(pass3.buffer.includes(Buffer.from(label, "utf8")), "缺 label: " + label);
  }
});