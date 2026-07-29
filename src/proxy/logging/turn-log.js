// 单轮（turn）日志上下文。句柄只有 3 个方法（spec 3.4）:
//   ctx.set(partialFields) / ctx.anomaly(code, detail) / ctx.finish(extra)
// finish 幂等 —— 对应现有 streamFinished 那类双重 finalize 风险。
// 所有方法整体裹 try/catch，任何异常一律吞（spec 第 9 节）。
import { severityOf } from "./anomaly.js";
import { logEvent as defaultLogEvent } from "./log-writer.js";

function toDetail(value) {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    // 循环引用等畸形值，退化为类型描述而非抛错
    return "[unserializable]";
  }
}

export function createTurnLog({ turnId, target = null, meta = {}, writer = undefined } = {}) {
  // writer 显式传 null 表示静默（用于测试或未初始化场景）；
  // 传对象则用它；不传则回落到进程级门面。
  const emit =
    writer === null
      ? () => {}
      : writer && typeof writer.logEvent === "function"
        ? (event) => writer.logEvent(event)
        : defaultLogEvent;

  const startedAt = Date.now();
  const fields = { ...(meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {}) };
  const codes = new Set();
  let finished = false;

  function safeEmit(event) {
    try {
      emit(event);
    } catch {
      // 日志绝不打断业务
    }
  }

  return {
    set(partial) {
      try {
        if (finished || !partial || typeof partial !== "object" || Array.isArray(partial)) {
          return;
        }
        Object.assign(fields, partial);
      } catch {
        // 忽略
      }
    },
    anomaly(code, detail) {
      try {
        if (finished || !code) {
          return;
        }
        codes.add(code);
        safeEmit({
          type: "anomaly",
          turnId,
          target,
          code,
          severity: severityOf(code),
          detail: toDetail(detail),
        });
      } catch {
        // 忽略
      }
    },
    finish(extra) {
      try {
        if (finished) {
          return;
        }
        finished = true;
        if (extra && typeof extra === "object" && !Array.isArray(extra)) {
          Object.assign(fields, extra);
        }
        safeEmit({
          type: "chat_turn",
          turnId,
          target,
          ...fields,
          anomalies: [...codes],
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // 忽略
      }
    },
  };
}
