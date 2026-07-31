import { writeVarintField, writeBytesField } from "../proto.js";
import {
  parseWithRaw,
  transformModelArray,
  CMC_MAX_TOKENS_FIELD,
  CMC_MODEL_INFO_FIELD,
  MI_CONTEXT_WINDOW_FIELD,
} from "./userstatus-shape.js";

// 改写 model_info 子消息中的 field4(context_window)。
// 若 field4 存在且值 ≠ targetWindow, 则替换; 无 field4 不追加(保守策略)。
// 返回重建后的 Buffer, 若无变更返回 null。
function rewriteModelInfo(modelInfoBuf, targetWindow) {
  const parsed = parseWithRaw(modelInfoBuf);
  if (!parsed.ok) {
    return null;
  }
  const parts = [];
  let replaced = false;
  for (const f of parsed.fields) {
    if (f.field === MI_CONTEXT_WINDOW_FIELD && f.wireType === 0) {
      if (Number(f.value) === targetWindow) {
        parts.push(f.raw);
      } else {
        parts.push(writeVarintField(MI_CONTEXT_WINDOW_FIELD, targetWindow));
        replaced = true;
      }
    } else {
      parts.push(f.raw);
    }
  }
  return replaced ? Buffer.concat(parts) : null;
}

// 重建单个 ClientModelConfig 条目: 按 model_uid 解析出目标窗口,
// 替换本级 field18(max_tokens, UI 分母) 及 field23 内的 field4(压缩阈值)。
// 返回 null 表示原样保留。
function rewriteModelEntry(entryBuf, modelUid, resolver) {
  if (!modelUid) {
    return null;
  }
  const window = resolver(modelUid);
  if (!Number.isInteger(window) || window <= 0) {
    return null;
  }
  const parsed = parseWithRaw(entryBuf);
  if (!parsed.ok) {
    return null;
  }
  const parts = [];
  let replaced = false;
  let hasMaxTokens = false;
  for (const f of parsed.fields) {
    if (f.field === CMC_MAX_TOKENS_FIELD && f.wireType === 0) {
      hasMaxTokens = true;
      if (Number(f.value) === window) {
        parts.push(f.raw);
      } else {
        parts.push(writeVarintField(CMC_MAX_TOKENS_FIELD, window));
        replaced = true;
      }
    } else if (f.field === CMC_MODEL_INFO_FIELD && f.wireType === 2) {
      const rebuilt = rewriteModelInfo(f.value, window);
      if (rebuilt !== null) {
        parts.push(writeBytesField(CMC_MODEL_INFO_FIELD, rebuilt));
        replaced = true;
      } else {
        parts.push(f.raw);
      }
    } else {
      parts.push(f.raw);
    }
  }
  // 原条目无 field18 时补一个, 确保 UI 有分母可读。
  if (!hasMaxTokens) {
    parts.push(writeVarintField(CMC_MAX_TOKENS_FIELD, window));
    replaced = true;
  }
  return replaced ? Buffer.concat(parts) : null;
}

// 改写 GetUserStatus 已解压 payload, 把命中模型的上下文窗口替换为 resolver 给出的值。
// resolver: (modelUid:string) => number   返回 0 或非正数表示不改写。
// 返回 { buffer, changed, count }; 任何异常退化为原样透传。
export function rewriteUserStatusContextWindow(decoded, resolver) {
  return transformModelArray(decoded, {
    mapEntry: (entryBuf, modelUid) => rewriteModelEntry(entryBuf, modelUid, resolver),
  });
}