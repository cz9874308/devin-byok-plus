// 客户端响应的写入与资源生命周期：心跳、幂等收尾、失败收尾、客户端断开侦测。
// 从 chat.js 原样搬迁（见 docs/superpowers/specs/2026-07-30-empty-stream-and-log-diagnostics-design.md 3.5），
// 本次搬迁不改任何逻辑，便于 diff 逐行核对。
import { buildErrorChunk, buildStopChunk, buildTextDelta, STOP_REASON } from './build-response.js';
import { endOfStreamEnvelope, wrapEnvelope } from '../connect.js';

export function createStreamLifecycle(arg0, fn, arg2, arg3, arg4, tmp0 = {}) {
  const suppressErrorBody = tmp0.suppressErrorBody === true;
  let tmp5 = false;
  let tmp6 = false;
  let tmp7 = null;
  let tmp8 = Date.now();
  const tmp9 = 3000;
  const tmp10 = () => {
    if (tmp7) {
      return;
    }
    tmp7 = setInterval(() => {
      if (tmp6 || arg0.writableEnded || tmp5) {
        clearInterval(tmp7);
        tmp7 = null;
        return;
      }
      if (Date.now() - tmp8 >= tmp9) {
        arg0.write(wrapEnvelope(buildTextDelta(arg3, '', 0)));
      }
    }, tmp9);
  };
  const fn2 = () => {
    if (tmp7) {
      clearInterval(tmp7);
      tmp7 = null;
    }
  };
  const fn3 = (arg02) => {
    if (!arg0.writableEnded && !tmp5) {
      if (arg4) {
        arg4.mark('first_windsurf_write');
      }
      arg0.write(arg02);
      tmp8 = Date.now();
    }
  };
  const fn4 = (arg02) => {
    if (tmp6 || arg0.writableEnded || tmp5) {
      return false;
    }
    tmp6 = true;
    fn2();
    fn3(endOfStreamEnvelope());
    arg0.end();
    if (arg02) {
      console.log(arg02);
    }
    if (arg4) {
      arg4.summary('finalized');
    }
    return true;
  };
  const tmp14 = (arg02, arg1) => {
    if (tmp5 || arg0.writableEnded) {
      return false;
    }
    if (arg02) {
      if (suppressErrorBody) {
        // 辅助请求（如标题/摘要生成）失败：只发无正文的 ERROR 停止块，
        // 避免错误文案被 Devin 当作正文写入会话标题。
        fn3(wrapEnvelope(buildStopChunk(arg3, STOP_REASON.ERROR)));
        console.log('  🛡️  Suppressed error body for auxiliary request: ' + arg02);
      } else {
        fn3(wrapEnvelope(buildErrorChunk(arg3, arg02)));
      }
    }
    return fn4(arg1);
  };
  arg0.on('close', () => {
    if (arg0.writableEnded || tmp5) {
      return;
    }
    tmp5 = true;
    tmp6 = true;
    fn2();
    const tmp02 = fn();
    if (tmp02 && !tmp02.destroyed) {
      console.log('  ℹ️  Client disconnected, stopping ' + arg2 + ' upstream stream');
      if (arg4) {
        arg4.summary('client_disconnected');
      }
      tmp02.destroy();
    }
  });
  const tmp15 = {
    safeWrite: fn3,
    finalize: fn4,
    fail: tmp14,
    startHeartbeat: tmp10,
    wasClosedByClient: () => tmp5,
  };
  return tmp15;
}
