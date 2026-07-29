// 日志文件路径、轮转判定与过期清理。
// 判定逻辑保持纯函数，便于单测不必真写满阈值。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE_PREFIX = "proxy-";
const FILE_EXT = ".jsonl";
const BLOB_DIR = "blobs";
const DAILY_RE = /^proxy-\d{4}-\d{2}-\d{2}(\.\d+)?\.jsonl$/;

export function getLogDir() {
  return path.join(os.homedir(), ".devin-byok-plus", "logs");
}

export function getBlobDir(dir = getLogDir()) {
  return path.join(dir, BLOB_DIR);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

export function dailyFileName(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  return FILE_PREFIX + y + "-" + m + "-" + d + FILE_EXT;
}

export function dailyFilePath(dir = getLogDir(), date = new Date()) {
  return path.join(dir, dailyFileName(date));
}

// 清洗 turnId / kind，防止路径穿越写到目录外。
function safeSegment(value) {
  const cleaned = String(value ?? "")
    .replace(/\.{2,}/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 120);
  return cleaned || "unknown";
}

export function blobFileName(turnId, kind) {
  return safeSegment(turnId) + "." + safeSegment(kind) + ".txt";
}

export function needsRotation(currentBytes, maxBytes) {
  return Number(currentBytes) > Number(maxBytes);
}

// 找到下一个可用的轮转序号路径: proxy-<date>.1.jsonl, .2.jsonl ...
export function nextRotationPath(basePath) {
  const dir = path.dirname(basePath);
  const stem = path.basename(basePath, FILE_EXT);
  for (let i = 1; i < 10000; i++) {
    const candidate = path.join(dir, stem + "." + i + FILE_EXT);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(dir, stem + "." + Date.now() + FILE_EXT);
}

export function isExpired(mtimeMs, retainDays, now = Date.now()) {
  return now - Number(mtimeMs) > Number(retainDays) * 86400000;
}

export function ensureLogDir(dir = getLogDir()) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, BLOB_DIR), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// 轮转当前文件（超阈值时改名）。返回是否发生轮转。
export function rotateIfNeeded(filePath, maxMb) {
  try {
    const st = fs.statSync(filePath);
    if (!needsRotation(st.size, Number(maxMb) * 1024 * 1024)) {
      return false;
    }
    fs.renameSync(filePath, nextRotationPath(filePath));
    return true;
  } catch {
    return false;
  }
}

// 启动时清理过期日志与 blob。只处理 proxy-*.jsonl 与 blobs/ 下文件，
// 绝不触碰目录里的其他文件。返回删除数量。
export function cleanupExpired(dir = getLogDir(), retainDays = 7, now = Date.now()) {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!DAILY_RE.test(name)) {
        continue;
      }
      const full = path.join(dir, name);
      try {
        if (isExpired(fs.statSync(full).mtimeMs, retainDays, now)) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch {
        // 单个文件失败不影响其余
      }
    }
  } catch {
    return removed;
  }
  try {
    const blobs = path.join(dir, BLOB_DIR);
    for (const name of fs.readdirSync(blobs)) {
      const full = path.join(blobs, name);
      try {
        if (isExpired(fs.statSync(full).mtimeMs, retainDays, now)) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch {
        // 忽略
      }
    }
  } catch {
    // blobs 目录可能不存在
  }
  return removed;
}
