import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogWriter } from "../../src/proxy/logging/log-writer.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "byok-writer-test-"));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 测试清理失败不影响断言结果
  }
}

function readLines(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  if (files.length === 0) {
    return [];
  }
  return fs
    .readFileSync(path.join(dir, files[0]), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const tick = () => new Promise((r) => setTimeout(r, 40));

test("logEvent 产出可逐行 JSON.parse 的 JSONL", () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true, logVerbose: false } });
  w.logEvent({ type: "chat_turn", turnId: "t1", stopReason: "stop" });
  w.flushSync();
  const lines = readLines(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "chat_turn");
  assert.equal(lines[0].turnId, "t1");
  assert.equal(lines[0].stopReason, "stop");
  cleanup(dir);
});

test("信封含 ts / pid / proc 字段", () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, proc: "hybrid", config: { logEnabled: true } });
  w.logEvent({ type: "lifecycle", event: "start" });
  w.flushSync();
  const [line] = readLines(dir);
  assert.equal(typeof line.ts, "number");
  assert.equal(line.pid, process.pid);
  assert.equal(line.proc, "hybrid");
  cleanup(dir);
});

test("白名单外的字段被丢弃", () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true } });
  w.logEvent({ type: "chat_turn", turnId: "t1", secretSocket: { weird: true } });
  w.flushSync();
  const [line] = readLines(dir);
  assert.equal(line.secretSocket, undefined, "非白名单字段不得写入");
  assert.equal(line.turnId, "t1", "白名单字段应保留");
  cleanup(dir);
});

test("超长字段截断到 2KB 并标记 truncated", () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true } });
  w.logEvent({ type: "anomaly", code: "stream_error", detail: "x".repeat(10000) });
  w.flushSync();
  const [line] = readLines(dir);
  assert.ok(line.detail.length < 2200, "应被截断, 实际=" + line.detail.length);
  assert.ok(line.detail.includes("truncated"), "应标记 truncated");
  cleanup(dir);
});

test("单行长度控制在 4KB 内(保证追加写原子性)", () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true } });
  w.logEvent({
    type: "chat_turn",
    turnId: "t1",
    detail: "a".repeat(9000),
    message: "b".repeat(9000),
  });
  w.flushSync();
  const raw = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("");
  for (const line of raw.split("\n").filter(Boolean)) {
    assert.ok(Buffer.byteLength(line) < 8192, "单行不应过长: " + Buffer.byteLength(line));
  }
  cleanup(dir);
});

test("LOG_ENABLED=false 时零 IO", async () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: false } });
  w.logEvent({ type: "chat_turn", turnId: "t1" });
  w.flushSync();
  await tick();
  assert.equal(readLines(dir).length, 0, "关闭时不得写任何内容");
  cleanup(dir);
});

test("LOG_VERBOSE=false 时 logBlob 的 supplier 不被调用", () => {
  const dir = tmpDir();
  let called = false;
  const w = createLogWriter({ dir, config: { logEnabled: true, logVerbose: false } });
  w.logBlob("t1", "sse", () => {
    called = true;
    return "big payload";
  });
  assert.equal(called, false, "关闭 verbose 时不得调用 supplier");
  cleanup(dir);
});

test("LOG_VERBOSE=true 时写出 blob 文件并落指针行", async () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true, logVerbose: true } });
  w.logBlob("msg_abc", "sse", () => "raw sse content");
  // blob 写入与指针行均为异步（spec 4.1: blob 永不进同步路径）
  await tick();
  w.flushSync();
  const blobPath = path.join(dir, "blobs", "msg_abc.sse.txt");
  assert.ok(fs.existsSync(blobPath), "blob 文件应存在");
  assert.equal(fs.readFileSync(blobPath, "utf8"), "raw sse content");
  const pointer = readLines(dir).find((l) => l.type === "blob");
  assert.ok(pointer, "应落一条 blob 指针行");
  assert.equal(pointer.kind, "sse");
  assert.equal(pointer.turnId, "msg_abc");
  assert.ok(pointer.file.includes("msg_abc.sse.txt"));
  assert.equal(pointer.bytes, "raw sse content".length);
  cleanup(dir);
});

test("blob 指针行不内联大文本", async () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true, logVerbose: true } });
  const big = "Z".repeat(50000);
  w.logBlob("t1", "request", () => big);
  await tick();
  w.flushSync();
  const raw = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("");
  assert.ok(!raw.includes("ZZZZZZZZZZ"), "主日志不得内联 blob 内容");
  assert.ok(fs.existsSync(path.join(dir, "blobs", "t1.request.txt")));
  cleanup(dir);
});

test("blob 文件名清洗路径穿越, 不写到目录外", async () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true, logVerbose: true } });
  w.logBlob("../../escaped", "sse", () => "content");
  await tick();
  const blobs = fs.readdirSync(path.join(dir, "blobs"));
  assert.equal(blobs.length, 1);
  assert.ok(!blobs[0].includes(".."), "文件名不得含 ..");
  cleanup(dir);
});

// ── 不影响功能：任何畸形输入都不得抛错（spec 第 9 节）────────

test("循环引用不抛异常", () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true } });
  const circular = { type: "anomaly", code: "stream_error" };
  circular.detail = circular;
  assert.doesNotThrow(() => w.logEvent(circular));
  assert.doesNotThrow(() => w.flushSync());
  cleanup(dir);
});

test("supplier 自身抛错不冒泡", () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true, logVerbose: true } });
  assert.doesNotThrow(() =>
    w.logBlob("t1", "sse", () => {
      throw new Error("supplier boom");
    })
  );
  cleanup(dir);
});

test("null / undefined / 非对象入参不抛异常", () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true } });
  assert.doesNotThrow(() => w.logEvent(null));
  assert.doesNotThrow(() => w.logEvent(undefined));
  assert.doesNotThrow(() => w.logEvent("not an object"));
  assert.doesNotThrow(() => w.logEvent([1, 2, 3]));
  assert.doesNotThrow(() => w.logBlob(null, null, null));
  assert.doesNotThrow(() => w.logBlob("t1", "sse", "not a function"));
  cleanup(dir);
});

test("目录不可创建时不抛异常", () => {
  // 用「文件当父目录」构造必然失败的路径（ENOTDIR），
  // 避免用 /not/writable 之类在 Windows 上会真的建目录污染磁盘。
  const base = tmpDir();
  const blocker = path.join(base, "blocker");
  fs.writeFileSync(blocker, "i am a file");
  const w = createLogWriter({
    dir: path.join(blocker, "logs"),
    config: { logEnabled: true },
  });
  assert.doesNotThrow(() => w.logEvent({ type: "chat_turn", turnId: "t1" }));
  assert.doesNotThrow(() => w.flushSync());
  cleanup(base);
});

test("high severity 的 anomaly 立即落盘", async () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true } });
  w.logEvent({ type: "anomaly", code: "stream_aborted" });
  await tick();
  const lines = readLines(dir);
  assert.equal(lines.length, 1, "high 事件应立即 flush, 无需等批量窗口");
  assert.equal(lines[0].severity, "high", "severity 应由 code 自动推导");
  cleanup(dir);
});

test("普通事件经异步批量最终落盘", async () => {
  const dir = tmpDir();
  const w = createLogWriter({ dir, config: { logEnabled: true } });
  w.logEvent({ type: "chat_turn", turnId: "a" });
  w.logEvent({ type: "chat_turn", turnId: "b" });
  await tick();
  const lines = readLines(dir);
  assert.equal(lines.length, 2);
  cleanup(dir);
});
