# Agent 完成声音提示 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当代理完成任务（自然结束或出错）时，通过侧栏 webview 播放提示音，带开关控制。

**Architecture:** 代理子进程 `emitChatEnd` 时向 stdout 打标记 → 宿主 `proxyManager` 捕获并回调 → `sidebarProvider` 转发 `postMessage` → webview `<audio>.play()`。通过 `retainContextWhenHidden` 保活 webview，确保侧栏收起后仍可播放。

**Tech Stack:** VS Code WebviewView API, HTML5 Audio, globalState 持久化

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 创建 | `src/proxy/handlers/completion-signal.js` | 判断逻辑 `shouldSignalCompletion(stopReason, toolsCalled)` |
| 创建 | `test/unit/completion-signal.test.mjs` | 判断逻辑单元测试 |
| 修改 | `src/proxy/ws-bridge.js:214-222` | `emitChatEnd` 末尾追加 stdout 标记 |
| 修改 | `src/managers/proxyManager.js:913-924` | stdout 行识别 + 回调分发 |
| 修改 | `src/extension.js:35` | `registerWebviewViewProvider` 加 `retainContextWhenHidden` |
| 修改 | `src/providers/sidebarProvider.js` | globalState 存取 + 注册回调 + postMessage + handleMessage |
| 修改 | `src/views/sidebarTemplate.js` | 透传 `completionSoundEnabled` |
| 修改 | `src/views/templates/partials/system-tab.html` | 升级现有卡片：加开关 |
| 修改 | `resources/webviews/sidebar.js` | 收 `chatDone` 消息播放 + 开关交互 + priming |

---

### Task 1: 判断逻辑模块 + 测试

**Files:**
- Create: `src/proxy/handlers/completion-signal.js`
- Create: `test/unit/completion-signal.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/unit/completion-signal.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSignalCompletion } from '../../src/proxy/handlers/completion-signal.js';

describe('shouldSignalCompletion', () => {
  it('natural end with no tools → true', () => {
    assert.equal(shouldSignalCompletion('stop', []), true);
    assert.equal(shouldSignalCompletion('end_turn', []), true);
  });

  it('error → true', () => {
    assert.equal(shouldSignalCompletion('error', []), true);
  });

  it('openai tool round (toolsCalled non-empty) → false', () => {
    assert.equal(shouldSignalCompletion('stop', ['run_terminal']), false);
  });

  it('anthropic tool round (stopReason=tool_use) → false', () => {
    assert.equal(shouldSignalCompletion('tool_use', []), false);
  });

  it('tool_calls stopReason → false', () => {
    assert.equal(shouldSignalCompletion('tool_calls', ['foo']), false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/unit/completion-signal.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```js
// src/proxy/handlers/completion-signal.js

// 判断是否应发出"任务完成"信号。
// 返回 true = 自然结束或出错（应播放提示音）；false = 中间工具轮（跳过）。
//
// 判定规则：
//   1. toolsCalled 非空 → 中间工具轮（OpenAI 路径）→ false
//   2. stopReason 为 tool_use / tool_calls → 中间工具轮（Anthropic 路径）→ false
//   3. stopReason 为 error → 出错 → true
//   4. 其余情况（stop / end_turn / max_tokens 等）→ 自然结束 → true
export function shouldSignalCompletion(stopReason, toolsCalled) {
  if (Array.isArray(toolsCalled) && toolsCalled.length > 0) {
    return false;
  }
  const reason = String(stopReason || '').toLowerCase();
  if (reason === 'tool_use' || reason === 'tool_calls') {
    return false;
  }
  return true;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/unit/completion-signal.test.mjs`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/proxy/handlers/completion-signal.js test/unit/completion-signal.test.mjs
git commit -m "✅ v0.0.3 完成信号判断逻辑+单测"
```

---

### Task 2: 代理 stdout 标记

**Files:**
- Modify: `src/proxy/ws-bridge.js:214-222`

- [ ] **Step 1: 在 `emitChatEnd` 末尾追加 stdout 标记**

在 `src/proxy/ws-bridge.js` 的 `emitChatEnd` 函数里，`broadcast(...)` 之后追加：

```js
import { shouldSignalCompletion } from "./handlers/completion-signal.js";
```

（加在文件顶部 import 区）

然后在 `emitChatEnd` 函数体末尾追加：

```js
export function emitChatEnd(arg0, arg1, tmp2 = null) {
  broadcast({
    type: "chat_end",
    ts: Date.now(),
    targetId: monitorTarget(tmp2),
    stopReason: arg0,
    toolsCalled: arg1 || []
  });
  if (shouldSignalCompletion(arg0, arg1)) {
    console.log("__CHAT_DONE__" + JSON.stringify({ reason: arg0 || "unknown" }));
  }
}
```

- [ ] **Step 2: 语法校验**

Run: `node --check src/proxy/ws-bridge.js`
Expected: 无输出（无错误）

- [ ] **Step 3: 提交**

```bash
git add src/proxy/ws-bridge.js
git commit -m "🔊 v0.0.4 emitChatEnd 追加 stdout 完成标记"
```

---

### Task 3: 宿主捕获 stdout 标记

**Files:**
- Modify: `src/managers/proxyManager.js:913-924` (stdout 监听)
- Modify: `src/managers/proxyManager.js` (新增 `onChatDone` 方法)

- [ ] **Step 1: 在 constructor 里初始化回调**

在 `proxyManager.js` 的 constructor（约 :54-75）里，`this.logCallback = null;` 之后追加：

```js
    this.chatDoneCallback = null;
```

- [ ] **Step 2: 新增 `onChatDone` 注册方法**

在 `onLog(tmp0)` 方法（约 :237-238）之后追加：

```js
  onChatDone(tmp0) {
    this.chatDoneCallback = tmp0;
  }
```

- [ ] **Step 3: 修改 stdout 监听，识别 `__CHAT_DONE__` 标记**

在 `this.hybridProcess.stdout?.on("data", ...)` 回调（约 :913-924）里，现有行 `const tmp12 = arg0.toString().trim();` 之后、`if (tmp12)` 块内部，在 `this.log(tmp12)` 之前插入判断：

```js
    this.hybridProcess.stdout?.on("data", arg0 => {
      const tmp12 = arg0.toString().trim();
      if (tmp12) {
        if (tmp12.includes("⚡ Devin BYOK Bridge hybrid on http://127.0.0.1:" + tmp5) || tmp12.includes("⚡ Devin BYOK Bridge hybrid on http://localhost:" + tmp5)) {
          tmp6 = true;
          resolve(true);
        }
        // 完成信号标记：不输出到日志，直接触发回调
        if (tmp12.includes("__CHAT_DONE__")) {
          try {
            const tmp40 = tmp12.substring(tmp12.indexOf("__CHAT_DONE__") + 13);
            const tmp41 = JSON.parse(tmp40);
            this.chatDoneCallback?.(tmp41);
          } catch {}
          return;
        }
        this.log(tmp12);
      }
    });
```

注意：如果 stdout 里一次 data 事件可能包含多行（换行分割），现有代码只 `.trim()` 了一次。但观察现有模式，代理每条日志都是独立 `console.log`，Node 的 stdout 通常每行一个 data chunk，保持现有逻辑即可。如果一行里同时有正常日志和标记（极低概率），标记行被 `return` 不影响正常运行。

- [ ] **Step 4: 语法校验**

Run: `node --check src/managers/proxyManager.js`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add src/managers/proxyManager.js
git commit -m "🔊 v0.0.5 宿主捕获 __CHAT_DONE__ 标记"
```

---

### Task 4: sidebarProvider 转发 + globalState + retainContextWhenHidden

**Files:**
- Modify: `src/extension.js:35`
- Modify: `src/providers/sidebarProvider.js`

- [ ] **Step 1: extension.js 加 retainContextWhenHidden**

将 `extension.js:35`：

```js
    vscode.window.registerWebviewViewProvider('devin-byok-plus.sidebar', sidebar),
```

改为：

```js
    vscode.window.registerWebviewViewProvider('devin-byok-plus.sidebar', sidebar, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
```

- [ ] **Step 2: sidebarProvider 顶部加 globalState 键常量**

在 `KEY_LABEL_PATCH_TEXT` 常量（约 :67）之后追加：

```js
const KEY_COMPLETION_SOUND_ENABLED = 'devin-byok-plus.completionSoundEnabled';
```

- [ ] **Step 3: sidebarProvider 加存取方法**

在 `setStoredLabelPatchText` 方法（约 :533-535）之后追加：

```js
  getStoredCompletionSoundEnabled() {
    const tmp02 = this.context.globalState.get(KEY_COMPLETION_SOUND_ENABLED);
    return tmp02 !== false; // 默认 true
  }
  async setStoredCompletionSoundEnabled(tmp02) {
    await this.context.globalState.update(KEY_COMPLETION_SOUND_ENABLED, tmp02 === true);
  }
```

- [ ] **Step 4: sidebarProvider 注册 chatDone 回调**

在 `resolveWebviewView` 方法里，`tmp02.webview.onDidReceiveMessage(...)` 之后（约 :136），追加：

```js
    this.proxyManager.onChatDone((tmp03) => {
      if (this.getStoredCompletionSoundEnabled()) {
        this.view?.webview.postMessage({ type: 'chatDone', reason: tmp03?.reason || 'unknown' });
      }
    });
```

- [ ] **Step 5: handleMessage 加 'setCompletionSound' case**

在 `handleMessage` 的 switch/if 链里（找到 `case 'setAutoStartProxy':` 约 :1685），在其之后追加：

```js
      case 'setCompletionSound': {
        await this.setStoredCompletionSoundEnabled(tmp02.value === true);
        break;
      }
```

- [ ] **Step 6: getHtml() 透传 completionSoundEnabled**

在 `getHtml()` 里调用 `renderSidebarHtml({...})` 的参数对象中，已有 `completionSoundUri`，在其之后追加：

```js
      completionSoundEnabled: this.getStoredCompletionSoundEnabled(),
```

- [ ] **Step 7: sidebarTemplate.js 透传到 templateData**

在 `sidebarTemplate.js` 的 `templateData` 对象里，已有 `completionSoundUri`，在其之后追加：

```js
    completionSoundEnabled: ctx.completionSoundEnabled !== false,
```

- [ ] **Step 8: 语法校验**

Run: `node --check src/extension.js && node --check src/providers/sidebarProvider.js && node --check src/views/sidebarTemplate.js`
Expected: 全部无错误

- [ ] **Step 9: 提交**

```bash
git add src/extension.js src/providers/sidebarProvider.js src/views/sidebarTemplate.js
git commit -m "🔊 v0.0.6 宿主转发+globalState+retainContextWhenHidden"
```

---

### Task 5: UI 开关 + webview 播放逻辑

**Files:**
- Modify: `src/views/templates/partials/system-tab.html`
- Modify: `resources/webviews/sidebar.js`

- [ ] **Step 1: 升级 system-tab.html 的完成声音卡片**

将现有的「完成声音提示（最小验证）」卡片替换为带开关的完整版：

```html
<!-- 完成声音提示 -->
<div class="card" style="margin-bottom:12px">
    <div class="card-head between">
        <span>完成声音提示</span>
        <label class="tog"><input type="checkbox" id="cfgCompletionSound" {{completionSoundChecked}}><span></span></label>
    </div>
    <audio id="completionSound" src="{{completionSoundUri}}" preload="auto"></audio>
    <div id="completionSoundTestResult" class="patch-path" style="font-size:10px">Agent 任务完成或出错时播放提示音</div>
    <div class="btns">
        <button type="button" class="btn btn-s sm" data-ws-action="testCompletionSound">试听</button>
    </div>
</div>
```

- [ ] **Step 2: sidebarTemplate.js 加 completionSoundChecked**

在 `templateData` 里加（紧跟 `completionSoundEnabled` 之后）：

```js
    completionSoundChecked: ctx.completionSoundEnabled !== false ? 'checked' : '',
```

- [ ] **Step 3: sidebar.js 加开关交互**

在 sidebar.js 初始化阶段（文件顶部 IIFE 内、`tmp0 = acquireVsCodeApi()` 之后合适位置），追加开关监听：

```js
  // 完成声音开关
  const tmp_csToggle = fn4("cfgCompletionSound");
  if (tmp_csToggle) {
    tmp_csToggle.addEventListener("change", () => {
      const tmp_enabled = tmp_csToggle.checked;
      fn5("setCompletionSound", { value: tmp_enabled });
      // 开关打开时做一次静默 prime（解锁自动播放）
      if (tmp_enabled) {
        const tmp_audio = fn4("completionSound");
        if (tmp_audio) {
          try {
            tmp_audio.volume = 0;
            tmp_audio.currentTime = 0;
            const tmp_p = tmp_audio.play();
            if (tmp_p && typeof tmp_p.then === "function") {
              tmp_p.then(() => { tmp_audio.pause(); tmp_audio.currentTime = 0; tmp_audio.volume = 1; })
                   .catch(() => { tmp_audio.volume = 1; });
            } else {
              tmp_audio.pause(); tmp_audio.currentTime = 0; tmp_audio.volume = 1;
            }
          } catch { tmp_audio.volume = 1; }
        }
      }
    });
  }
```

- [ ] **Step 4: sidebar.js 处理 `chatDone` 消息**

在消息监听里（`window.addEventListener("message", ...)`），已有 `if (tmp12.type === "status")` 等分支，在最后追加：

```js
    } else if (tmp12.type === "chatDone") {
      const tmp_audio = fn4("completionSound");
      const tmp_toggle = fn4("cfgCompletionSound");
      if (tmp_audio && tmp_toggle && tmp_toggle.checked) {
        try {
          tmp_audio.currentTime = 0;
          tmp_audio.play().catch(() => {});
        } catch {}
      }
    }
```

- [ ] **Step 5: 语法校验**

Run: `node --check src/views/sidebarTemplate.js`
Expected: 无错误

（sidebar.js 是浏览器脚本，用 node --check 无法完整校验 `acquireVsCodeApi`，但可检查基本语法）

Run: `node -e "require('fs').readFileSync('resources/webviews/sidebar.js','utf8')" `
Expected: 无报错（只读取，验证文件可正常读取无乱码）

- [ ] **Step 6: 提交**

```bash
git add src/views/templates/partials/system-tab.html src/views/sidebarTemplate.js resources/webviews/sidebar.js
git commit -m "🔊 v0.0.7 UI 开关+webview 播放+priming"
```

---

### Task 6: 集成验证 + 最终提交

- [ ] **Step 1: 运行全部单元测试**

Run: `node --test test/unit/completion-signal.test.mjs`
Expected: PASS

- [ ] **Step 2: 全量语法检查**

Run: `node --check src/proxy/ws-bridge.js && node --check src/proxy/handlers/completion-signal.js && node --check src/managers/proxyManager.js && node --check src/extension.js && node --check src/providers/sidebarProvider.js && node --check src/views/sidebarTemplate.js`
Expected: 全部无错误

- [ ] **Step 3: 打包验证**

Run: `npm run package`
Expected: 成功生成 vsix，`resources/sound/completion.mp3` 包含在内

- [ ] **Step 4: 手动验证清单（打包后安装到 Devin）**

1. 安装新 vsix → 重启 Devin
2. 打开侧栏 → 🔧 系统补丁 → 确认「完成声音提示」卡片有开关（默认开）
3. 点「试听」→ 确认出声
4. 启动代理 → 发一条消息给 agent → 等 agent 完成 → 确认提示音响起
5. 制造一次错误(如 API Key 填错) → 确认出错时也响
6. 关闭开关 → 再发一条消息 → 确认不响
7. 收起侧栏 → 发一条消息 → 确认侧栏收起后仍然响（retainContextWhenHidden 验证）

- [ ] **Step 5: 如果验证通过，做最终提交/tag**

```bash
git add -A
git commit -m "🔊 v0.0.8 完成声音提示功能完整实现"
```

---

### Task 7: 弹窗交互声音提示

**Goal:** 当插件弹出需要用户选择的对话框时，同时播放提示音提醒用户。

**Files:**
- Modify: `src/providers/sidebarProvider.js` (7 处弹窗前加 postMessage)
- Modify: `src/extension.js:56` (1 处弹窗前加 postMessage)
- Modify: `resources/webviews/sidebar.js` (收 `playSound` 消息)

**原理:** 复用已有的 `<audio id="completionSound">` 和开关状态。在每个带按钮的 `showInformationMessage` 调用前，通过 `postMessage({type:'playSound'})` 通知 webview 播放声音。webview 侧统一响应 `playSound` 和 `chatDone` 两种消息类型，共享同一个播放逻辑。

- [ ] **Step 1: sidebar.js 增加 `playSound` 消息处理**

在 sidebar.js 消息监听中，已有 `chatDone` 播放逻辑旁增加 `playSound` 分支，复用同一个播放函数：

```js
// 在消息监听的 chatDone 处理后面加:
} else if (tmp12.type === "playSound") {
  fnPlayCompletionSound();
}
```

其中 `fnPlayCompletionSound` 是 Task 5 中已实现的播放函数（检查开关 → play）。

- [ ] **Step 2: sidebarProvider.js 添加 helper 方法**

在 SidebarProvider 类中添加：

```js
playInteractionSound() {
  this.view?.webview.postMessage({ type: 'playSound' });
}
```

- [ ] **Step 3: sidebarProvider.js 7 处弹窗前加声音**

在以下每处 `showInformationMessage` 调用**之前**加 `this.playInteractionSound();`：

1. `:997` — `ensurePatchAppliedAfterProxyStart` 中 "重载窗口"
2. `:1271` — 配置更新后 "立即重启"/"稍后手动重启"
3. `:1939` — `applyPatch` case "重载窗口"
4. `:1983` — `revertPatch` case "重载窗口"
5. `:2011` — `applyLabelPatch` case "重载窗口"
6. `:2032` — `revertLabelPatch` case "重载窗口"

以及纯通知但重要的弹窗（可选，由实现者判断是否跳过无按钮的）。

- [ ] **Step 4: extension.js 1 处弹窗前加声音**

`:56` 处 `showInformationMessage('已应用...补丁', '重启 Devin')` 前加：

```js
sidebar.playInteractionSound();
```

注意：`sidebar` 变量在 extension.js 中已定义为 `SidebarProvider` 实例。

- [ ] **Step 5: 语法检查**

Run: `node --check src/providers/sidebarProvider.js && node --check src/extension.js`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add src/providers/sidebarProvider.js src/extension.js resources/webviews/sidebar.js
git commit -m "🔊 v0.0.9 弹窗交互声音提示"
```
