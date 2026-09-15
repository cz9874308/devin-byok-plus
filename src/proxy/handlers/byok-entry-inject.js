import {
  transformModelArray,
  transformModelSorts,
  readModelUid,
  parseWithRaw,
  CMC_LABEL_FIELD,
  SORT_NAME_FIELD,
  SORT_GROUPS_FIELD,
  GROUP_NAME_FIELD,
  GROUP_LABELS_FIELD,
} from "./userstatus-shape.js";
import { writeStringField, writeBytesField } from "../proto.js";

// 2026-07-09 抓包的四条 BYOK 条目 payload(base64, 不含外层 tag+len)。
// 服务端于 2026-07-31 模型目录改版时下架这些条目(载荷比对: 193 条中 BYOK 为 0),
// 此处原样回放补回。
// 各条字段(以 OPUS 为例):
//   f1  = "Claude Opus 4 BYOK"       label
//   f18 = 200000                      max_tokens(交由 context-window-rewrite 改为配置值)
//   f22 = "MODEL_CLAUDE_4_OPUS_BYOK"  路由键, 代理靠它匹配 BYOK 槽位
//   f23 = <opaque 105B>               model_info, 内含 f4=context_window
//   f24 = 4                           访问途径门控; 193 样本证实: 有=可选, 无=Pro 灰显
const BYOK_ENTRY_TEMPLATES = {
  MODEL_CLAUDE_4_OPUS_BYOK:
    "ChJDbGF1ZGUgT3B1cyA0IEJZT0sSAwiVAigBMAFCLFJlZ2lzdGVyIHlvdXIgQW50aHJvcGljIEFQSSBrZXkgaW4gc2V0dGluZ3MuSAFQA2gDkAHAmgyyARhNT0RFTF9DTEFVREVfNF9PUFVTX0JZT0u6AWkIlQIYAiDAmgwqEkxMQU1BX1dJVEhfU1BFQ0lBTDIGQAFYAWABaID6AYoBGE1PREVMX0NMQVVERV80X09QVVNfQllPS5IBGmh0dHBzOi8vc2VydmVyLmNvZGVpdW0uY29tqgEFFQAAX0PAAQQ=",
  MODEL_CLAUDE_4_OPUS_THINKING_BYOK:
    "ChtDbGF1ZGUgT3B1cyA0IFRoaW5raW5nIEJZT0sSAwiWAigBMAFCLFJlZ2lzdGVyIHlvdXIgQW50aHJvcGljIEFQSSBrZXkgaW4gc2V0dGluZ3MuSAFQA2gDkAHAmgyyASFNT0RFTF9DTEFVREVfNF9PUFVTX1RISU5LSU5HX0JZT0u6AWwIlgIYAiDAmgwqEkxMQU1BX1dJVEhfU1BFQ0lBTDIIQAFYAWABeAFogPoBigEhTU9ERUxfQ0xBVURFXzRfT1BVU19USElOS0lOR19CWU9LkgEaaHR0cHM6Ly9zZXJ2ZXIuY29kZWl1bS5jb23AAQQ=",
  MODEL_CLAUDE_4_SONNET_BYOK:
    "ChRDbGF1ZGUgU29ubmV0IDQgQllPSxIDCJcCKAEwAVADaAOQAcCaDLIBGk1PREVMX0NMQVVERV80X1NPTk5FVF9CWU9LugFmCJcCGAIgwJoMKhJMTEFNQV9XSVRIX1NQRUNJQUwyCUABWAFgAagBAWiA9AOKARpNT0RFTF9DTEFVREVfNF9TT05ORVRfQllPS5IBGmh0dHBzOi8vc2VydmVyLmNvZGVpdW0uY29twAEE",
  MODEL_CLAUDE_4_SONNET_THINKING_BYOK:
    "Ch1DbGF1ZGUgU29ubmV0IDQgVGhpbmtpbmcgQllPSxIDCJgCKAEwAVADaAOQAcCaDLIBI01PREVMX0NMQVVERV80X1NPTk5FVF9USElOS0lOR19CWU9LugF5CJgCGAIgwJoMKhJMTEFNQV9XSVRIX1NQRUNJQUwyC0ABWAFgAXgBqAEBaID0A4oBI01PREVMX0NMQVVERV80X1NPTk5FVF9USElOS0lOR19CWU9LkgEaaHR0cHM6Ly9zZXJ2ZXIuY29kZWl1bS5jb22qAQUVAACqQsABBA==",
};

// 模块加载期自检: 解码并验证每条 payload 的 model_uid 与键名一致。
// 损坏者剔除, 绝不使代理崩溃。
const VERIFIED_ENTRIES = (() => {
  const out = [];
  for (const [uid, b64] of Object.entries(BYOK_ENTRY_TEMPLATES)) {
    try {
      const payload = Buffer.from(b64, "base64");
      if (readModelUid(payload) === uid) {
        out.push({ uid, payload });
      } else {
        console.error("[byok-inject] 模板 model_uid 不匹配, 已剔除: " + uid);
      }
    } catch (e) {
      console.error("[byok-inject] 模板解析失败, 已剔除: " + uid + " — " + e.message);
    }
  }
  return out;
})();

// ③ sorts 注入与 ① 模型数组注入共用的 label 单一来源:
// 从 VERIFIED_ENTRIES payload 的 f1(label) 解析, 保证 sorts.modelLabels 与数组条目 f1 逐字节一致。
export const BYOK_MODEL_LABELS = VERIFIED_ENTRIES.map((e) => {
  const parsed = parseWithRaw(e.payload);
  if (!parsed.ok) {
    return null;
  }
  for (const f of parsed.fields) {
    if (f.field === CMC_LABEL_FIELD && f.wireType === 2 && f.value) {
      return f.value.toString("utf8");
    }
  }
  return null;
}).filter(Boolean);

export function getVerifiedByokUids() {
  return VERIFIED_ENTRIES.map((e) => e.uid);
}

// 向 GetUserStatus 已解压 payload 补回服务端未下发的 BYOK 条目。
// 已存在的 uid 不重复追加 —— 服务端恢复下发后自动让路。
// 返回 { buffer, changed, count }; 任何异常退化为原样透传。
export function injectMissingByokEntries(decoded) {
  return transformModelArray(decoded, {
    appendEntries: (existingUids) =>
      VERIFIED_ENTRIES.filter((e) => !existingUids.has(e.uid)).map((e) => e.payload),
  });
}

const BYOK_GROUP_NAME = "BYOK";
const DEFAULT_SORT_NAME = "All";

function buildByokGroup() {
  return Buffer.concat([
    writeStringField(GROUP_NAME_FIELD, BYOK_GROUP_NAME),
    ...BYOK_MODEL_LABELS.map((l) => writeStringField(GROUP_LABELS_FIELD, l)),
  ]);
}

function buildByokSort() {
  return Buffer.concat([
    writeStringField(SORT_NAME_FIELD, DEFAULT_SORT_NAME),
    writeBytesField(SORT_GROUPS_FIELD, buildByokGroup()),
  ]);
}

function hasByokGroup(sortBuf) {
  const parsed = parseWithRaw(sortBuf);
  if (!parsed.ok) {
    return false;
  }
  for (const f of parsed.fields) {
    if (f.field === SORT_GROUPS_FIELD && f.wireType === 2) {
      const gp = parseWithRaw(f.value);
      if (!gp.ok) {
        continue;
      }
      for (const g of gp.fields) {
        if (g.field === GROUP_NAME_FIELD && g.wireType === 2 && g.value && g.value.toString("utf8") === BYOK_GROUP_NAME) {
          return true;
        }
      }
    }
  }
  return false;
}

function appendByokGroup(sortBuf) {
  const parsed = parseWithRaw(sortBuf);
  if (!parsed.ok) {
    return null;
  }
  return Buffer.concat([...parsed.fields.map((f) => f.raw), writeBytesField(SORT_GROUPS_FIELD, buildByokGroup())]);
}

// 向 GetUserStatus 已解压 payload 的 sorts 白名单补入 BYOK 分组。
// 两趟组合(handler 契约二选一, 无法单趟同时改写与追加; RPC 低频, 两趟代价可忽略):
//   趟1 appendSorts  无 name="All" 的 sort 时追加完整 {name:"All", groups:[BYOK组]}
//   趟2 mapSort      向 name="All" 的 sort 追加 groupName="BYOK" 组(已有则幂等跳过)
// 返回 { buffer, changed, count }; 任何异常退化为原样透传。
export function upsertByokSortGroup(decoded) {
  try {
    const pass1 = transformModelSorts(decoded, {
      appendSorts: (names) => (names.has(DEFAULT_SORT_NAME) ? [] : [buildByokSort()]),
    });
    const pass2 = transformModelSorts(pass1.buffer, {
      mapSort: (buf, name) => (name === DEFAULT_SORT_NAME && !hasByokGroup(buf) ? appendByokGroup(buf) : null),
    });
    return {
      buffer: pass2.buffer,
      changed: pass1.changed || pass2.changed,
      count: pass1.count + pass2.count,
    };
  } catch {
    return { buffer: decoded, changed: false, count: 0 };
  }
}