import { test } from "node:test";
import assert from "node:assert/strict";
import { injectMissingByokEntries, getVerifiedByokUids } from "../../src/proxy/handlers/byok-entry-inject.js";
import { rewriteUserStatusContextWindow } from "../../src/proxy/handlers/context-window-rewrite.js";
import { parseWithRaw, readModelUid } from "../../src/proxy/handlers/userstatus-shape.js";
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