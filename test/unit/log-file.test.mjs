import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dailyFileName,
  blobFileName,
  isExpired,
  nextRotationPath,
  needsRotation,
  ensureLogDir,
  cleanupExpired,
} from "../../src/proxy/logging/log-file.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "byok-log-test-"));
}

test("dailyFileName 按日期生成", () => {
  const d = new Date("2026-07-29T10:00:00Z");
  assert.equal(dailyFileName(d), "proxy-2026-07-29.jsonl");
});

test("blobFileName 按 turnId + kind 生成", () => {
  assert.equal(blobFileName("msg_abc", "sse"), "msg_abc.sse.txt");
});

test("blobFileName 清洗路径穿越字符", () => {
  const name = blobFileName("../../etc/passwd", "sse");
  assert.ok(!name.includes(".."), "不得包含 ..");
  assert.ok(!name.includes("/"), "不得包含 /");
  assert.ok(!name.includes("\\"), "不得包含反斜杠");
});

test("needsRotation: 超过阈值返回 true", () => {
  const maxBytes = 10 * 1024 * 1024;
  assert.equal(needsRotation(maxBytes + 1, maxBytes), true);
  assert.equal(needsRotation(maxBytes - 1, maxBytes), false);
  assert.equal(needsRotation(0, maxBytes), false);
});

test("nextRotationPath 递增序号", () => {
  const dir = tmpDir();
  const base = path.join(dir, "proxy-2026-07-29.jsonl");
  fs.writeFileSync(base, "x");
  assert.equal(path.basename(nextRotationPath(base)), "proxy-2026-07-29.1.jsonl");
  fs.writeFileSync(path.join(dir, "proxy-2026-07-29.1.jsonl"), "x");
  assert.equal(path.basename(nextRotationPath(base)), "proxy-2026-07-29.2.jsonl");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("isExpired: 按天数判断", () => {
  const now = new Date("2026-07-29T00:00:00Z").getTime();
  const eightDaysAgo = now - 8 * 86400000;
  const oneDayAgo = now - 1 * 86400000;
  assert.equal(isExpired(eightDaysAgo, 7, now), true);
  assert.equal(isExpired(oneDayAgo, 7, now), false);
});

test("ensureLogDir 创建目录与 blobs 子目录", () => {
  const dir = path.join(tmpDir(), "logs");
  ensureLogDir(dir);
  assert.ok(fs.existsSync(dir));
  assert.ok(fs.existsSync(path.join(dir, "blobs")));
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test("ensureLogDir 重复调用不抛异常", () => {
  const dir = path.join(tmpDir(), "logs");
  ensureLogDir(dir);
  assert.doesNotThrow(() => ensureLogDir(dir));
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test("cleanupExpired 只删过期的 jsonl, 保留新文件", () => {
  const dir = tmpDir();
  const oldFile = path.join(dir, "proxy-2026-07-01.jsonl");
  const newFile = path.join(dir, "proxy-2026-07-29.jsonl");
  fs.writeFileSync(oldFile, "old");
  fs.writeFileSync(newFile, "new");
  const past = Date.now() - 30 * 86400000;
  fs.utimesSync(oldFile, past / 1000, past / 1000);

  const removed = cleanupExpired(dir, 7);
  assert.ok(removed >= 1);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(newFile), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cleanupExpired 不碰非日志文件", () => {
  const dir = tmpDir();
  const other = path.join(dir, "important.txt");
  fs.writeFileSync(other, "keep me");
  const past = Date.now() - 30 * 86400000;
  fs.utimesSync(other, past / 1000, past / 1000);

  cleanupExpired(dir, 7);
  assert.equal(fs.existsSync(other), true, "非 proxy-*.jsonl 文件不得删除");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cleanupExpired 目录不存在时不抛异常", () => {
  assert.doesNotThrow(() => cleanupExpired("/no/such/dir/at/all", 7));
});
