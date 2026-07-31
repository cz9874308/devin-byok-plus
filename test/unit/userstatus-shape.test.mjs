import { test } from "node:test";
import assert from "node:assert/strict";
import { transformModelArray, readModelUid } from "../../src/proxy/handlers/userstatus-shape.js";
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