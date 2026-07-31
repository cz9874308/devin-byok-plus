import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStreamLifecycle } from "../../src/proxy/handlers/stream-lifecycle.js";

// 假客户端响应：只需要 write / end / writableEnded / on('close')
function fakeRes() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.written = [];
  res.write = (chunk) => {
    res.written.push(chunk);
    return true;
  };
  res.end = () => {
    res.writableEnded = true;
  };
  return res;
}

function makeLifecycle(res) {
  // 参数顺序：(clientRes, getUpstreamReq, providerLabel, messageId, timing, options)
  return createStreamLifecycle(res, () => null, "Anthropic", "msg_1", null);
}

test("detach 后心跳不再向客户端写入", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  try {
    const res = fakeRes();
    const lc = makeLifecycle(res);
    lc.startHeartbeat();
    mock.timers.tick(3100);
    const afterFirstTick = res.written.length;
    assert.ok(afterFirstTick >= 1, "心跳应至少写出一次");
    lc.detach();
    mock.timers.tick(12000);
    assert.equal(res.written.length, afterFirstTick, "detach 后不应再有写入");
  } finally {
    mock.timers.reset();
  }
});

test("detach 后 close 监听归零，且重复调用幂等不抛", () => {
  const res = fakeRes();
  const lc = makeLifecycle(res);
  assert.equal(res.listenerCount("close"), 1);
  lc.detach();
  assert.equal(res.listenerCount("close"), 0);
  assert.doesNotThrow(() => lc.detach());
});

test("多次重建 lifecycle 且每次 detach 时监听不累积", () => {
  const res = fakeRes();
  for (let i = 0; i < 3; i++) {
    const lc = makeLifecycle(res);
    lc.detach();
  }
  const lc = makeLifecycle(res);
  assert.equal(res.listenerCount("close"), 1, "同一响应上只应有一个活跃 close 监听");
  lc.detach();
});

test("finalize 幂等：第二次返回 false", () => {
  const res = fakeRes();
  const lc = makeLifecycle(res);
  assert.equal(lc.finalize(), true);
  assert.equal(lc.finalize(), false);
  assert.equal(res.writableEnded, true);
});

test("fail 写出错误块并收尾，重复调用返回 false", () => {
  const res = fakeRes();
  const lc = makeLifecycle(res);
  assert.equal(lc.fail("[Anthropic Empty Stream]"), true);
  assert.ok(res.written.length >= 2, "应写出错误块与结束包");
  assert.equal(lc.fail("again"), false);
});

test("客户端 close 后 wasClosedByClient 为真", () => {
  const res = fakeRes();
  const lc = makeLifecycle(res);
  assert.equal(lc.wasClosedByClient(), false);
  res.emit("close");
  assert.equal(lc.wasClosedByClient(), true);
});
