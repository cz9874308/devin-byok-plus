export const BYOK_SLOT_BY_REQUEST = {
  MODEL_CLAUDE_4_OPUS_BYOK: 1,
  MODEL_CLAUDE_4_OPUS_THINKING_BYOK: 2,
  MODEL_CLAUDE_4_SONNET_BYOK: 3,
  MODEL_CLAUDE_4_SONNET_THINKING_BYOK: 4
};

export function getByokSlot(requestedModel) {
  const id = String(requestedModel || "").trim();
  return BYOK_SLOT_BY_REQUEST[id] || null;
}

export function slotEnvPrefix(slot) {
  return "BYOK" + slot + "_";
}

export function slotField(slot, name) {
  return slotEnvPrefix(slot) + name;
}

export const SLOT_CONFIG_FIELDS = [
  "ANTHROPIC_API_HOST",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_PATH",
  "OPENAI_API_HOST",
  "OPENAI_API_KEY",
  "OPENAI_API_PATH",
  "OPENAI_SERVICE_TIER",
  "MODEL",
  "THINKING_EFFORT",
  "PROTOCOL",
  "CONTEXT_WINDOW"
];

// 可配置上下文窗口档位: 0=原始(不改写,保持官方值), 其余为改写目标值。
export const CONTEXT_WINDOW_PRESETS = {
  0: "原始",
  500000: "500K",
  1000000: "1M"
};

const CONTEXT_WINDOW_VALUES = new Set(Object.keys(CONTEXT_WINDOW_PRESETS).map(Number));

// 非法/未知档位一律归 0(原始, 不改写)。
export function sanitizeContextWindow(value) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  if (Number.isInteger(n) && CONTEXT_WINDOW_VALUES.has(n)) {
    return n;
  }
  return 0;
}

// 槽位 -> GetUserStatus 模型条目 field1 数值 ID 的映射。
// 用于结构化改写时把某个槽位的窗口档位定位到对应的模型条目。
// 四个 ID 均已抓包确认(GetUserStatus 模型数组):
//   277 = MODEL_CLAUDE_4_OPUS_BYOK          (槽位1 OPUS)
//   278 = MODEL_CLAUDE_4_OPUS_THINKING_BYOK (槽位2 OPUS_THINKING)
//   279 = MODEL_CLAUDE_4_SONNET_BYOK        (槽位3 SONNET)
//   280 = MODEL_CLAUDE_4_SONNET_THINKING_BYOK (槽位4 SONNET_THINKING)
export const SLOT_MODEL_ID = {
  1: 277,
  2: 278,
  3: 279,
  4: 280
};

const PROTOCOL_VALUES = ["", "anthropic", "openai", "gemini"];

export function sanitizeSlotProtocol(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return PROTOCOL_VALUES.includes(normalized) ? normalized : "";
}

export const THINKING_EFFORT_LEVELS = ["", "low", "medium", "high", "xhigh", "max"];
export const GEMINI_THINKING_LEVELS = ["", "minimal", "low", "medium", "high"];

export function sanitizeThinkingEffort(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return THINKING_EFFORT_LEVELS.includes(normalized) ? normalized : "";
}

export function sanitizeGeminiThinkingEffort(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const legacyMap = {
    xhigh: "high",
    max: "high"
  };
  const mapped = legacyMap[normalized] || normalized;
  return GEMINI_THINKING_LEVELS.includes(mapped) ? mapped : "";
}

function normalizeModelName(model) {
  return String(model || "").trim().toLowerCase().replace(/-thinking$/i, "");
}

export function detectModelProvider(model) {
  const normalized = normalizeModelName(model);
  if (!normalized) {
    return null;
  }
  if (/^gemini-|^model_google_gemini|^models\/gemini-/.test(normalized)) {
    return "gemini";
  }
  if (/^gpt-|^o[0-9][a-z0-9.-]*|^chatgpt-|^model_gpt/.test(normalized)) {
    return "gpt";
  }
  if (/^claude-|^model_claude/.test(normalized)) {
    return "claude";
  }
  return null;
}

export function supportsThinkingIntensity(provider, model) {
  if (!provider) {
    return false;
  }
  const normalized = normalizeModelName(model);
  if (provider === "claude" || provider === "gpt") {
    return !!normalized;
  }
  if (provider === "gemini") {
    return /gemini-/.test(normalized);
  }
  return false;
}

export function usesGeminiThinkingLevel(model) {
  const normalized = normalizeModelName(model);
  return /gemini-3[.]?5|^gemini-3(-|\.|$)|^gemini-3\.1|^gemini-3-flash/.test(normalized);
}

export function thinkingEffortToAnthropicBudget(effort) {
  const map = {
    low: 5000,
    medium: 10000,
    high: 20000,
    xhigh: 32000,
    max: 64000
  };
  return map[sanitizeThinkingEffort(effort)] || 0;
}

export function thinkingEffortToOpenAIReasoningEffort(effort) {
  const normalized = sanitizeThinkingEffort(effort);
  if (!normalized) {
    return "";
  }
  return normalized === "max" ? "xhigh" : normalized;
}

export function thinkingEffortToGeminiLevel(effort) {
  return sanitizeGeminiThinkingEffort(effort);
}

export function thinkingEffortToGeminiBudget(effort) {
  const level = sanitizeGeminiThinkingEffort(effort);
  const map = {
    minimal: 1024,
    low: 4096,
    medium: 8192,
    high: 24576
  };
  return map[level] || 0;
}

export function buildGeminiThinkingPayload(model, effort, fallbackEffort = "medium") {
  if (!supportsThinkingIntensity("gemini", model)) {
    return null;
  }
  const resolvedEffort = sanitizeGeminiThinkingEffort(effort) || sanitizeGeminiThinkingEffort(fallbackEffort);
  if (!resolvedEffort) {
    return null;
  }
  if (usesGeminiThinkingLevel(model)) {
    return {
      thinkingConfig: {
        thinkingLevel: resolvedEffort,
        thinking_level: resolvedEffort
      }
    };
  }
  const budget = thinkingEffortToGeminiBudget(resolvedEffort);
  if (!budget) {
    return null;
  }
  return {
    thinkingConfig: {
      thinkingBudget: budget,
      thinking_budget: budget
    }
  };
}

export function supportsAdaptiveClaudeThinking(model) {
  const normalized = String(model || "").trim().toLowerCase().replace(/-thinking$/i, "");
  return /claude-(?:[a-z0-9]+[-._])*(opus|sonnet)-4(?:[-._:]|$)|claude-mythos/.test(normalized);
}

export function buildAnthropicThinkingPayload(model, effort, fallbackEffort = "medium") {
  const resolvedEffort = sanitizeThinkingEffort(effort) || sanitizeThinkingEffort(fallbackEffort);
  if (!resolvedEffort) {
    return null;
  }
  if (supportsAdaptiveClaudeThinking(model)) {
    return {
      thinking: {
        type: "adaptive"
      },
      output_config: {
        effort: resolvedEffort
      }
    };
  }
  const budget = thinkingEffortToAnthropicBudget(resolvedEffort) || 10000;
  return {
    thinking: {
      type: "enabled",
      budget_tokens: budget
    }
  };
}
