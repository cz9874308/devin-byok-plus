import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicStreamProcessor } from "../../src/proxy/handlers/anthropic-stream.js";

function newProcessor() {
  // 构造参数：(messageId, modelUid, targetId)
  return new AnthropicStreamProcessor("msg_1", "model_uid_1", null);
}

test("新建时 emittedContent 为 false", () => {
  assert.equal(newProcessor().emittedContent, false);
});

test("只有 message_start 的空流：emittedContent 仍为 false", () => {
  const p = newProcessor();
  p.processEvent({
    event: "message_start",
    data: { message: { usage: { input_tokens: 10, cache_creation_input_tokens: 19444 } } },
  });
  assert.equal(p.emittedContent, false);
  assert.equal(p.isDone, false);
});

test("文本 delta 写出后 emittedContent 为 true", () => {
  const p = newProcessor();
  p.processEvent({ event: "content_block_start", data: { index: 0, content_block: { type: "text" } } });
  p.processEvent({
    event: "content_block_delta",
    data: { index: 0, delta: { type: "text_delta", text: "hello world" } },
  });
  p.processEvent({ event: "content_block_stop", data: { index: 0 } });
  assert.equal(p.emittedContent, true);
});

test("tool_use 写出后 emittedContent 为 true", () => {
  const p = newProcessor();
  p.processEvent({
    event: "content_block_start",
    data: { index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read_file" } },
  });
  p.processEvent({
    event: "content_block_delta",
    data: { index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"a.js"}' } },
  });
  p.processEvent({ event: "content_block_stop", data: { index: 0 } });
  assert.equal(p.emittedContent, true);
  assert.deepEqual(p.getToolsCalled(), ["read_file"]);
});

test("thinking 块不算内容写出（客户端未收到正文）", () => {
  const p = newProcessor();
  p.processEvent({
    event: "content_block_start",
    data: { index: 0, content_block: { type: "thinking" } },
  });
  p.processEvent({
    event: "content_block_delta",
    data: { index: 0, delta: { type: "thinking_delta", thinking: "思考中" } },
  });
  assert.equal(p.emittedContent, false);
});

test("emittedContent 只增不减", () => {
  const p = newProcessor();
  p.processEvent({ event: "content_block_start", data: { index: 0, content_block: { type: "text" } } });
  p.processEvent({
    event: "content_block_delta",
    data: { index: 0, delta: { type: "text_delta", text: "x" } },
  });
  p.processEvent({ event: "content_block_stop", data: { index: 0 } });
  p.processEvent({ event: "message_stop", data: {} });
  assert.equal(p.emittedContent, true);
  assert.equal(p.isDone, true);
});
