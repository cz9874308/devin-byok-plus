import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamEnd, classifyStreamEnd, shouldRetry } from "../../src/proxy/handlers/stream-end.js";

test("StreamEnd 是冻结常量", () => {
  assert.equal(StreamEnd.CLOSED, "closed");
  assert.equal(StreamEnd.NORMAL, "normal");
  assert.equal(StreamEnd.EMPTY, "empty");
  assert.equal(StreamEnd.PARTIAL, "partial");
  assert.ok(Object.isFrozen(StreamEnd));
});

test("收到终止事件 → NORMAL", () => {
  assert.equal(
    classifyStreamEnd({ isDone: true, emittedContent: true, closedByClient: false }),
    StreamEnd.NORMAL
  );
  assert.equal(
    classifyStreamEnd({ isDone: true, emittedContent: false, closedByClient: false }),
    StreamEnd.NORMAL
  );
});

test("无终止事件且零内容写出 → EMPTY", () => {
  assert.equal(
    classifyStreamEnd({ isDone: false, emittedContent: false, closedByClient: false }),
    StreamEnd.EMPTY
  );
});

test("无终止事件但已写出内容 → PARTIAL", () => {
  assert.equal(
    classifyStreamEnd({ isDone: false, emittedContent: true, closedByClient: false }),
    StreamEnd.PARTIAL
  );
});

test("closedByClient 优先于其它条件", () => {
  assert.equal(
    classifyStreamEnd({ isDone: false, emittedContent: false, closedByClient: true }),
    StreamEnd.CLOSED
  );
  assert.equal(
    classifyStreamEnd({ isDone: true, emittedContent: true, closedByClient: true }),
    StreamEnd.CLOSED
  );
});

test("畸形入参一律返回最保守的 PARTIAL 且不抛", () => {
  assert.equal(classifyStreamEnd(undefined), StreamEnd.PARTIAL);
  assert.equal(classifyStreamEnd(null), StreamEnd.PARTIAL);
  assert.equal(classifyStreamEnd("nope"), StreamEnd.PARTIAL);
  assert.equal(classifyStreamEnd([1, 2]), StreamEnd.PARTIAL);
});

test("只有 EMPTY 且未达上限才重试", () => {
  assert.equal(shouldRetry(StreamEnd.EMPTY, 0, 2), true);
  assert.equal(shouldRetry(StreamEnd.EMPTY, 1, 2), true);
  assert.equal(shouldRetry(StreamEnd.EMPTY, 2, 2), false);
  assert.equal(shouldRetry(StreamEnd.EMPTY, 3, 2), false);
});

test("非 EMPTY 一律不重试", () => {
  for (const kind of [StreamEnd.NORMAL, StreamEnd.PARTIAL, StreamEnd.CLOSED, "weird", undefined]) {
    assert.equal(shouldRetry(kind, 0, 2), false, String(kind) + " 不应重试");
  }
});

test("max=0 表示关闭空流重试", () => {
  assert.equal(shouldRetry(StreamEnd.EMPTY, 0, 0), false);
});

test("非数字入参不抛且不重试", () => {
  assert.equal(shouldRetry(StreamEnd.EMPTY, "x", 2), false);
  assert.equal(shouldRetry(StreamEnd.EMPTY, 0, undefined), false);
  assert.equal(shouldRetry(StreamEnd.EMPTY, NaN, NaN), false);
});
