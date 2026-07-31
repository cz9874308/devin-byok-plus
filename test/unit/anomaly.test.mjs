import { test } from "node:test";
import assert from "node:assert/strict";
import { Anomaly, Severity, severityOf, isHigh } from "../../src/proxy/logging/anomaly.js";

test("Severity 是冻结常量", () => {
  assert.equal(Severity.HIGH, "high");
  assert.equal(Severity.MEDIUM, "medium");
  assert.equal(Severity.LOW, "low");
  assert.ok(Object.isFrozen(Severity));
});

test("high 集合与 spec 第 6 节一致", () => {
  const high = [
    Anomaly.STREAM_ABORTED,
    Anomaly.STREAM_ERROR,
    Anomaly.STREAM_IDLE_TIMEOUT,
    Anomaly.REQUEST_TIMEOUT,
    Anomaly.FORCED_STOP,
    Anomaly.UPSTREAM_ERROR_STATUS,
    Anomaly.EMPTY_STREAM,
    Anomaly.EMPTY_STREAM_EXHAUSTED,
  ];
  for (const code of high) {
    assert.equal(severityOf(code), Severity.HIGH, code + " 应为 high");
  }
  assert.equal(high.length, 8);
});

test("medium 集合正确", () => {
  const medium = [
    Anomaly.RETRY,
    Anomaly.CIRCUIT_BREAKER,
    Anomaly.TOOL_CALLS_DOWNGRADED,
    Anomaly.TOOLS_ALL_FILTERED,
    Anomaly.TOOL_RECOVERED_FROM_TEXT,
    Anomaly.TOOL_ARGS_INVALID_JSON,
  ];
  for (const code of medium) {
    assert.equal(severityOf(code), Severity.MEDIUM, code + " 应为 medium");
  }
});

test("low 集合正确", () => {
  assert.equal(severityOf(Anomaly.TOOL_NAME_AUTOCORRECTED), Severity.LOW);
  assert.equal(severityOf(Anomaly.TOOL_UNKNOWN_PASSTHROUGH), Severity.LOW);
  assert.equal(severityOf(Anomaly.CLIENT_CLOSED), Severity.LOW);
});

test("共 17 个 anomaly 代码", () => {
  assert.equal(Object.keys(Anomaly).length, 17);
});

test("未知 code 归为 low, 不抛异常", () => {
  assert.equal(severityOf("no_such_code"), Severity.LOW);
  assert.equal(severityOf(undefined), Severity.LOW);
  assert.equal(severityOf(null), Severity.LOW);
});

test("Anomaly 值与键一一对应且为 snake_case", () => {
  for (const [key, value] of Object.entries(Anomaly)) {
    assert.equal(value, key.toLowerCase(), key + " 值应为键的小写");
  }
});

test("isHigh 只对 high 返回 true", () => {
  assert.equal(isHigh(Anomaly.STREAM_ABORTED), true);
  assert.equal(isHigh(Anomaly.RETRY), false);
  assert.equal(isHigh(Anomaly.TOOL_NAME_AUTOCORRECTED), false);
  assert.equal(isHigh("unknown"), false);
});

test("Anomaly 表本身被冻结, 防止运行时篡改", () => {
  assert.ok(Object.isFrozen(Anomaly));
});
