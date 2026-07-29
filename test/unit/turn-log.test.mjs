import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnLog } from "../../src/proxy/logging/turn-log.js";
import { Anomaly } from "../../src/proxy/logging/anomaly.js";

function fakeWriter() {
  const events = [];
  return {
    events,
    logEvent: (e) => events.push(e),
    logBlob: () => {},
  };
}

function turnsOf(writer) {
  return writer.events.filter((e) => e.type === "chat_turn");
}

function anomaliesOf(writer) {
  return writer.events.filter((e) => e.type === "anomaly");
}

test("finish 落一条 chat_turn 汇总", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  ctx.set({ model: "gpt-5.5", stopReason: "stop" });
  ctx.finish();
  const turns = turnsOf(w);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turnId, "t1");
  assert.equal(turns[0].model, "gpt-5.5");
  assert.equal(turns[0].stopReason, "stop");
});

test("set 浅合并, 后写覆盖先写", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  ctx.set({ model: "m1" });
  ctx.set({ route: "anthropic" });
  ctx.set({ model: "m2" });
  ctx.finish();
  const [turn] = turnsOf(w);
  assert.equal(turn.model, "m2");
  assert.equal(turn.route, "anthropic");
});

test("anomaly 各落一条独立事件, severity 由 code 推导", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  ctx.anomaly(Anomaly.STREAM_ABORTED, "socket closed");
  ctx.anomaly(Anomaly.RETRY, "attempt 1");
  const list = anomaliesOf(w);
  assert.equal(list.length, 2);
  assert.equal(list[0].code, Anomaly.STREAM_ABORTED);
  assert.equal(list[0].severity, "high");
  assert.equal(list[0].detail, "socket closed");
  assert.equal(list[1].code, Anomaly.RETRY);
  assert.equal(list[1].severity, "medium");
});

test("anomaly 事件带 turnId, 可与 chat_turn 关联", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "msg_xyz", writer: w });
  ctx.anomaly(Anomaly.STREAM_ERROR, "boom");
  ctx.finish();
  assert.equal(anomaliesOf(w)[0].turnId, "msg_xyz");
  assert.equal(turnsOf(w)[0].turnId, "msg_xyz");
});

test("anomaly 汇总进 chat_turn.anomalies 且去重", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  ctx.anomaly(Anomaly.RETRY, "1");
  ctx.anomaly(Anomaly.RETRY, "2");
  ctx.anomaly(Anomaly.STREAM_ERROR, "boom");
  ctx.finish();
  const [turn] = turnsOf(w);
  assert.deepEqual([...turn.anomalies].sort(), [Anomaly.RETRY, Anomaly.STREAM_ERROR].sort());
});

test("无 anomaly 时 anomalies 为空数组", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  ctx.finish();
  assert.deepEqual(turnsOf(w)[0].anomalies, []);
});

test("finish 幂等: 重复调用只落一次", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  ctx.finish();
  ctx.finish();
  ctx.finish();
  assert.equal(turnsOf(w).length, 1);
});

test("finish 后 set / anomaly 不再产生事件", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  ctx.finish();
  const before = w.events.length;
  ctx.set({ model: "late" });
  ctx.anomaly(Anomaly.RETRY, "late");
  assert.equal(w.events.length, before);
});

test("finish 可传 extra 字段并合并", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  ctx.set({ model: "m1" });
  ctx.finish({ stopReason: "tool_calls", retryCount: 2 });
  const [turn] = turnsOf(w);
  assert.equal(turn.model, "m1");
  assert.equal(turn.stopReason, "tool_calls");
  assert.equal(turn.retryCount, 2);
});

test("durationMs 自动计算", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  ctx.finish();
  const [turn] = turnsOf(w);
  assert.equal(typeof turn.durationMs, "number");
  assert.ok(turn.durationMs >= 0);
});

test("meta 里的 target / initiator 透传", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({
    turnId: "t1",
    target: "win2",
    writer: w,
    meta: { initiator: "agent" },
  });
  ctx.finish();
  const [turn] = turnsOf(w);
  assert.equal(turn.target, "win2");
  assert.equal(turn.initiator, "agent");
});

test("detail 为对象时序列化为字符串", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  ctx.anomaly(Anomaly.RETRY, { attempt: 2, reason: "ETIMEDOUT" });
  const detail = anomaliesOf(w)[0].detail;
  assert.equal(typeof detail, "string");
  assert.ok(detail.includes("ETIMEDOUT"));
});

// ── 不影响功能：任何畸形输入都不得抛错（spec 第 9 节）────────

test("畸形入参不抛异常", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  assert.doesNotThrow(() => ctx.set(null));
  assert.doesNotThrow(() => ctx.set("not object"));
  assert.doesNotThrow(() => ctx.set([1, 2]));
  assert.doesNotThrow(() => ctx.anomaly(null, null));
  assert.doesNotThrow(() => ctx.anomaly(undefined, undefined));
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => ctx.anomaly(Anomaly.RETRY, circular));
  assert.doesNotThrow(() => ctx.finish());
});

test("循环引用 detail 不抛异常且仍落事件", () => {
  const w = fakeWriter();
  const ctx = createTurnLog({ turnId: "t1", writer: w });
  const circular = { a: 1 };
  circular.self = circular;
  ctx.anomaly(Anomaly.STREAM_ERROR, circular);
  assert.equal(anomaliesOf(w).length, 1, "循环引用不应导致事件丢失");
});

test("writer 抛错不冒泡", () => {
  const bad = {
    logEvent: () => {
      throw new Error("writer boom");
    },
    logBlob: () => {},
  };
  const ctx = createTurnLog({ turnId: "t1", writer: bad });
  assert.doesNotThrow(() => ctx.anomaly(Anomaly.RETRY, "x"));
  assert.doesNotThrow(() => ctx.finish());
});

test("writer=null 时静默, 不抛异常也不落盘", () => {
  const ctx = createTurnLog({ turnId: "t1", writer: null });
  assert.doesNotThrow(() => ctx.set({ model: "m" }));
  assert.doesNotThrow(() => ctx.anomaly(Anomaly.RETRY, "x"));
  assert.doesNotThrow(() => ctx.finish());
});

test("无参构造不抛异常", () => {
  assert.doesNotThrow(() => {
    const ctx = createTurnLog({ writer: null });
    ctx.finish();
  });
});
