import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeContextWindow } from "../../src/proxy/handlers/byok-slots.js";
import { setRuntimeConfig, getSlotContextWindow } from "../../src/proxy/handlers/models.js";

// ── sanitizeContextWindow ────────────────────────────────────

test("sanitizeContextWindow: 合法档位原样返回", () => {
  assert.equal(sanitizeContextWindow(500000), 500000);
  assert.equal(sanitizeContextWindow(1000000), 1000000);
  assert.equal(sanitizeContextWindow("500000"), 500000);
  assert.equal(sanitizeContextWindow("1000000"), 1000000);
  assert.equal(sanitizeContextWindow(0), 0);
  assert.equal(sanitizeContextWindow(""), 0);
});

test("sanitizeContextWindow: 非法值归 0", () => {
  assert.equal(sanitizeContextWindow(-1), 0);
  assert.equal(sanitizeContextWindow(123456), 0); // 未知档位
  assert.equal(sanitizeContextWindow("abc"), 0);
  assert.equal(sanitizeContextWindow(null), 0);
  assert.equal(sanitizeContextWindow(undefined), 0);
  assert.equal(sanitizeContextWindow(200000), 0); // 200K 不是可选档位
});

// ── getSlotContextWindow 运行态 + 热更新 ──────────────────────

test("getSlotContextWindow: 热更新后按槽位返回", () => {
  setRuntimeConfig({
    BYOK1_CONTEXT_WINDOW: "1000000",
    BYOK2_CONTEXT_WINDOW: "500000",
    BYOK3_CONTEXT_WINDOW: "",
    BYOK4_CONTEXT_WINDOW: "999", // 非法 -> 0
  });
  assert.equal(getSlotContextWindow(1), 1000000);
  assert.equal(getSlotContextWindow(2), 500000);
  assert.equal(getSlotContextWindow(3), 0);
  assert.equal(getSlotContextWindow(4), 0);
});

test("getSlotContextWindow: 再次热更新可切回原始档(0)", () => {
  setRuntimeConfig({ BYOK1_CONTEXT_WINDOW: "1000000" });
  assert.equal(getSlotContextWindow(1), 1000000);
  setRuntimeConfig({ BYOK1_CONTEXT_WINDOW: "" });
  assert.equal(getSlotContextWindow(1), 0);
});
