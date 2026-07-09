import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldFallbackToChatCompletions } from "../../src/proxy/handlers/openai-request.js";
import { isAuxiliaryRequest } from "../../src/proxy/handlers/chat.js";

// ── 方案 A：503 + responses-api-not-supported 应触发回退 ──
// 背景：部分第三方 OpenAI 中转网关对 /v1/responses 返回 503 + "not supported"，
// 旧白名单不含 503，导致既报错又污染会话标题。

test("503 + responses-api-not-supported triggers chat/completions fallback", () => {
  assert.equal(
    shouldFallbackToChatCompletions(503, "current gateway does not support responses api"),
    true
  );
  assert.equal(
    shouldFallbackToChatCompletions(503, "new_api_error: convert_request_failed"),
    true
  );
});

test("503 without responses-api keywords does NOT fallback (真过载/无可用账户)", () => {
  assert.equal(
    shouldFallbackToChatCompletions(503, "no available accounts"),
    false
  );
  assert.equal(shouldFallbackToChatCompletions(503, "service overloaded"), false);
  assert.equal(shouldFallbackToChatCompletions(503, ""), false);
});

test("既有状态码仍按关键词回退", () => {
  assert.equal(shouldFallbackToChatCompletions(400, "invalid responses request"), true);
  assert.equal(shouldFallbackToChatCompletions(404, "route not found"), true);
  assert.equal(shouldFallbackToChatCompletions(200, "responses api"), false);
  assert.equal(shouldFallbackToChatCompletions(401, "invalid key"), false);
});

// ── 方案 B：辅助请求（标题/摘要生成）识别 ──
// 主 agent 聊天带大量 tools 或超长 system prompt；标题/摘要类后台请求无 tools 且 prompt 短。

test("无 tools + 短 system prompt 判定为辅助请求", () => {
  assert.equal(isAuxiliaryRequest("Generate a short title.", undefined), true);
  assert.equal(isAuxiliaryRequest("Summarize the conversation.", []), true);
  assert.equal(isAuxiliaryRequest("", undefined), true);
});

test("携带 tools 一律不是辅助请求（即使 prompt 短）", () => {
  assert.equal(isAuxiliaryRequest("short", [{ name: "edit" }]), false);
});

test("超长 system prompt 不是辅助请求（主 agent 聊天）", () => {
  const longPrompt = "x".repeat(5000);
  assert.equal(isAuxiliaryRequest(longPrompt, undefined), false);
});
