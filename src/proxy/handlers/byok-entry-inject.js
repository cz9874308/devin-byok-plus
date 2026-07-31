import { transformModelArray, readModelUid } from "./userstatus-shape.js";

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