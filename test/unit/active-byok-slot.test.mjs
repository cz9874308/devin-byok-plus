import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requiresConfiguredDefaultModel,
  getActiveByokSlot,
  setActiveByokSlot,
} from "../../src/proxy/handlers/chat.js";
import { setRuntimeConfig } from "../../src/proxy/handlers/models.js";

// ── resolveConfiguredModel fallbackSlot ──

test("requiresConfiguredDefaultModel with fallbackSlot uses slot model", () => {
  setRuntimeConfig({
    defaultModel: "",
    BYOK1_MODEL: "",
    BYOK3_MODEL: "gpt-5.5",
  });

  // MODEL_SWE_1 无 fallbackSlot → 不需要默认模型（MODEL_MAP 硬编码了 claude-sonnet-4）
  assert.equal(
    requiresConfiguredDefaultModel("MODEL_SWE_1"),
    false,
    "无 fallbackSlot 时 MODEL_SWE_1 有硬编码回退"
  );

  // MODEL_SWE_1 + fallbackSlot=3 → 检查 BYOK3 是否配置了模型
  assert.equal(
    requiresConfiguredDefaultModel("MODEL_SWE_1", 3),
    false,
    "fallbackSlot=3 已配置 gpt-5.5，应允许"
  );
});

test("requiresConfiguredDefaultModel with fallbackSlot blocks unconfigured slot", () => {
  setRuntimeConfig({
    defaultModel: "",
    BYOK1_MODEL: "",
    BYOK3_MODEL: "",
  });

  assert.equal(
    requiresConfiguredDefaultModel("MODEL_SWE_1", 3),
    true,
    "fallbackSlot=3 未配置模型，应拦截"
  );
});

// ── _activeByokSlot 状态管理 ──

test("setActiveByokSlot / getActiveByokSlot 状态管理", () => {
  setActiveByokSlot(null);
  assert.equal(getActiveByokSlot(), null);

  setActiveByokSlot(3);
  assert.equal(getActiveByokSlot(), 3);

  setActiveByokSlot(1);
  assert.equal(getActiveByokSlot(), 1, "新槽位覆盖旧值");
});

test("requiresConfiguredDefaultModel + activeByokSlot 继承验证", () => {
  setRuntimeConfig({
    defaultModel: "",
    BYOK1_MODEL: "",
    BYOK3_MODEL: "gpt-5.5",
  });

  // 模拟：先有 BYOK3 主请求设置了 activeSlot
  setActiveByokSlot(3);

  // 子请求 MODEL_SWE_1 + fallbackSlot=3（来自 activeByokSlot）
  assert.equal(
    requiresConfiguredDefaultModel("MODEL_SWE_1", 3),
    false,
    "继承 slot 3 的 gpt-5.5 配置"
  );

  // 清理
  setActiveByokSlot(null);
});

// ── 完整场景测试 ──

test("直接 BYOK 匹配优先于继承槽位", () => {
  setRuntimeConfig({
    BYOK1_MODEL: "claude-opus-4",
    BYOK3_MODEL: "gpt-5.5",
  });

  setActiveByokSlot(3);

  // MODEL_CLAUDE_4_OPUS_BYOK 直接匹配 slot 1，不继承 slot 3
  assert.equal(
    requiresConfiguredDefaultModel("MODEL_CLAUDE_4_OPUS_BYOK", 1),
    false,
    "直接匹配 slot 1"
  );
});

test("用户切换槽位更新 _activeByokSlot", () => {
  setActiveByokSlot(1);
  assert.equal(getActiveByokSlot(), 1);

  setActiveByokSlot(3);
  assert.equal(getActiveByokSlot(), 3, "切换到 slot 3");

  setActiveByokSlot(2);
  assert.equal(getActiveByokSlot(), 2, "切换到 slot 2");
});

test("未设置 _activeByokSlot 时向后兼容", () => {
  setRuntimeConfig({
    defaultModel: "",
    BYOK1_MODEL: "",
  });

  setActiveByokSlot(null);

  // MODEL_CHAT 映射到 __DEFAULT__，无默认模型 → 应拦截
  assert.equal(
    requiresConfiguredDefaultModel("MODEL_CHAT"),
    true,
    "无 activeSlot 时走原有 MODEL_MAP 回退"
  );

  // MODEL_SWE_1 有硬编码回退 → 不拦截
  assert.equal(
    requiresConfiguredDefaultModel("MODEL_SWE_1"),
    false,
    "MODEL_SWE_1 有硬编码 claude-sonnet-4 回退"
  );
});
