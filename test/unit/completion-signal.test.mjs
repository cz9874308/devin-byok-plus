import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSignalCompletion } from '../../src/proxy/handlers/completion-signal.js';

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
});
