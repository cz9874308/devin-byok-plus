// 日志配置。env 解析 + 运行态热更新入口。
// 依赖方向（强制）: models.js -> logging/*，反向禁止。
// 因此热更新由 models.js 的 setRuntimeConfig 主动调用 configureLog 推入。

const DEFAULTS = Object.freeze({
  logEnabled: true,
  logVerbose: false,
  logMaxMb: 10,
  logRetainDays: 7,
});

const MAX_MB_LIMIT = 1024;
const RETAIN_DAYS_LIMIT = 365;

function toBool(value, fallback) {
  if (value === true || value === false) {
    return value;
  }
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  if (s === "true") {
    return true;
  }
  if (s === "false") {
    return false;
  }
  return fallback;
}

function toInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(n) || n < min) {
    return fallback;
  }
  return Math.min(n, max);
}

export function readLogConfigFromEnv(env = process.env) {
  const src = env && typeof env === "object" ? env : {};
  return {
    logEnabled: toBool(src.LOG_ENABLED, DEFAULTS.logEnabled),
    logVerbose: toBool(src.LOG_VERBOSE, DEFAULTS.logVerbose),
    logMaxMb: toInt(src.LOG_MAX_MB, DEFAULTS.logMaxMb, 1, MAX_MB_LIMIT),
    logRetainDays: toInt(src.LOG_RETAIN_DAYS, DEFAULTS.logRetainDays, 1, RETAIN_DAYS_LIMIT),
  };
}

let _config = readLogConfigFromEnv();

export function getLogConfig() {
  return { ..._config };
}

// 热更新。接受 UPPER_CASE（env / .env patch）与 camelCase（运行态）两种键名。
// 只覆盖传入的键；任何异常一律吞掉，绝不打断调用方（models.js 的配置流程）。
export function configureLog(patch) {
  try {
    if (!patch || typeof patch !== "object") {
      return getLogConfig();
    }
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
    const next = { ..._config };
    if (has("LOG_ENABLED")) {
      next.logEnabled = toBool(patch.LOG_ENABLED, next.logEnabled);
    }
    if (has("logEnabled")) {
      next.logEnabled = toBool(patch.logEnabled, next.logEnabled);
    }
    if (has("LOG_VERBOSE")) {
      next.logVerbose = toBool(patch.LOG_VERBOSE, next.logVerbose);
    }
    if (has("logVerbose")) {
      next.logVerbose = toBool(patch.logVerbose, next.logVerbose);
    }
    if (has("LOG_MAX_MB")) {
      next.logMaxMb = toInt(patch.LOG_MAX_MB, next.logMaxMb, 1, MAX_MB_LIMIT);
    }
    if (has("logMaxMb")) {
      next.logMaxMb = toInt(patch.logMaxMb, next.logMaxMb, 1, MAX_MB_LIMIT);
    }
    if (has("LOG_RETAIN_DAYS")) {
      next.logRetainDays = toInt(patch.LOG_RETAIN_DAYS, next.logRetainDays, 1, RETAIN_DAYS_LIMIT);
    }
    if (has("logRetainDays")) {
      next.logRetainDays = toInt(patch.logRetainDays, next.logRetainDays, 1, RETAIN_DAYS_LIMIT);
    }
    _config = next;
  } catch {
    // 配置热更新失败不影响运行，保持旧配置
  }
  return getLogConfig();
}
