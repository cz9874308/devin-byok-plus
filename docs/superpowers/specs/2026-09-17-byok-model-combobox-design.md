# BYOK 模型选择组合控件设计

**日期**: 2026-09-17
**状态**: 已确认，待实施

## 背景与问题

当前 BYOK 配置界面的模型选择使用纯 `<select>` 下拉控件（`config-tab.html` 中 `cfgByok1Model`~`cfgByok4Model`）。模型列表由"加载模型"按钮触发 `fetchModelsFromGateway` 拉取后填充到 select options。

**问题**：`<select>` 只能从列表选择，无法手动输入。部分上游站点不支持 `/models` 端点，加载模型必然失败，导致用户无法配置模型名称——即使用户已知模型名也无法填入。

## 目标

将 4 个 BYOK 槽位的模型选择从纯 `<select>` 改为组合控件（`<input list="...">` + `<datalist>`），使 input 始终可手动编辑，datalist 在加载成功后提供下拉建议。加载失败或站点不支持时，用户仍可手动输入模型名。

## 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 交互方式 | 组合控件（input + datalist） | 保留下拉能力同时允许手动输入，任何时候都可键入 |
| 加载失败表现 | 红色错误信息 + 空输入框（可手动输入） | 用户知晓失败原因且仍可配置 |
| 初始状态 | 始终可编辑，placeholder"输入或选择模型名" | 无需先加载即可输入 |
| 实现技术 | HTML5 原生 `<input list>` + `<datalist>` | 零依赖、Electron/Chromium 支持完美、代码量最小 |

## 架构

### 核心变更

4 个 BYOK 槽位的模型选择从 `<select>` 改为 `<input list="...">` + `<datalist>`。input 始终可编辑，datalist 提供下拉建议。"加载模型"按钮行为不变，仅填充目标从 select options 改为 datalist options。

### 不改动的部分

- 后端 `fetchModelsFromGateway`（`src/services/modelFetcher.js`）、`profileStore.js`、`sidebarProvider.js` 的 `fetchModels` 消息处理——模型值的读写仍是字符串，不受 UI 控件类型影响
- "加载模型"按钮行为不变
- 保存/持久化逻辑不变（`profile.byokN.model` 仍是字符串）

## 组件改动

### 1. `src/views/templates/partials/config-tab.html`（4 处，每处结构相同）

**现状**（以 BYOK #1 为例，`config-tab.html:42-45`）：
```html
<div class="row" style="gap:6px;margin-bottom:6px">
    <select id="cfgByok1Model" style="flex:1;font-size:12px;padding:5px 8px">{{byok1ModelOption}}</select>
    <button type="button" class="btn btn-s sm" data-ws-action="fetchModels" data-ws-slot="1" style="padding:4px 8px">加载模型</button>
</div>
```

**改为**：
```html
<div class="row" style="gap:6px;margin-bottom:6px">
    <input list="cfgByok1ModelList" id="cfgByok1Model" value="{{byok1ModelValue}}" placeholder="输入或选择模型名" style="flex:1;font-size:12px;padding:5px 8px" autocomplete="off">
    <datalist id="cfgByok1ModelList">{{byok1ModelOptions}}</datalist>
    <button type="button" class="btn btn-s sm" data-ws-action="fetchModels" data-ws-slot="1" style="padding:4px 8px">加载模型</button>
</div>
```

BYOK #2/#3/#4 同理，分别用 `cfgByok2ModelList`/`cfgByok3ModelList`/`cfgByok4ModelList`。

> 注：datalist 不自带下拉箭头，如需视觉提示可后续用 CSS 包装层补充，不阻塞功能。

### 2. `resources/webviews/sidebar.js`

#### `fn25`（`sidebar.js:526`）——渲染选项的核心函数

- 入参 `arg0` 从 `<select>` 变为 `<input>`，通过 `arg0.list`（`HTMLInputElement.list`）拿到关联的 datalist 元素
- 渲染目标从 `arg0.options`（`HTMLOptionsCollection`）改为 `arg0.list`（`HTMLDataListElement`）的子 `<option>`
- 去重逻辑不变；datalist 的 option 无 `selected` 概念，选中值靠 `input.value` 体现
- 空列表时不再渲染占位 option（input 本身有 placeholder），直接清空 datalist
- 选中值前置（当前值不在列表中时插入到首位）逻辑保留：将该值作为 datalist 第一个 option，同时 input.value 已持有该值

#### `fn32`（`sidebar.js:700`）/ `fn31`（`sidebar.js:678`）——加载结果处理

- 加载成功：填充 datalist options（经 `fn25`），input 保留当前 value
- 加载失败：清空 datalist（经 `fn25` 传空数组），`modelFetchStatusN` 显示红色错误信息，input 保留当前 value 仍可编辑
- 加载成功但空列表：清空 datalist，显示"未获取到模型列表"警告，input 仍可编辑

#### 读取模型值

`input.value` 与 `select.value` 同为 `.value` 属性，现有读取代码（如 `sidebar.js:1435` 的 `fn4("cfgByok1Model")?.value`）无需改动。

#### 事件监听

- `change` 事件（`sidebar.js:1124`）：对 `<input>` 仍有效，从下拉选择时触发，逻辑无需改
- `input` 事件（`sidebar.js:1144`）：已有监听且正则 `/cfgByok[1234]Model/` 匹配 input 元素 id，手动键入时触发，逻辑无需改

### 3. `src/views/sidebarTemplate.js`

#### 模板数据（`sidebarTemplate.js:140` 等 4 处）

**现状**：
```js
byok1ModelOption: tmp27 ? `<option value="${esc(tmp27)}" selected>${esc(tmp27)}</option>` : '<option value="" disabled selected>请先加载模型</option>',
```

**改为**：拆为两个模板变量：
```js
byok1ModelValue: esc(tmp27 || ''),           // input 的 value 属性
byok1ModelOptions: '',                        // datalist 初始为空（未加载时无下拉建议）
```

BYOK #2/#3/#4 同理（`tmp30`/`tmp33c`/`tmp33g`）。

## 数据流

### 手动输入

用户在 input 中键入 → `input.value` → 保存时 `fn4("cfgByok1Model").value` 读取 → 写入 `profile.byok1.model` 字符串。与现有保存逻辑一致。

### 加载模型

点"加载模型" → `fetchModels` 消息 → 后端 `fetchModelsFromGateway` → 返回 `modelList` 消息 → `fn32` → `fn25` 填充 datalist 的 `<option>` → 用户可从下拉选或继续手动输入。

### 回填已保存值

页面渲染时 `sidebarTemplate.js` 提供 `byok1ModelValue`（input 的 value 属性）= 已保存的模型名；datalist 初始为空，不影响 input 显示已存值。用户重新加载模型后 datalist 填充，已存值若在列表中则高亮匹配。

## 错误处理

| 场景 | modelFetchStatusN | datalist | input |
|------|-------------------|----------|-------|
| 加载失败（401/403/超时/不支持） | 红色"加载失败：..." | 清空 | 保留当前 value，可手动输入 |
| 加载成功但空列表 | 黄色"未获取到模型列表" | 清空 | 保留当前 value，可手动输入 |
| 加载成功有列表 | 绿色"已加载 N 个模型" | 填充 options | 保留当前 value，可下拉选 |
| 未加载 | 空 | 空 | placeholder"输入或选择模型名"，可直接输入 |

## 测试

### 现有用例适配

`test/` 中涉及 `sidebarTemplate` 的用例需适配：验证模板输出含 `byok1ModelValue` / `byok1ModelOptions` 而非 `byok1ModelOption`。

### 新增验证点

- input + datalist 正确渲染（input 的 `list` 属性指向 datalist id）
- 手动输入值能正确保存到 profile
- 加载失败后 datalist 为空但 input 仍可编辑
- 加载成功后 datalist 填充且 input 可下拉选

### 验收标准

零新增 lint warning / 零新增测试失败（存量基线：20 失败测试 + 64 lint warnings 为已知债务）。

## 影响范围

| 文件 | 改动类型 |
|------|----------|
| `src/views/templates/partials/config-tab.html` | 4 处 select→input+datalist |
| `resources/webviews/sidebar.js` | fn25/fn31/fn32 适配 datalist 渲染 |
| `src/views/sidebarTemplate.js` | 4 处模板数据拆分 |
| `test/`（涉及 sidebarTemplate 的用例） | 适配新模板变量名 |