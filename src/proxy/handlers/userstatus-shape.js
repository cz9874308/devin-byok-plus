import { decodeVarint, writeBytesField } from "../proto.js";

// GetUserStatus 模型数组嵌套路径: 顶层.field1 -> field33 -> (repeated field1 = ClientModelConfig 条目)
export const MODEL_ARRAY_PATH = [1, 33];
export const CMC_ENTRY_FIELD = 1;
export const CMC_LABEL_FIELD = 1;
export const CMC_MAX_TOKENS_FIELD = 18;
export const CMC_MODEL_UID_FIELD = 22;
export const CMC_MODEL_INFO_FIELD = 23;
export const CMC_ACCESS_FIELD = 24;
export const MI_CONTEXT_WINDOW_FIELD = 4;

// ── sorts 白名单（2026-09-15 新版 UI 渲染机制）──────────────────────────
// CascadeModelConfigData: f1=client_model_configs(repeated), f2=client_model_sorts(repeated)
// ClientModelSort: f1=name(string), f2=groups(repeated ClientModelGroup)
// ClientModelGroup: f1=groupName(string), f2=modelLabels(repeated string)
// UI 按 sorts[].groups[].modelLabels 白名单渲染模型; name 为 "All"/"Recommended" 的 sort 为默认视图。
export const CMCD_SORTS_FIELD = 2;
export const SORT_NAME_FIELD = 1;
export const SORT_GROUPS_FIELD = 2;
export const GROUP_NAME_FIELD = 1;
export const GROUP_LABELS_FIELD = 2;

// 带偏移的 protobuf 解析: 为每个字段保留其完整原始字节(tag+value),
// 便于未改动字段原样重编, 保证无损 round-trip。
export function parseWithRaw(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const tagStart = pos;
    const tagDec = decodeVarint(buf, pos);
    pos += tagDec.bytesRead;
    const field = Number(tagDec.value >> 0x3n);
    const wireType = Number(tagDec.value & 0x7n);
    if (field === 0) {
      break;
    }
    let value;
    switch (wireType) {
      case 0: {
        const dec = decodeVarint(buf, pos);
        pos += dec.bytesRead;
        value = dec.value;
        break;
      }
      case 1: {
        value = buf.subarray(pos, pos + 8);
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
        value = buf.subarray(pos, pos + 4);
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

// 读取 ClientModelConfig 条目的 model_uid(field22)。
export function readModelUid(entryBuf) {
  const parsed = parseWithRaw(entryBuf);
  if (!parsed.ok) {
    return null;
  }
  for (const f of parsed.fields) {
    if (f.field === CMC_MODEL_UID_FIELD && f.wireType === 2 && f.value) {
      return f.value.toString("utf8");
    }
  }
  return null;
}

// 读取 ClientModelSort 条目的 name(field1)。
export function readSortName(sortBuf) {
  const parsed = parseWithRaw(sortBuf);
  if (!parsed.ok) {
    return null;
  }
  for (const f of parsed.fields) {
    if (f.field === SORT_NAME_FIELD && f.wireType === 2 && f.value) {
      return f.value.toString("utf8");
    }
  }
  return null;
}

function descend(buf, path, handler, state) {
  const parsed = parseWithRaw(buf);
  if (!parsed.ok) {
    return buf;
  }
  const parts = [];
  for (const f of parsed.fields) {
    if (path.length > 0) {
      if (f.field === path[0] && f.wireType === 2) {
        parts.push(writeBytesField(f.field, descend(f.value, path.slice(1), handler, state)));
      } else {
        parts.push(f.raw);
      }
      continue;
    }
    if (f.field === CMC_ENTRY_FIELD && f.wireType === 2) {
      const uid = readModelUid(f.value);
      state.existingUids.push(uid);
      if (handler.mapEntry) {
        const rebuilt = handler.mapEntry(f.value, uid);
        if (rebuilt !== null && rebuilt !== undefined) {
          parts.push(writeBytesField(CMC_ENTRY_FIELD, rebuilt));
          state.count++;
          continue;
        }
      }
      parts.push(f.raw);
      continue;
    }
    parts.push(f.raw);
  }
  if (path.length === 0 && handler.appendEntries) {
    const uids = state.existingUids.filter(Boolean);
    for (const payload of handler.appendEntries(new Set(uids))) {
      parts.push(writeBytesField(CMC_ENTRY_FIELD, payload));
      state.count++;
    }
  }
  return Buffer.concat(parts);
}

// 沿 MODEL_ARRAY_PATH 下探到模型数组层, 按 handler 语义变换。
// handler 必须且只能提供 mapEntry / appendEntries 其一:
//   mapEntry(entryBuf, modelUid) -> Buffer | null   逐条改写, null = 原样保留
//   appendEntries(existingUids)  -> Buffer[]        数组级补齐, 返回待追加 payload
// 两键同传视为契约违用直接抛错, 避免隐式顺序依赖。
// 任何异常退化为原样透传。
export function transformModelArray(decoded, handler) {
  if (handler.mapEntry && handler.appendEntries) {
    throw new Error("transformModelArray: mapEntry 与 appendEntries 只能提供其一");
  }
  const state = { count: 0, existingUids: [] };
  try {
    const buffer = descend(decoded, MODEL_ARRAY_PATH, handler, state);
    return { buffer, changed: state.count > 0, count: state.count };
  } catch {
    return { buffer: decoded, changed: false, count: 0 };
  }
}
function descendSortsTop(buf, handler, state) {
  const parsed = parseWithRaw(buf);
  if (!parsed.ok) {
    return buf;
  }
  const parts = [];
  for (const f of parsed.fields) {
    if (f.field === MODEL_ARRAY_PATH[0] && f.wireType === 2) {
      parts.push(writeBytesField(f.field, descendSortsMid(f.value, handler, state)));
    } else {
      parts.push(f.raw);
    }
  }
  return Buffer.concat(parts);
}

function descendSortsMid(buf, handler, state) {
  const parsed = parseWithRaw(buf);
  if (!parsed.ok) {
    return buf;
  }
  const parts = [];
  for (const f of parsed.fields) {
    if (f.field === MODEL_ARRAY_PATH[1] && f.wireType === 2) {
      parts.push(writeBytesField(f.field, transformSortsLevel(f.value, handler, state)));
    } else {
      parts.push(f.raw);
    }
  }
  return Buffer.concat(parts);
}

function transformSortsLevel(buf, handler, state) {
  const parsed = parseWithRaw(buf);
  if (!parsed.ok) {
    return buf;
  }
  const parts = [];
  for (const f of parsed.fields) {
    if (f.field === CMCD_SORTS_FIELD && f.wireType === 2) {
      const name = readSortName(f.value);
      state.existingNames.push(name);
      if (handler.mapSort) {
        const rebuilt = handler.mapSort(f.value, name);
        if (rebuilt !== null && rebuilt !== undefined) {
          parts.push(writeBytesField(CMCD_SORTS_FIELD, rebuilt));
          state.count++;
          continue;
        }
      }
      parts.push(f.raw);
      continue;
    }
    parts.push(f.raw);
  }
  if (handler.appendSorts) {
    const names = state.existingNames.filter(Boolean);
    for (const payload of handler.appendSorts(new Set(names))) {
      parts.push(writeBytesField(CMCD_SORTS_FIELD, payload));
      state.count++;
    }
  }
  return Buffer.concat(parts);
}

// 沿 MODEL_ARRAY_PATH 下探到 CascadeModelConfigData 层, 按 handler 语义变换 sorts 数组。
// handler 契约与 transformModelArray 一致: mapSort / appendSorts 二选一, 同传抛错。
// 任何异常退化为原样透传。
export function transformModelSorts(decoded, handler) {
  if (handler.mapSort && handler.appendSorts) {
    throw new Error("transformModelSorts: mapSort 与 appendSorts 只能提供其一");
  }
  const state = { count: 0, existingNames: [] };
  try {
    const buffer = descendSortsTop(decoded, handler, state);
    return { buffer, changed: state.count > 0, count: state.count };
  } catch {
    return { buffer: decoded, changed: false, count: 0 };
  }
}