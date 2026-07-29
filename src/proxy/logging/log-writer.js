// 日志门面。对外只暴露 logEvent / logBlob（spec 3.4）。
// 不 import 任何业务模块，避免循环依赖（ws-bridge.js / chat.js 都要引它）。
import fs from "node:fs";
import path from "node:path";
import { getLogConfig } from "./log-config.js";
import {
  blobFileName,
  cleanupExpired,
  dailyFilePath,
  ensureLogDir,
  getBlobDir,
  getLogDir,
  rotateIfNeeded,
} from "./log-file.js";
import { createLogQueue } from "./log-queue.js";
import { Severity, severityOf } from "./anomaly.js";

const MAX_FIELD_CHARS = 2048;

// 字段白名单（spec 5.2 / 5.3）。理由不是保密，而是 schema 稳定、
// 文件小、避免对象上挂着 socket/stream 引用导致 stringify 抛错或写出噪音。
const ALLOWED_FIELDS = new Set([
  // 信封
  "ts",
  "pid",
  "proc",
  "type",
  "turnId",
  "target",
  // chat_turn
  "initiator",
  "route",
  "model",
  "byokSlot",
  "promptLen",
  "requestBytes",
  "toolsOffered",
  "toolChoice",
  "stopReason",
  "toolsCalled",
  "usage",
  "retryCount",
  "soundEligible",
  "durationMs",
  "anomalies",
  // anomaly
  "code",
  "severity",
  "detail",
  // lifecycle
  "event",
  "port",
  "exitCode",
  "message",
  // blob
  "kind",
  "file",
  "bytes",
  // log_dropped
  "count",
]);

function truncate(value) {
  const s = String(value);
  if (s.length <= MAX_FIELD_CHARS) {
    return s;
  }
  return s.slice(0, MAX_FIELD_CHARS) + "...truncated(" + s.length + ")";
}

// 只接受标量、字符串数组与浅层标量对象。
// 任何更复杂的结构（含循环引用）在此被降级或丢弃，保证 stringify 不抛错。
function sanitizeValue(value) {
  if (value == null) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncate(value);
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (item == null) {
        continue;
      }
      if (typeof item === "number" || typeof item === "boolean") {
        out.push(item);
      } else if (typeof item === "string") {
        out.push(truncate(item));
      }
      if (out.length >= 200) {
        break;
      }
    }
    return out;
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "number" || typeof v === "boolean") {
        out[k] = v;
      } else if (typeof v === "string") {
        out[k] = truncate(v);
      }
    }
    return out;
  }
  return truncate(String(value));
}

// 只保留白名单字段，逐字段截断。畸形值（循环引用等）在此被过滤掉。
function serialize(event, envelope) {
  const merged = { ...envelope };
  for (const [k, v] of Object.entries(event)) {
    if (!ALLOWED_FIELDS.has(k)) {
      continue;
    }
    if (k === "ts" || k === "pid" || k === "proc") {
      continue; // 信封字段不可被业务事件覆盖
    }
    const clean = sanitizeValue(v);
    if (clean === undefined) {
      continue;
    }
    merged[k] = clean;
  }
  return JSON.stringify(merged);
}

export function createLogWriter({ dir = getLogDir(), proc = "proxy", config = null } = {}) {
  const readConfig = () => (config ? { ...getLogConfig(), ...config } : getLogConfig());
  let dirReady = false;
  let warned = false;

  function warnOnce(message) {
    if (warned) {
      return;
    }
    warned = true;
    // 经 proxyManager.log() 出现在输出面板；仅一次，避免刷屏。
    console.log("  ⚠️  日志写入失败，后续不再告警: " + message);
  }

  function ensureReady(cfg) {
    if (dirReady) {
      return true;
    }
    if (!ensureLogDir(dir)) {
      warnOnce("无法创建日志目录 " + dir);
      return false;
    }
    dirReady = true;
    try {
      cleanupExpired(dir, cfg.logRetainDays);
    } catch {
      // 清理失败不影响写入
    }
    return true;
  }

  function targetPath(cfg) {
    const p = dailyFilePath(dir);
    rotateIfNeeded(p, cfg.logMaxMb);
    return p;
  }

  const queue = createLogQueue({
    appendAsync: (text) => {
      const cfg = readConfig();
      if (!ensureReady(cfg)) {
        return Promise.resolve();
      }
      return fs.promises.appendFile(targetPath(cfg), text, "utf8").catch((e) => {
        warnOnce(e && e.message ? e.message : String(e));
      });
    },
    appendSync: (text) => {
      const cfg = readConfig();
      if (!ensureReady(cfg)) {
        return;
      }
      try {
        fs.appendFileSync(targetPath(cfg), text, "utf8");
      } catch (e) {
        warnOnce(e && e.message ? e.message : String(e));
      }
    },
  });

  function logEvent(event) {
    try {
      const cfg = readConfig();
      if (!cfg.logEnabled) {
        return;
      }
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        return;
      }
      const envelope = { ts: Date.now(), pid: process.pid, proc };
      // anomaly 的 severity 一律由 code 表推导，调用方无需传入，
      // 避免同一 code 在不同调用点被标成不同等级。
      const normalized =
        event.type === "anomaly" && event.code
          ? { ...event, severity: severityOf(event.code) }
          : event;
      const line = serialize(normalized, envelope);
      const high =
        normalized.severity === Severity.HIGH || normalized.type === "lifecycle";
      queue.push(line, high);
    } catch {
      // 日志代码绝不打断业务（spec 第 9 节）
    }
  }

  // 第三参为 supplier：verbose 关闭时根本不调用，不构造大字符串。
  // 返回 Promise 仅供测试等待落盘；业务调用方无需 await。
  function logBlob(turnId, kind, supplier) {
    try {
      const cfg = readConfig();
      if (!cfg.logEnabled || !cfg.logVerbose) {
        return Promise.resolve();
      }
      if (typeof supplier !== "function") {
        return Promise.resolve();
      }
      if (!ensureReady(cfg)) {
        return Promise.resolve();
      }
      let content;
      try {
        content = supplier();
      } catch {
        return Promise.resolve(); // supplier 自身抛错不冒泡
      }
      if (content == null) {
        return Promise.resolve();
      }
      const text = typeof content === "string" ? content : String(content);
      const name = blobFileName(turnId, kind);
      const full = path.join(getBlobDir(dir), name);
      return fs.promises.writeFile(full, text, "utf8").then(
        () => {
          logEvent({
            type: "blob",
            turnId: String(turnId ?? ""),
            kind: String(kind ?? ""),
            file: path.join("blobs", name),
            bytes: text.length,
          });
        },
        (e) => warnOnce(e && e.message ? e.message : String(e))
      );
    } catch {
      return Promise.resolve();
    }
  }

  return {
    logEvent,
    logBlob,
    flushSync: () => queue.flushSync(),
  };
}

// 进程级单例 + 退出兜干（spec 第 4 节第 3 档）。
let _default = null;

export function initLogWriter(proc = "proxy") {
  if (_default) {
    return _default;
  }
  _default = createLogWriter({ proc });
  const flush = () => _default.flushSync();
  process.on("exit", flush);
  process.on("SIGINT", flush);
  process.on("SIGTERM", flush);
  // 只记录并兜干，不调用 process.exit、不阻止默认行为，
  // 保持 Node 原有崩溃语义（proxyManager 依赖退出码自动重启）。
  process.on("uncaughtException", (e) => {
    _default.logEvent({
      type: "lifecycle",
      event: "uncaughtException",
      message: e && e.message ? e.message : String(e),
    });
    flush();
  });
  process.on("unhandledRejection", (e) => {
    _default.logEvent({
      type: "lifecycle",
      event: "unhandledRejection",
      message: e && e.message ? e.message : String(e),
    });
    flush();
  });
  return _default;
}

export function logEvent(event) {
  return initLogWriter().logEvent(event);
}

export function logBlob(turnId, kind, supplier) {
  return initLogWriter().logBlob(turnId, kind, supplier);
}
