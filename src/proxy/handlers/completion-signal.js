// 判断 emitChatEnd 事件是否应触发"任务完成"声音信号。
// 规则:
//   1. soundEligible === false → 辅助子 agent(如 Fast Context 文本轮), 不触发
//   2. toolsCalled 非空 → 中间工具轮, 不触发
//   3. stopReason === 'tool_use' (Anthropic 变体) → 中间工具轮, 不触发
//   4. stopReason === 'error' → 出错, 触发
//   5. toolsCalled 为空且非 tool_use → 自然结束, 触发

// 哨兵工具名: Devin 给"无需真实工具、仅输出文本"的辅助子 agent 下发的占位符。
// 携带这类工具(或根本无工具)的请求视为辅助请求, 其自然结束不应触发完成声音。
const SENTINEL_TOOL_NAMES = new Set(['do_not_call']);

// 判断某个请求是否有资格触发完成声音。
// 仅当请求携带至少一个"真实工具"(排除哨兵)时才有资格 —— 主对话会下发完整工具集,
// 而 Fast Context 等辅助子 agent 只带 do_not_call 哨兵或不带工具。
export function isSoundEligibleRequest(toolNames) {
  if (!Array.isArray(toolNames) || toolNames.length === 0) {
    return false;
  }
  return toolNames.some(
    (name) => typeof name === 'string' && name.trim() && !SENTINEL_TOOL_NAMES.has(name.trim())
  );
}

export function shouldSignalCompletion(stopReason, toolsCalled, soundEligible = true) {
  // 辅助子 agent(无真实工具): 无论如何结束都不触发
  if (soundEligible === false) {
    return false;
  }
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
