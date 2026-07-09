# Agent 执行完成声音提示 — 设计文档

- **日期**: 2026-07-09
- **分支**: `feat/completion-sound`
- **状态**: 设计中

## 背景与目标

Devin IDE 的 Cascade 原生完成通知仅为视觉提示（绿色对勾 toast），且仅在窗口失焦时触发。用户希望在 agent 完成任务或出错时，通过声音提醒第一时间知道结果，无论窗口是否聚焦。

**目标**：代理完成一轮任务（自然结束或出错）时，通过侧栏 webview 播放 `resources/sound/completion.mp3`，可在系统页开关控制，默认开启。

## 技术验证（已通过）

- VS Code webview 官方支持 mp3 格式（Wav/Mp3/Ogg/Flac）
- CSP 需添加 `media-src {{cspSource}}`
- 用户手势（点击试听/拨开关）可解锁 autoplay policy
- `retainContextWhenHidden: true` 可保活 webview，侧栏收起后仍能播放
- **已打包验证：webview `<audio>` + 试听按钮在 Devin 环境中成功播放 mp3**

## 关键设计决策

1. **触发时机**：整轮任务真正结束时（agent 交还控制）或出错时响，中间工具调用轮不响
2. **判断逻辑**：`emitChatEnd(stopReason, toolsCalled)` — `toolsCalled` 为空且非错 = 自然结束响；`stopReason === 'error'` = 出错也响；`toolsCalled` 非空 = 中间轮跳过
3. **播放方式**：HTML5 `<audio>` 标签，webview 内播放
4. **保活策略**：`retainContextWhenHidden: true`，侧栏收起后仍能播
5. **开关**：侧栏系统页加开关，默认开，状态持久化到 `globalState`
6. **事件传递**：代理子进程 stdout 标记 → 宿主 proxyManager 识别 → postMessage → webview 播放

## 架构与数据流

### 事件传递链路

```
代理子进程 (emitChatEnd)
   │  判断: toolsCalled 为空(正常结束) 或 stopReason=='error'
   │  → console.log('__CHAT_DONE__' + JSON.stringify({reason}))
   ▼
proxyManager (已在逐行读 hybridProcess.stdout :913)
   │  识别 __CHAT_DONE__ 前缀 → chatDoneCallback?.(payload)
   ▼
sidebarProvider (注册 onChatDone 回调)
   │  检查开关状态 → postMessage({type:'chatDone'})
   ▼
sidebar.js
   │  收到 chatDone → audio.play()
   ▼
🔊 completion.mp3
```

## 改动清单

### 1. 代理事件标记 — `src/proxy/ws-bridge.js` `emitChatEnd`

在现有 `broadcast()` 调用后追加：

```js
// 判断是否为"任务真正结束"或"出错"
if ((!arg1 || arg1.length === 0) || arg0 === 'error') {
  console.log('__CHAT_DONE__' + JSON.stringify({ reason: arg0 }));
}
```

### 2. 宿主捕获 — `src/managers/proxyManager.js`

- 新增 `chatDoneCallback` 属性 + `onChatDone(cb)` 注册方法
- stdout 监听逻辑里识别 `__CHAT_DONE__` 前缀行，解析后调用回调；该行不输出到日志面板

### 3. 侧栏注册回调 + 开关持久化 — `src/providers/sidebarProvider.js`

- 新增 globalState 键 `devin-byok-plus.completionSoundEnabled`（默认 `true`）
- `getStoredCompletionSoundEnabled()` / `setStoredCompletionSoundEnabled(v)` — 复用现有存取模式
- 初始化时注册 `proxyManager.onChatDone(() => { if (enabled && this.view) postMessage({type:'chatDone'}) })`
- `handleMessage` 加 `case 'setCompletionSound'` 写 globalState
- `getHtml()` 注入 `completionSoundUri`（已完成）+ 开关初始状态 `completionSoundEnabled`

### 4. webview 保活 — `src/providers/sidebarProvider.js` `resolveWebviewView`

webview options 补 `retainContextWhenHidden: true`

### 5. 系统页 UI — `src/views/templates/partials/system-tab.html`

基于已有的验证卡片扩展：加开关 toggle + 试听按钮（已完成试听部分）

### 6. webview 播放逻辑 — `resources/webviews/sidebar.js`

- 收到 `type:'chatDone'` 消息 → 检查本地开关状态 → `audio.currentTime=0; audio.play()`
- 开关 change → `fn5('setCompletionSound', {value})` + 本地 state 同步
- 开关拨到"开"时执行一次 audio priming（play+pause 归零），解锁后续自动播放

### 7. 模板数据 — `src/views/sidebarTemplate.js`

透传 `completionSoundUri`（已完成）+ `completionSoundEnabled`

## CSP 变更

```diff
- default-src 'none'; style-src ... img-src ... script-src ...
+ default-src 'none'; style-src ... img-src ... media-src {{cspSource}}; script-src ...
```

已完成。

## 判断逻辑详解

| stopReason | toolsCalled | 行为 |
|---|---|---|
| `end_turn` / `stop` / 其它正常值 | 空数组 `[]` | ✅ 响（任务结束）|
| `end_turn` / `stop` | 非空 `[...]` | ❌ 跳过（中间工具轮）|
| `error` | 任意 | ✅ 响（出错提醒）|

## 测试计划

### 单元测试

- `shouldPlayCompletionSound(stopReason, toolsCalled)` 纯函数，覆盖上表三种场景
- `__CHAT_DONE__` stdout 行解析

### 集成验证

- 跑一轮多工具任务 → 确认仅在最后一轮结束时响一声
- 制造一次错误（如无效 API Key）→ 确认出错也响
- 侧栏收起 → 确认仍能响（retainContextWhenHidden）
- 开关关闭 → 确认不响

## 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Autoplay policy 拦截 | 首次自动播放可能静默失败 | 开关拨开时 priming；试听按钮提供手势解锁 |
| webview 从未被打开过 | 无 webview 实例则无法播放 | 首次激活时侧栏会自动展开(activationEvent: onView) |
| stdout 行被截断 | `__CHAT_DONE__` 标记跨 chunk | 标记放在单行，Node stdout 按行 flush；解析时做容错 |
