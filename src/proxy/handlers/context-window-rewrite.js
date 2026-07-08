import { decodeVarint, writeVarintField, writeBytesField } from "../proto.js";

// GetUserStatus 模型数组的嵌套路径: 顶层.field1 -> field33 -> field1 -> (repeated) field23
// 到达路径末端的层后, field23 为 repeated 的模型条目; 每个条目含 field1(模型数值ID) 与 field4(contextWindow)。
const MODEL_ARRAY_PATH = [1, 33, 1];
const MODEL_ENTRY_FIELD = 23;
const MODEL_ID_FIELD = 1;
const CONTEXT_WINDOW_FIELD = 4;

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

// 重建单个模型条目: 若该条目的模型ID经 resolver 解析出 window>0 且与现值不同, 则替换其 field4。
// 返回重建后的 Buffer; 若无需改动(未命中/无 field4/值相同/解析失败)返回 null 表示原样保留。
function rewriteModelEntry(entryBuf, resolver, state) {
  const parsed = parseWithRaw(entryBuf);
  if (!parsed.ok) {
    return null;
  }
  let modelId = null;
  for (const f of parsed.fields) {
    if (f.field === MODEL_ID_FIELD && f.wireType === 0) {
      modelId = Number(f.value);
      break;
    }
  }
  if (modelId === null) {
    return null;
  }
  const window = resolver(modelId);
  if (!Number.isInteger(window) || window <= 0) {
    return null;
  }
  const parts = [];
  let replaced = false;
  for (const f of parsed.fields) {
    if (f.field === CONTEXT_WINDOW_FIELD && f.wireType === 0) {
      if (Number(f.value) === window) {
        parts.push(f.raw);
      } else {
        parts.push(writeVarintField(CONTEXT_WINDOW_FIELD, window));
        replaced = true;
      }
    } else {
      parts.push(f.raw);
    }
  }
  if (!replaced) {
    return null;
  }
  state.count++;
  return Buffer.concat(parts);
}

// 沿路径逐层下探; 路径末端遍历 repeated 模型条目并按需重建。
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
    if (f.field === MODEL_ENTRY_FIELD && f.wireType === 2) {
      const rebuilt = rewriteModelEntry(f.value, resolver, state);
      parts.push(rebuilt === null ? f.raw : writeBytesField(MODEL_ENTRY_FIELD, rebuilt));
      continue;
    }
    parts.push(f.raw);
  }
  return Buffer.concat(parts);
}

// 改写 GetUserStatus 的已解压 payload, 将命中模型条目的 contextWindow(field4) 替换为 resolver 给出的目标值。
// resolver: (modelId:number) => number   返回 0 或非正数表示该模型不改写。
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
