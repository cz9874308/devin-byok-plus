// 异步写入队列。三档策略（spec 第 4 节）:
//   1. 普通事件 -> setImmediate 攒批, 合并为一次 appendAsync
//   2. high 事件 -> 立即调度 flush, 不等批量窗口
//   3. 退出路径 -> flushSync 用同步写兜干队列剩余内容
// 写操作串行化（单条 in-flight promise 链），避免并发 append 撕裂 JSONL 行。

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export function createLogQueue({
  appendAsync,
  appendSync,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const queue = [];
  let bytes = 0;
  let dropped = 0;
  let scheduled = false;
  let writing = false;

  // 背压: 超限时丢最旧的【普通】事件, high 一律保留。
  function applyBackpressure() {
    while (queue.length > maxLines || bytes > maxBytes) {
      const idx = queue.findIndex((e) => !e.high);
      if (idx === -1) {
        break; // 全是 high, 不丢
      }
      const [removed] = queue.splice(idx, 1);
      bytes -= removed.text.length;
      dropped++;
    }
  }

  function drainText() {
    if (queue.length === 0) {
      return "";
    }
    const lines = queue.map((e) => e.text);
    if (dropped > 0) {
      lines.push(JSON.stringify({ type: "log_dropped", ts: Date.now(), count: dropped }));
      dropped = 0;
    }
    queue.length = 0;
    bytes = 0;
    return lines.join("\n") + "\n";
  }

  function flushAsync() {
    scheduled = false;
    if (writing || queue.length === 0) {
      return;
    }
    const text = drainText();
    if (!text) {
      return;
    }
    writing = true;
    let p;
    try {
      p = appendAsync(text);
    } catch {
      writing = false;
      return;
    }
    Promise.resolve(p)
      .catch(() => {
        // IO 失败一律吞（spec 第 9 节）
      })
      .then(() => {
        writing = false;
        if (queue.length > 0) {
          schedule();
        }
      });
  }

  function schedule() {
    if (scheduled || writing) {
      return;
    }
    scheduled = true;
    setImmediate(flushAsync);
  }

  return {
    push(text, high = false) {
      try {
        if (typeof text !== "string" || text.length === 0) {
          return;
        }
        queue.push({ text, high: !!high });
        bytes += text.length;
        applyBackpressure();
        schedule();
      } catch {
        // 入队失败不影响业务
      }
    },
    // 退出路径同步兜干。此时进程即将结束, 阻塞几毫秒可接受。
    flushSync() {
      try {
        const text = drainText();
        if (!text) {
          return;
        }
        appendSync(text);
      } catch {
        // 尽力而为
      }
    },
    size() {
      return queue.length;
    },
    droppedCount() {
      return dropped;
    },
    peekAll() {
      return queue.map((e) => e.text);
    },
  };
}
