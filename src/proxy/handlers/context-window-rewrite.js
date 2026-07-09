import { decodeVarint, writeVarintField, writeBytesField } from "../proto.js";

// GetUserStatus 模型数组的嵌套路径: 顶层.field1 -> field33 -> (repeated field1 = ClientModelConfig 条目)。
// 每个 ClientModelConfig 本级字段(据抓包 + 客户端 bundle proto 定义确认):
//   field1  = label(字符串, 如 'Claude Opus 4 Thinking BYOK')
//   field18 = max_tokens(数值, UI 上下文分母真正读取的字段)
//   field22 = model_uid(字符串, 如 'MODEL_CLAUDE_4_OPUS_THINKING_BYOK', 用于匹配 BYOK 槽位)
//   field23 = model_info(子消息, 内部另有 context_window, 但 UI 分母不读它)
const MODEL_ARRAY_PATH = [1, 33];
const CMC_ENTRY_FIELD = 1;
const CMC_MAX_TOKENS_FIELD = 18;
const CMC_MODEL_UID_FIELD = 22;

// 带偏移的 protobuf 解析: 为每个字段保留其完整原始字节(tag+value), 便于未改动字段原样重编, 保证无损 round-trip。
function parseWithRaw(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const tagStart = pos;
    const tagDec = decodeVarint(buf, pos);
    pos += tagDec.bytesRead;
    const tag = tagDec.value;
    const field = Number(tag >> 0x3n);
    const wireType = Number(tag & 0x7n);
    if (field === 0) {
      break;
    }
    let value = null;
    switch (wireType) {
      case 0: {
        const dec = decodeVarint(buf, pos);
        pos += dec.bytesRead;
        value = dec.value;
        break;
      }
      case 1: {
        pos += 8;
        break;
      }
      case 2: {
        const lenDec = decodeVarint(buf, pos);
        pos += lenDec.bytesRead;
        const len = Number(lenDec.value);
        value = buf.subarray(pos, pos + len);
        pos += len;
        break;
      }
      case 5: {
        pos += 4;
        break;
      }
      default:
        return { fields, ok: false };
    }
    fields.push({ field, wireType, value, raw: buf.subarray(tagStart, pos) });
  }
  return { fields, ok: true };
}

// 重建单个 ClientModelConfig 条目: 读本级 field22(model_uid 字符串)交给 resolver,
// 若解析出 window>0 且与现值不同, 则替换本级 field18(max_tokens, UI 上下文分母真正读的字段)。
// 返回重建后的 Buffer; 若无需改动(未命中/值相同/解析失败)返回 null 表示原样保留。
function rewriteModelEntry(entryBuf, resolver, state) {
  const parsed = parseWithRaw(entryBuf);
  if (!parsed.ok) {
    return null;
  }
  let modelUid = null;
  for (const f of parsed.fields) {
    if (f.field === CMC_MODEL_UID_FIELD && f.wireType === 2 && f.value && modelUid === null) {
      modelUid = f.value.toString("utf8");
    }
  }
  if (!modelUid) {
    return null;
  }
  const window = resolver(modelUid);
  if (!Number.isInteger(window) || window <= 0) {
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
    } else {
      parts.push(f.raw);
    }
  }
  // 若原条目没有 field18(max_tokens), 追加一个, 确保 UI 有分母可读。
  if (!hasMaxTokens) {
    parts.push(writeVarintField(CMC_MAX_TOKENS_FIELD, window));
    replaced = true;
  }
  if (!replaced) {
    return null;
  }
  state.count++;
  return Buffer.concat(parts);
}

// 沿路径逐层下探; 路径末端遍历 repeated 的 ClientModelConfig 条目(field1)并按需重建。
// 未涉及的字段/子树一律用原始字节原样重编, 父级长度前缀由 writeBytesField 按新长度自动重算。
function descend(buf, path, resolver, state) {
  const parsed = parseWithRaw(buf);
  if (!parsed.ok) {
    return buf;
  }
  const parts = [];
  for (const f of parsed.fields) {
    if (path.length > 0) {
      if (f.field === path[0] && f.wireType === 2) {
        const inner = descend(f.value, path.slice(1), resolver, state);
        parts.push(writeBytesField(f.field, inner));
      } else {
        parts.push(f.raw);
      }
      continue;
    }
    if (f.field === CMC_ENTRY_FIELD && f.wireType === 2) {
      const rebuilt = rewriteModelEntry(f.value, resolver, state);
      parts.push(rebuilt === null ? f.raw : writeBytesField(CMC_ENTRY_FIELD, rebuilt));
      continue;
    }
    parts.push(f.raw);
  }
  return Buffer.concat(parts);
}

// 改写 GetUserStatus 的已解压 payload, 将命中模型条目的 max_tokens(field18) 替换为 resolver 给出的目标值。
// resolver: (modelUid:string) => number   返回 0 或非正数表示该模型不改写。
// 返回 { buffer, changed, count }; 任何异常均退化为原样透传(changed=false)。
export function rewriteUserStatusContextWindow(decoded, resolver) {
  const state = { count: 0 };
  try {
    const buffer = descend(decoded, MODEL_ARRAY_PATH, resolver, state);
    return { buffer, changed: state.count > 0, count: state.count };
  } catch {
    return { buffer: decoded, changed: false, count: 0 };
  }
}
