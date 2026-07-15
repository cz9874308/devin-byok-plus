# 完成声音原生播放 — 修复 auto-play 策略拦截

## 问题

Agent 完成任务时不触发提示音。试听按钮（用户手势触发）正常，但 `chatDone` 回调触发的 `audio.play()` 被 Chromium auto-play 策略静默拦截。

### 根因

1. Webview `<audio>` 元素的 `play()` 在没有用户手势时被 Chromium 拒绝
2. `audio.play()` 返回的 rejected Promise 被 `catch(() => {})` 静默吞掉
3. Audio priming 仅在开关切换时执行，默认开启状态下不触发 `change` 事件，priming 永远不执行

### 触发链路（均正确，问题仅在最后一环）

```
emitChatEnd → __CHAT_DONE__ → proxyManager stdout capture
  → chatDoneCallback → sidebarProvider.onChatDone
    → webview.postMessage({type:'chatDone'})
      → sidebar.js fnPlayCompletionSound()
        → audio.play() → ❌ NotAllowedError (被静默吞掉)
```

## 方案

将声音播放从 webview 移到 Extension Host 进程（Node.js），通过 `child_process.execFile` 调用系统音频播放器，完全绕过 webview auto-play 限制。

### 技术验证

Windows 上 Node.js → PowerShell → `System.Windows.Media.MediaPlayer` 路径已实测通过（exit code 0，声音正常播放）。

## 架构

### 新播放流程

```
proxy __CHAT_DONE__ → proxyManager → sidebarProvider
  → playNativeCompletionSound()
    → child_process.execFile(系统音频播放器) → ✅ 正常播放
```

### 平台播放命令

| 平台 | 命令 | 格式 |
|------|------|------|
| Windows | `powershell -NoProfile -Command` + `System.Windows.Media.MediaPlayer` | MP3 |
| macOS | `afplay <path>` | MP3 |
| Linux | `ffplay -nodisp -autoexit <path>` 或 `mpv --no-video <path>` | MP3 |

### 性能

- 仅在 agent 完成时触发（几分钟至几十分钟一次），不是热路径
- PowerShell 启动约 100-200ms，`windowsHide: true` 不弹窗
- 进程播完 ~3 秒自动退出

## 改动范围

### 1. `src/providers/sidebarProvider.js`

- **新增** `playNativeCompletionSound()` 方法
  - 根据 `process.platform` 选择播放命令
  - 使用 `child_process.execFile` 异步调用，不阻塞扩展主线程
  - `windowsHide: true` 防止 Windows 弹出控制台窗口
  - 错误静默处理（播放失败不影响扩展功能）
- **修改** `resolveWebviewView` 中的 `onChatDone` 回调：调用 `playNativeCompletionSound()` 替代 `postMessage({type:'chatDone'})`
- **修改** `playInteractionSound()` 方法：改用 `playNativeCompletionSound()`
- **保留** `getStoredCompletionSoundEnabled()` 开关检查不变

### 2. `resources/webviews/sidebar.js`

- **移除** `chatDone` 消息类型的自动播放逻辑（不再需要）
- **保留** `playSound` 消息类型（供 `playInteractionSound` 兼容使用，移除或保留均可）
- **保留** `fnPlayCompletionSound()` 函数和 `<audio>` 元素（试听按钮继续使用）
- **保留** 开关 toggle 的 change 事件处理和 prime 逻辑

### 3. 不改动

- 代理侧代码（`completion-signal.js`, `ws-bridge.js`, `openai-stream.js`, `anthropic-stream.js`）— 触发链路正确
- `proxyManager.js` — `__CHAT_DONE__` 捕获逻辑正确
- 声音文件 `resources/sound/completion.mp3` — 直接复用

## 开关行为

| 开关状态 | 试听按钮 | Agent 完成 |
|----------|----------|------------|
| 开启 | webview audio.play() ✅ | playNativeCompletionSound() ✅ |
| 关闭 | 不播放 | 不播放（`getStoredCompletionSoundEnabled()` 拦截）|

## 附带 BUG（本次不修复，记录备查）

1. **Inference 进程 `__CHAT_DONE__` 丢失**：`proxyManager.js` 只监听 hybrid stdout，inference stdout 的 `__CHAT_DONE__` 被忽略
2. **Stream processor 错误路径漏调 `emitChatEnd`**：`OpenAIStreamProcessor._onDone()` 和 `ChatCompletionsStreamProcessor._onDone()` 在 `_errorMessage` 分支直接 return
