import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicStreamProcessor, isTruncatedToolArgs } from "../../src/proxy/handlers/anthropic-stream.js";

// 模拟上游 SSE 事件序列驱动处理器
function feed(processor, events) {
  const out = [];
  for (const ev of events) {
    for (const chunk of processor.processEvent(ev)) {
      out.push(chunk);
    }
  }
  return out;
}

test("isTruncatedToolArgs: empty buffer is not truncated (no args)", () => {
  assert.equal(isTruncatedToolArgs(""), false);
  assert.equal(isTruncatedToolArgs("   "), false);
  assert.equal(isTruncatedToolArgs(null), false);
  assert.equal(isTruncatedToolArgs(undefined), false);
});

test("isTruncatedToolArgs: valid JSON is not truncated", () => {
  assert.equal(isTruncatedToolArgs('{"file_path":"a.ts"}'), false);
  assert.equal(isTruncatedToolArgs('{}'), false);
});

test("isTruncatedToolArgs: incomplete JSON is truncated", () => {
  assert.equal(isTruncatedToolArgs('{"file_path": "a.ts", "old_string": "// END\\n'), true);
  assert.equal(isTruncatedToolArgs('{"a":'), true);
});

test("processor flags truncated tool_use and does not emit a tool call", () => {
  const p = new AnthropicStreamProcessor("msg1", "claude-opus-4-7");
  const chunks = feed(p, [
    { event: "content_block_start", data: { index: 0, content_block: { type: "tool_use", id: "t1", name: "edit" } } },
    { event: "content_block_delta", data: { index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"a.ts","old_string":"x' } } },
    // 注意：没有完整收尾，content_block_stop 时缓冲区是截断 JSON
    { event: "content_block_stop", data: { index: 0 } }
  ]);
  assert.equal(p.hasTruncatedToolCall, true);
  assert.equal(p.truncatedToolName, "edit");
  assert.equal(p.hasEmittedOutput, false);
  // 不应发出任何工具调用 chunk
  assert.equal(chunks.length, 0);
});

test("processor does not flag truncation for complete tool_use", () => {
  const p = new AnthropicStreamProcessor("msg2", "claude-opus-4-7");
  feed(p, [
    { event: "content_block_start", data: { index: 0, content_block: { type: "tool_use", id: "t1", name: "read_file" } } },
    { event: "content_block_delta", data: { index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"a.ts"}' } } },
    { event: "content_block_stop", data: { index: 0 } }
  ]);
  assert.equal(p.hasTruncatedToolCall, false);
  assert.equal(p.hasEmittedOutput, true);
});

test("processor marks hasEmittedOutput when text is emitted before truncation", () => {
  const p = new AnthropicStreamProcessor("msg3", "claude-opus-4-7");
  feed(p, [
    { event: "content_block_start", data: { index: 0, content_block: { type: "text" } } },
    { event: "content_block_delta", data: { index: 0, delta: { type: "text_delta", text: "hello world" } } },
    { event: "content_block_stop", data: { index: 0 } },
    { event: "content_block_start", data: { index: 1, content_block: { type: "tool_use", id: "t1", name: "edit" } } },
    { event: "content_block_delta", data: { index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"a' } } },
    { event: "content_block_stop", data: { index: 1 } }
  ]);
  assert.equal(p.hasTruncatedToolCall, true);
  // 已经发过文本 ⇒ 不能安全重试
  assert.equal(p.hasEmittedOutput, true);
});

test("max_tokens 截断：stopReason 被记录，供 chat.js 区分根因（预算用尽 vs 网关断流）", () => {
  const p = new AnthropicStreamProcessor("msg4", "claude-opus-4-7");
  feed(p, [
    { event: "content_block_start", data: { index: 0, content_block: { type: "text" } } },
    { event: "content_block_delta", data: { index: 0, delta: { type: "text_delta", text: "Now writing PART 09 — TaskPage:" } } },
    { event: "content_block_stop", data: { index: 0 } },
    { event: "content_block_start", data: { index: 1, content_block: { type: "tool_use", id: "t1", name: "edit" } } },
    { event: "content_block_delta", data: { index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"a.ts","old_string":"x' } } },
    { event: "content_block_stop", data: { index: 1 } },
    // 预算用尽时上游补发 message_delta(max_tokens) + message_stop
    { event: "message_delta", data: { delta: { stop_reason: "max_tokens" } } },
    { event: "message_stop", data: {} }
  ]);
  assert.equal(p.hasTruncatedToolCall, true);
  assert.equal(p.hasEmittedOutput, true);
  assert.equal(p.stopReason, "max_tokens");
  // 上游补发了 message_stop ⇒ 处理器自行干净收尾，chat.js 优雅路径无需再合成
  assert.equal(p.isDone, true);
});

test("网关断流截断：无 message_stop ⇒ isDone=false，由 chat.js 合成收尾", () => {
  const p = new AnthropicStreamProcessor("msg5", "claude-opus-4-7");
  feed(p, [
    { event: "content_block_start", data: { index: 0, content_block: { type: "text" } } },
    { event: "content_block_delta", data: { index: 0, delta: { type: "text_delta", text: "writing file" } } },
    { event: "content_block_stop", data: { index: 0 } },
    { event: "content_block_start", data: { index: 1, content_block: { type: "tool_use", id: "t1", name: "edit" } } },
    { event: "content_block_delta", data: { index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"a' } } },
    { event: "content_block_stop", data: { index: 1 } }
    // 网关断流：没有 message_delta / message_stop
  ]);
  assert.equal(p.hasTruncatedToolCall, true);
  assert.equal(p.hasEmittedOutput, true);
  assert.notEqual(p.stopReason, "max_tokens");
  assert.equal(p.isDone, false);
});
