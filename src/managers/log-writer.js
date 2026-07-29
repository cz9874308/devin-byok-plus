// 扩展侧日志写入器（CommonJS）。
// 与代理侧 src/proxy/logging/log-writer.js 职责相同但独立实现：
// 扩展侧是 CJS（package.json 无 type:module），无法 import ESM 模块。
// 扩展侧事件量极小（启停、退出码、端口回退、热更新），直接异步 append 即可，无需队列。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_FIELD_CHARS = 2048;

function logDir() {
  return path.join(os.homedir(), '.devin-byok-plus', 'logs');
}

function dailyPath() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name =
    'proxy-' +
    d.getUTCFullYear() +
    '-' +
    pad(d.getUTCMonth() + 1) +
    '-' +
    pad(d.getUTCDate()) +
    '.jsonl';
  return path.join(logDir(), name);
}

function truncate(value) {
  const s = String(value);
  return s.length <= MAX_FIELD_CHARS
    ? s
    : s.slice(0, MAX_FIELD_CHARS) + '...truncated(' + s.length + ')';
}

let warned = false;

// 与代理侧一致：日志失败只提示一次，绝不打断扩展逻辑。
function logExtEvent(event) {
  try {
    if (!event || typeof event !== 'object') {
      return;
    }
    const line = {
      ts: Date.now(),
      pid: process.pid,
      proc: 'ext',
      type: 'lifecycle',
    };
    for (const [k, v] of Object.entries(event)) {
      if (typeof v === 'number' || typeof v === 'boolean') {
        line[k] = v;
      } else if (v != null) {
        line[k] = truncate(v);
      }
    }
    fs.mkdirSync(logDir(), { recursive: true });
    fs.appendFile(dailyPath(), JSON.stringify(line) + '\n', 'utf-8', (err) => {
      if (err && !warned) {
        warned = true;
        console.log('[Devin BYOK Bridge] 日志写入失败: ' + err.message);
      }
    });
  } catch {
    // 日志绝不打断扩展逻辑
  }
}

module.exports = { logExtEvent, logDir };
