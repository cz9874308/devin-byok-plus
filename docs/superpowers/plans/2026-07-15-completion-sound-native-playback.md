# 完成声音原生播放 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将完成声音播放从 webview `<audio>` 元素移到 Extension Host 进程，通过系统音频播放器绕过 Chromium auto-play 策略限制。

**Architecture:** 在 `sidebarProvider.js` 新增 `playNativeCompletionSound()` 方法，根据 `process.platform` 调用系统音频播放器（Windows: PowerShell MediaPlayer, macOS: afplay, Linux: ffplay/mpv）。修改 `onChatDone` 回调和 `playInteractionSound()` 改用此方法。webview 侧移除 `chatDone` 自动播放逻辑，保留试听按钮。

**Tech Stack:** Node.js `child_process.execFile`, PowerShell `System.Windows.Media.MediaPlayer`, macOS `afplay`

---

## File Structure

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/providers/sidebarProvider.js` | 修改 | 新增 `playNativeCompletionSound()`，修改 `onChatDone` 回调和 `playInteractionSound()` |
| `resources/webviews/sidebar.js` | 修改 | 移除 `chatDone` 自动播放逻辑 |

---

### Task 1: 新增 `playNativeCompletionSound()` 方法

**Files:**
- Modify: `src/providers/sidebarProvider.js:550-554`

- [ ] **Step 1: 在 `playInteractionSound()` 方法前新增 `playNativeCompletionSound()` 方法**

在 `src/providers/sidebarProvider.js` 的 `playInteractionSound()` 方法（第 550 行）前插入：

```javascript
  playNativeCompletionSound() {
    const soundPath = path.join(
      this.context.extensionPath,
      'resources',
      'sound',
      'completion.mp3'
    );
    if (!fs.existsSync(soundPath)) {
      return;
    }
    const platform = process.platform;
    try {
      if (platform === 'win32') {
        const fileUri = 'file:///' + soundPath.replace(/\\/g, '/');
        const psScript = [
          'Add-Type -AssemblyName presentationCore',
          '$p = New-Object System.Windows.Media.MediaPlayer',
          '$p.Open([Uri]"' + fileUri + '")',
          '$p.Play()',
          'Start-Sleep -Milliseconds 3000',
        ].join('; ');
        child_process_1.execFile(
          'powershell',
          ['-NoProfile', '-Command', psScript],
          { windowsHide: true },
          () => {}
        );
      } else if (platform === 'darwin') {
        child_process_1.execFile('afplay', [soundPath], () => {});
      } else {
        child_process_1.execFile(
          'ffplay',
          ['-nodisp', '-autoexit', '-loglevel', 'quiet', soundPath],
          (err) => {
            if (err) {
              child_process_1.execFile(
                'mpv',
                ['--no-video', '--really-quiet', soundPath],
                () => {}
              );
            }
          }
        );
      }
    } catch {}
  }
```

- [ ] **Step 2: 运行 node --check 验证语法**

Run: `node --check src/providers/sidebarProvider.js`
Expected: 无输出，exit code 0

- [ ] **Step 3: Commit**

使用 `/git-commit`

---

### Task 2: 修改 `onChatDone` 回调使用原生播放

**Files:**
- Modify: `src/providers/sidebarProvider.js:137-141`

- [ ] **Step 1: 修改 `onChatDone` 回调**

将第 137-141 行：

```javascript
    this.proxyManager.onChatDone((tmp03) => {
      if (this.getStoredCompletionSoundEnabled()) {
        this.view?.webview.postMessage({ type: 'chatDone', reason: tmp03?.reason || 'unknown' });
      }
    });
```

替换为：

```javascript
    this.proxyManager.onChatDone((tmp03) => {
      if (this.getStoredCompletionSoundEnabled()) {
        this.playNativeCompletionSound();
      }
    });
```

- [ ] **Step 2: 修改 `playInteractionSound()` 方法**

将第 550-553 行（Task 1 插入后行号会偏移）：

```javascript
  playInteractionSound() {
    if (this.getStoredCompletionSoundEnabled()) {
      this.view?.webview.postMessage({ type: 'playSound' });
    }
  }
```

替换为：

```javascript
  playInteractionSound() {
    if (this.getStoredCompletionSoundEnabled()) {
      this.playNativeCompletionSound();
    }
  }
```

- [ ] **Step 3: 运行 node --check 验证语法**

Run: `node --check src/providers/sidebarProvider.js`
Expected: 无输出，exit code 0

- [ ] **Step 4: Commit**

使用 `/git-commit`

---

### Task 3: 移除 webview 侧 `chatDone` 自动播放逻辑

**Files:**
- Modify: `resources/webviews/sidebar.js:1230-1232`

- [ ] **Step 1: 修改 `chatDone` 消息处理**

将第 1230-1231 行：

```javascript
    } else if (tmp12.type === "chatDone" || tmp12.type === "playSound") {
      fnPlayCompletionSound();
```

替换为（仅保留 `playSound` 用于试听按钮的兼容回退）：

```javascript
    } else if (tmp12.type === "playSound") {
      fnPlayCompletionSound();
```

- [ ] **Step 2: Commit**

使用 `/git-commit`

---

### Task 4: 同步到运行副本并验证

**Files:**
- Source: `src/providers/sidebarProvider.js`
- Target: `C:\Users\cz\.windsurf\extensions\jornlin.devin-byok-plus-2.4.2\src\providers\sidebarProvider.js`
- Source: `resources/webviews/sidebar.js`
- Target: `C:\Users\cz\.windsurf\extensions\jornlin.devin-byok-plus-2.4.2\resources\webviews\sidebar.js`

- [ ] **Step 1: 同步 sidebarProvider.js 到运行副本**

Run: `Copy-Item "src\providers\sidebarProvider.js" "C:\Users\cz\.windsurf\extensions\jornlin.devin-byok-plus-2.4.2\src\providers\sidebarProvider.js" -Force`

- [ ] **Step 2: 同步 sidebar.js 到运行副本**

Run: `Copy-Item "resources\webviews\sidebar.js" "C:\Users\cz\.windsurf\extensions\jornlin.devin-byok-plus-2.4.2\resources\webviews\sidebar.js" -Force`

- [ ] **Step 3: 用户重启 IDE 验证**

验证项：
1. 开关开启 → agent 完成任务 → 听到声音 ✅
2. 开关关闭 → agent 完成任务 → 不播放 ✅
3. 试听按钮 → 点击 → 听到声音 ✅
4. IDE 重启后（不点试听）→ agent 完成 → 听到声音 ✅

- [ ] **Step 4: 清理测试文件（如有残留）**

Run: `Remove-Item _test_sound.ps1, _test_sound_node.js -ErrorAction SilentlyContinue`

- [ ] **Step 5: Commit（如有验证后调整）**

使用 `/git-commit`
