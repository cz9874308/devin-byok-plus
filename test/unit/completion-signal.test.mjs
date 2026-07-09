import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSignalCompletion,
  isSoundEligibleRequest,
} from '../../src/proxy/handlers/completion-signal.js';

describe('shouldSignalCompletion', () => {
  it('natural end with no tools → true', () => {
    assert.equal(shouldSignalCompletion('stop', []), true);
    assert.equal(shouldSignalCompletion('end_turn', []), true);
  });

  it('error → true', () => {
    assert.equal(shouldSignalCompletion('error', []), true);
    assert.equal(shouldSignalCompletion('error', ['some_tool']), true);
  });

  it('tool_use stopReason (anthropic) → false', () => {
    assert.equal(shouldSignalCompletion('tool_use', []), false);
  });

  it('non-empty toolsCalled (openai) → false', () => {
    assert.equal(shouldSignalCompletion('stop', ['read_file', 'write_file']), false);
    assert.equal(shouldSignalCompletion('end_turn', ['search']), false);
  });

  it('unknown stopReason with no tools → true', () => {
    assert.equal(shouldSignalCompletion('max_tokens', []), true);
    assert.equal(shouldSignalCompletion('length', []), true);
  });

  it('soundEligible=false → 一律不触发 (辅助子 agent)', () => {
    assert.equal(shouldSignalCompletion('end_turn', [], false), false);
    assert.equal(shouldSignalCompletion('stop', [], false), false);
    // 即使出错, 辅助子 agent 也不发声
    assert.equal(shouldSignalCompletion('error', [], false), false);
  });

  it('soundEligible=true (默认) → 维持原判定', () => {
    assert.equal(shouldSignalCompletion('end_turn', [], true), true);
    assert.equal(shouldSignalCompletion('tool_use', [], true), false);
  });
});

describe('isSoundEligibleRequest', () => {
  it('无工具 / 空数组 / 非数组 → false', () => {
    assert.equal(isSoundEligibleRequest([]), false);
    assert.equal(isSoundEligibleRequest(undefined), false);
    assert.equal(isSoundEligibleRequest(null), false);
    assert.equal(isSoundEligibleRequest('read_file'), false);
  });

  it('仅 do_not_call 哨兵 → false (辅助子 agent)', () => {
    assert.equal(isSoundEligibleRequest(['do_not_call']), false);
    assert.equal(isSoundEligibleRequest(['do_not_call', ' do_not_call ']), false);
  });

  it('含至少一个真实工具 → true (主对话)', () => {
    assert.equal(isSoundEligibleRequest(['read_file']), true);
    assert.equal(isSoundEligibleRequest(['do_not_call', 'read_file']), true);
    assert.equal(isSoundEligibleRequest(['grep_search', 'code_search', 'edit']), true);
  });

  it('全空串工具名 → false', () => {
    assert.equal(isSoundEligibleRequest(['', '  ']), false);
  });
});
