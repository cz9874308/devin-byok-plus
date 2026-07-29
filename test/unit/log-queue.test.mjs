import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogQueue } from "../../src/proxy/logging/log-queue.js";

function fakeSinks() {
  const asyncWrites = [];
  const syncWrites = [];
  let inFlight = 0;
  let maxConcurrent = 0;
  return {
    asyncWrites,
    syncWrites,
    maxConcurrent: () => maxConcurrent,
    appendAsync: (text) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      return new Promise((resolve) => {
        setTimeout(() => {
          asyncWrites.push(text);
          inFlight--;
          resolve();
        }, 1);
      });
    },
    appendSync: (text) => {
      syncWrites.push(text);
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test("多条普通事件攒批合并为一次写入", async () => {
  const s = fakeSinks();
  const q = createLogQueue({ appendAsync: s.appendAsync, appendSync: s.appendSync });
  q.push("a", false);
  q.push("b", false);
  q.push("c", false);
  await tick();
  assert.equal(s.asyncWrites.length, 1, "应合并为单次写入");
  assert.ok(s.asyncWrites[0].includes("a"));
  assert.ok(s.asyncWrites[0].includes("b"));
  assert.ok(s.asyncWrites[0].includes("c"));
});

test("写入串行, 不并发交错", async () => {
  const s = fakeSinks();
  const q = createLogQueue({ appendAsync: s.appendAsync, appendSync: s.appendSync });
  for (let i = 0; i < 20; i++) {
    q.push("line" + i, false);
    await new Promise((r) => setTimeout(r, 0));
  }
  await tick();
  assert.equal(s.maxConcurrent(), 1, "同时最多一个 in-flight 写");
});

test("high 事件立即触发 flush", async () => {
  const s = fakeSinks();
  const q = createLogQueue({ appendAsync: s.appendAsync, appendSync: s.appendSync });
  q.push("urgent", true);
  await tick();
  assert.equal(s.asyncWrites.length, 1);
  assert.ok(s.asyncWrites[0].includes("urgent"));
});

test("背压: 超过行数上限丢最旧的普通事件", () => {
  const s = fakeSinks();
  const q = createLogQueue({
    appendAsync: () => new Promise(() => {}),
    appendSync: s.appendSync,
    maxLines: 5,
  });
  q.push("high-1", true);
  for (let i = 0; i < 50; i++) {
    q.push("normal-" + i, false);
  }
  assert.ok(q.size() <= 6, "队列不得无限增长, 实际=" + q.size());
  assert.ok(q.droppedCount() > 0, "应记录丢弃计数");
});

test("背压: high 事件优先保留", () => {
  const s = fakeSinks();
  const q = createLogQueue({
    appendAsync: () => new Promise(() => {}),
    appendSync: s.appendSync,
    maxLines: 4,
  });
  q.push("HIGHMARK", true);
  for (let i = 0; i < 40; i++) {
    q.push("normal-" + i, false);
  }
  const remaining = q.peekAll().join("\n");
  assert.ok(remaining.includes("HIGHMARK"), "high 事件不得被丢弃");
});

test("背压: 全是 high 时不丢弃", () => {
  const s = fakeSinks();
  const q = createLogQueue({
    appendAsync: () => new Promise(() => {}),
    appendSync: s.appendSync,
    maxLines: 3,
  });
  for (let i = 0; i < 10; i++) {
    q.push("high-" + i, true);
  }
  assert.equal(q.size(), 10, "全 high 时不得丢弃任何事件");
  assert.equal(q.droppedCount(), 0);
});

test("丢弃后 flush 会写出 log_dropped 计数行", async () => {
  const s = fakeSinks();
  const q = createLogQueue({
    appendAsync: s.appendAsync,
    appendSync: s.appendSync,
    maxLines: 3,
  });
  for (let i = 0; i < 20; i++) {
    q.push(JSON.stringify({ i }), false);
  }
  await tick();
  const all = s.asyncWrites.join("");
  assert.ok(all.includes("log_dropped"), "应写出 log_dropped 事件");
});

test("flushSync 写出队列剩余内容", () => {
  const s = fakeSinks();
  const q = createLogQueue({
    appendAsync: () => new Promise(() => {}),
    appendSync: s.appendSync,
  });
  q.push("tail-1", false);
  q.push("tail-2", false);
  q.flushSync();
  assert.equal(s.syncWrites.length, 1);
  assert.ok(s.syncWrites[0].includes("tail-1"));
  assert.ok(s.syncWrites[0].includes("tail-2"));
  assert.equal(q.size(), 0, "兜干后队列应清空");
});

test("flushSync 队列为空时不写入", () => {
  const s = fakeSinks();
  const q = createLogQueue({ appendAsync: s.appendAsync, appendSync: s.appendSync });
  q.flushSync();
  assert.equal(s.syncWrites.length, 0);
});

test("appendAsync 抛错不冒泡, 后续写入仍工作", async () => {
  let calls = 0;
  const ok = [];
  const q = createLogQueue({
    appendAsync: (text) => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new Error("disk full"));
      }
      ok.push(text);
      return Promise.resolve();
    },
    appendSync: () => {},
  });
  q.push("first", false);
  await tick();
  q.push("second", false);
  await tick();
  assert.ok(
    ok.some((t) => t.includes("second")),
    "第一次失败不应阻断后续写入"
  );
});

test("appendAsync 同步抛错不冒泡", () => {
  const q = createLogQueue({
    appendAsync: () => {
      throw new Error("sync boom");
    },
    appendSync: () => {},
  });
  assert.doesNotThrow(() => q.push("x", true));
});

test("appendSync 抛错不冒泡", () => {
  const q = createLogQueue({
    appendAsync: () => Promise.resolve(),
    appendSync: () => {
      throw new Error("boom");
    },
  });
  q.push("x", false);
  assert.doesNotThrow(() => q.flushSync());
});

test("每行以换行结尾, 可逐行解析", async () => {
  const s = fakeSinks();
  const q = createLogQueue({ appendAsync: s.appendAsync, appendSync: s.appendSync });
  q.push(JSON.stringify({ a: 1 }), false);
  q.push(JSON.stringify({ b: 2 }), false);
  await tick();
  const lines = s.asyncWrites[0].split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.doesNotThrow(() => lines.forEach((l) => JSON.parse(l)));
});

test("空字符串 / 非字符串入参被忽略, 不抛异常", () => {
  const s = fakeSinks();
  const q = createLogQueue({ appendAsync: s.appendAsync, appendSync: s.appendSync });
  assert.doesNotThrow(() => q.push("", false));
  assert.doesNotThrow(() => q.push(null, false));
  assert.doesNotThrow(() => q.push(undefined, false));
  assert.doesNotThrow(() => q.push({ not: "string" }, false));
  assert.equal(q.size(), 0, "无效入参不得进队列");
});
