import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLines,
  summarize,
  groupAnomalies,
  listBrokenTurns,
  recoveryRate,
  aggregate,
} from "../../scripts/analyze-logs.mjs";

const TS = 1785289894459;

function line(obj) {
  return JSON.stringify({ ts: TS, pid: 1, proc: "hybrid", ...obj });
}

const SAMPLE = [
  line({ type: "turn_start", turnId: "a", initiator: "user" }),
  line({ type: "chat_turn", turnId: "a", stopReason: "tool_use", anomalies: [] }),
  line({ type: "turn_start", turnId: "b", initiator: "agent" }),
  line({ type: "anomaly", turnId: "b", code: "empty_stream", severity: "high", detail: "attempt=0/2" }),
  line({ type: "anomaly", turnId: "b", code: "empty_stream_exhausted", severity: "high" }),
  line({
    type: "chat_turn",
    turnId: "b",
    stopReason: null,
    anomalies: ["empty_stream", "empty_stream_exhausted"],
  }),
  line({ type: "turn_start", turnId: "c", initiator: "agent" }),
  line({ type: "anomaly", turnId: "c", code: "upstream_error_status", severity: "high", detail: "status=503" }),
  line({ type: "anomaly", turnId: "c", code: "retry", severity: "medium" }),
  line({ type: "chat_turn", turnId: "c", stopReason: "tool_use", anomalies: ["upstream_error_status", "retry"] }),
  line({ type: "turn_start", turnId: "d", initiator: "agent" }), // 孤儿：无 chat_turn
];

test("parseLines 跳过坏行并计数", () => {
  const { events, malformed } = parseLines([...SAMPLE, "{not json", "", "  "]);
  assert.equal(events.length, SAMPLE.length);
  assert.equal(malformed, 1);
});

test("summarize 给出发起数/完成数/完成率/孤儿数", () => {
  const { events } = parseLines(SAMPLE);
  const s = summarize(events);
  assert.equal(s.turnStarts, 4);
  assert.equal(s.chatTurns, 3);
  assert.equal(s.orphans, 1);
  assert.equal(s.completionRate, "75.0%");
});

test("groupAnomalies 按 code 计数并保留 severity", () => {
  const { events } = parseLines(SAMPLE);
  const rows = groupAnomalies(events);
  const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
  assert.equal(byCode.empty_stream.count, 1);
  assert.equal(byCode.empty_stream.severity, "high");
  assert.equal(byCode.retry.count, 1);
  assert.equal(byCode.retry.severity, "medium");
});

test("listBrokenTurns 列出断开轮与孤儿轮", () => {
  const { events } = parseLines(SAMPLE);
  const broken = listBrokenTurns(events);
  const ids = broken.map((b) => b.turnId).sort();
  assert.deepEqual(ids, ["b", "d"]);
  assert.equal(broken.find((b) => b.turnId === "d").reason, "orphan");
});

test("recoveryRate 统计重试后是否恢复", () => {
  const { events } = parseLines(SAMPLE);
  const r = recoveryRate(events);
  // b 空流耗尽未恢复，c 503 重试后恢复
  assert.equal(r.attempted, 2);
  assert.equal(r.recovered, 1);
  assert.equal(r.rate, "50.0%");
});

test("aggregate 组合四部分且带 malformed", () => {
  const out = aggregate([...SAMPLE, "{broken"]);
  assert.equal(out.malformed, 1);
  assert.equal(out.summary.turnStarts, 4);
  assert.ok(Array.isArray(out.anomalies));
  assert.ok(Array.isArray(out.brokenTurns));
  assert.equal(out.recovery.attempted, 2);
});

test("空输入不抛且返回零值", () => {
  const out = aggregate([]);
  assert.equal(out.summary.turnStarts, 0);
  assert.equal(out.summary.completionRate, "n/a");
  assert.deepEqual(out.anomalies, []);
});
