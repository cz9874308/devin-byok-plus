import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteUserStatusContextWindow } from "../../src/proxy/handlers/context-window-rewrite.js";
import { writeVarintField, writeBytesField, parseFields, getField } from "../../src/proxy/proto.js";

// ── fixture 构造 ──────────────────────────────────────────────
// 结构: 顶层.field1 -> field33 -> field1 -> (repeated) field23{ field1=modelId, field4=ctx }

function buildModelEntry(modelId, ctxWindow, extraTailField) {
  const parts = [writeVarintField(1, modelId), writeVarintField(4, ctxWindow)];
  if (extraTailField) {
    // 追加一个额外字段(field7 字符串), 用来验证条目内其它字段原样保留
    parts.push(writeBytesField(7, Buffer.from(extraTailField, "utf8")));
  }
  return Buffer.concat(parts);
}

function buildUserStatus(entries) {
  const modelArray = Buffer.concat(entries.map((e) => writeBytesField(23, e)));
  const level1 = writeBytesField(1, modelArray);
  const level33 = writeBytesField(33, level1);
  const top = writeBytesField(1, level33);
  return top;
}

// 从 fixture 中取出某个模型条目的 field4 值(用于断言)
function readContextWindow(buf, modelId) {
  const top = getField(parseFields(buf), 1, 2);
  const l33 = getField(parseFields(top.value), 33, 2);
  const l1 = getField(parseFields(l33.value), 1, 2);
  const entries = parseFields(l1.value).filter((f) => f.field === 23 && f.wireType === 2);
  for (const e of entries) {
    const fields = parseFields(e.value);
    const idField = getField(fields, 1, 0);
    if (idField && Number(idField.value) === modelId) {
      const ctxField = getField(fields, 4, 0);
      return ctxField ? Number(ctxField.value) : null;
    }
  }
  return null;
}

const OPUS = 277;
const SONNET = 300;
const OFFICIAL = 42;

// ── 核心正确性 ────────────────────────────────────────────────

test("改写命中条目的 field4 到 1M, 其余条目字节不变", () => {
  const input = buildUserStatus([
    buildModelEntry(OFFICIAL, 200000, "official-model"),
    buildModelEntry(OPUS, 200000, "opus-byok"),
  ]);
  const resolver = (id) => (id === OPUS ? 1000000 : 0);
  const { buffer, changed, count } = rewriteUserStatusContextWindow(input, resolver);

  assert.equal(changed, true);
  assert.equal(count, 1);
  assert.equal(readContextWindow(buffer, OPUS), 1000000);
  // 官方条目不动
  assert.equal(readContextWindow(buffer, OFFICIAL), 200000);
  // 官方条目原始字节完整保留(含 field7)
  assert.ok(buffer.includes(Buffer.from("official-model", "utf8")));
  assert.ok(buffer.includes(Buffer.from("opus-byok", "utf8")));
});

test("500K 档位正确写入", () => {
  const input = buildUserStatus([buildModelEntry(OPUS, 200000)]);
  const { buffer, changed } = rewriteUserStatusContextWindow(input, () => 500000);
  assert.equal(changed, true);
  assert.equal(readContextWindow(buffer, OPUS), 500000);
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
  const resolver = (id) => (id === OPUS ? 1000000 : id === SONNET ? 500000 : 0);
  const { buffer, changed, count } = rewriteUserStatusContextWindow(input, resolver);

  assert.equal(changed, true);
  assert.equal(count, 2);
  assert.equal(readContextWindow(buffer, OPUS), 1000000);
  assert.equal(readContextWindow(buffer, SONNET), 500000);
  assert.equal(readContextWindow(buffer, OFFICIAL), 200000);
});

// ── round-trip 无损 ──────────────────────────────────────────

test("未改动的 buffer 经解析重建后与输入完全一致(无损)", () => {
  const input = buildUserStatus([
    buildModelEntry(OFFICIAL, 200000, "a"),
    buildModelEntry(OPUS, 200000, "b"),
  ]);
  // resolver 命中 OPUS 但目标值 == 现值, 应视为无改动
  const { buffer, changed } = rewriteUserStatusContextWindow(input, (id) =>
    id === OPUS ? 200000 : 0
  );
  assert.equal(changed, false);
  assert.deepEqual(buffer, input);
});

// ── 变长健壮性 ────────────────────────────────────────────────

test("变长 varint(2M, 4字节): 父级 length 正确增长且整体可解析", () => {
  const input = buildUserStatus([buildModelEntry(OPUS, 200000, "tail")]);
  const target = 2000000; // varint 4 字节, 比 200000(3字节) 长
  const { buffer, changed } = rewriteUserStatusContextWindow(input, () => target);

  assert.equal(changed, true);
  assert.equal(readContextWindow(buffer, OPUS), target);
  // 整体仍可完整解析(证明各级 length 前缀重算正确)
  assert.doesNotThrow(() => readContextWindow(buffer, OPUS));
  // 尾部字段仍在
  assert.ok(buffer.includes(Buffer.from("tail", "utf8")));
});

// ── 边界 / 防护 ──────────────────────────────────────────────

test("模型 ID 未登记(resolver 全返回 0): 不改", () => {
  const input = buildUserStatus([buildModelEntry(999, 200000)]);
  const { buffer, changed } = rewriteUserStatusContextWindow(input, () => 0);
  assert.equal(changed, false);
  assert.deepEqual(buffer, input);
});

test("畸形/截断 buffer: 不抛异常, changed=false", () => {
  const garbage = Buffer.from([0x08, 0xff, 0xff, 0xff]); // 不完整 varint
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
  // 第二次: 现值已是 1M, 目标也是 1M -> 无改动
  assert.equal(second.changed, false);
  assert.deepEqual(second.buffer, first.buffer);
});
