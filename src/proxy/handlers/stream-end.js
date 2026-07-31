// 判定「流是怎么结束的」，以及空流是否还该重试。
// 纯函数，不 import 任何业务模块（见 spec 3.2 / 第 7 节不变量 5）。
// 任何畸形入参都返回最保守的 PARTIAL —— PARTIAL 既不重试也不报错，
// 与改造前的行为完全一致，因此误判时最坏结果是「维持现状」。

export const StreamEnd = Object.freeze({
  CLOSED: 'closed', // 客户端主动关闭
  NORMAL: 'normal', // 收到终止事件
  EMPTY: 'empty', // 无终止事件且零内容写出
  PARTIAL: 'partial', // 无终止事件但已写出内容
});

export function classifyStreamEnd(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return StreamEnd.PARTIAL;
  }
  if (state.closedByClient === true) {
    return StreamEnd.CLOSED;
  }
  if (state.isDone === true) {
    return StreamEnd.NORMAL;
  }
  return state.emittedContent === true ? StreamEnd.PARTIAL : StreamEnd.EMPTY;
}

export function shouldRetry(kind, attempt, max) {
  if (kind !== StreamEnd.EMPTY) {
    return false;
  }
  const done = Number(attempt);
  const limit = Number(max);
  if (!Number.isFinite(done) || !Number.isFinite(limit)) {
    return false;
  }
  return done < limit;
}
