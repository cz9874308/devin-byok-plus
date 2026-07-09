// 判断 emitChatEnd 事件是否应触发"任务完成"声音信号。
// 规则:
//   1. toolsCalled 非空 → 中间工具轮, 不触发
//   2. stopReason === 'tool_use' (Anthropic 变体) → 中间工具轮, 不触发
//   3. stopReason === 'error' → 出错, 触发
//   4. toolsCalled 为空且非 tool_use → 自然结束, 触发

export function shouldSignalCompletion(stopReason, toolsCalled) {
  // 出错 → 无论是否有工具列表, 始终触发
  if (stopReason === 'error') {
    return true;
  }
  // 中间轮: 有工具调用
  if (Array.isArray(toolsCalled) && toolsCalled.length > 0) {
    return false;
  }
  // Anthropic 变体: stopReason 为 tool_use 但 toolsCalled 传空数组
  if (stopReason === 'tool_use') {
    return false;
  }
  // 自然结束(stop / end_turn / max_tokens 等)
  return true;
}
