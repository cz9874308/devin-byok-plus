import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogWriter } from "../../src/proxy/logging/log-writer.js";
import { dailyFilePath } from "../../src/proxy/logging/log-file.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "byok-log-fields-"));
}

function readLines(dir) {
  const file = dailyFilePath(dir);
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const CONFIG = { logEnabled: true, logVerbose: false, logMaxMb: 10, logRetainDays: 7 };

test("chat_turn 的新字段不被白名单丢弃", () => {
  const dir = tempDir();
  const w = createLogWriter({ dir, proc: "hybrid", config: CONFIG });
  w.logEvent({
    type: "chat_turn",
    turnId: "t1",
    emittedContent: false,
    emptyRetries: 2,
    upstreamHost: "127.0.0.1:9090",
    sseBytes: 1234,
  });
  w.flushSync();
  const [line] = readLines(dir);
  assert.equal(line.emittedContent, false);
  assert.equal(line.emptyRetries, 2);
  assert.equal(line.upstreamHost, "127.0.0.1:9090");
  assert.equal(line.sseBytes, 1234);
});

test("turn_start 事件可落盘且带关联键", () => {
  const dir = tempDir();
  const w = createLogWriter({ dir, proc: "hybrid", config: CONFIG });
  w.logEvent({
    type: "turn_start",
    turnId: "t2",
    target: "default",
    initiator: "user",
    promptLen: 17404,
    model: "claude-opus-5",
    byokSlot: 4,
  });
  w.flushSync();
  const [line] = readLines(dir);
  assert.equal(line.type, "turn_start");
  assert.equal(line.turnId, "t2");
  assert.equal(line.initiator, "user");
  assert.equal(line.model, "claude-opus-5");
  assert.equal(line.byokSlot, 4);
});
