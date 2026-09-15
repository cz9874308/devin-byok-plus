import { test } from "node:test";
import assert from "node:assert/strict";
import { transformModelArray, transformModelSorts, readSortName, readModelUid } from "../../src/proxy/handlers/userstatus-shape.js";
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