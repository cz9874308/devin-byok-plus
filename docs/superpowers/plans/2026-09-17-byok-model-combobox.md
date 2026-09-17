# BYOK 模型选择组合控件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 4 个 BYOK 槽位的模型选择从纯 `<select>` 改为 `<input list>` + `<datalist>` 组合控件，使模型名始终可手动编辑，加载失败/站点不支持时仍可配置。

**Architecture:** 模板层将 `<select>` 替换为 `<input list="cfgByokNModelList">` + `<datalist id="cfgByokNModelList">`；前端 `fn25` 渲染目标从 `select.options` 改为 `input.list`（HTMLDataListElement）；后端/保存逻辑不变（模型值仍是字符串）。

**Tech Stack:** Node.js, VSCode Extension Webview (HTML/JS), `node --test` 测试框架

## Global Constraints

- 模型值读写仍是字符串，后端 `fetchModelsFromGateway` / `profileStore.js` / `sidebarProvider.js` 不改
- 4 个 BYOK 槽位（#1~#4）统一改造，结构完全对称
- 现有 DOM id `cfgByok1Model`~`cfgByok4Model` 保留（从 select id 变为 input id），不破坏现有事件监听与值读取代码
- 新增 datalist id 命名：`cfgByok1ModelList`~`cfgByok4ModelList`，不得与现有任何 DOM id 冲突
- 验收标准：零新增 lint warning / 零新增测试失败（存量基线：20 失败测试 + 64 lint warnings 为已知债务）
- 开发前先创建功能分支

---

## File Structure

| 文件 | 职责 | 改动类型 |
|------|------|----------|
| `src/views/sidebarTemplate.js` | 模板数据准备：为 4 个槽位提供 input value + datalist options | Modify（4 处模板变量拆分） |
| `src/views/templates/partials/config-tab.html` | BYOK 配置卡片 HTML 结构 | Modify（4 处 select→input+datalist） |
| `resources/webviews/sidebar.js` | 前端渲染逻辑：`fn25` 渲染模型选项到 datalist | Modify（fn25 内部适配） |
| `test/unit/sidebarTemplate.test.mjs` | 模板渲染单元测试 | Modify（新增 datalist 断言） |

---

### Task 0: 创建功能分支

**Files:**
- 无文件改动

**Interfaces:**
- Consumes: 无
- Produces: `feat/byok-model-combobox` 分支

- [ ] **Step 1: 从当前分支创建功能分支**

```bash
git checkout -b feat/byok-model-combobox
```

- [ ] **Step 2: 确认分支已切换**

Run: `git branch --show-current`
Expected: `feat/byok-model-combobox`

---

### Task 1: 模板层改造 — sidebarTemplate.js + config-tab.html + 测试

**Files:**
- Modify: `src/views/sidebarTemplate.js:140` (byok1ModelOption → byok1ModelValue + byok1ModelOptions)
- Modify: `src/views/sidebarTemplate.js:159` (byok2ModelOption → byok2ModelValue + byok2ModelOptions)
- Modify: `src/views/sidebarTemplate.js:178` (byok3ModelOption → byok3ModelValue + byok3ModelOptions)
- Modify: `src/views/sidebarTemplate.js:197` (byok4ModelOption → byok4ModelValue + byok4ModelOptions)
- Modify: `src/views/templates/partials/config-tab.html:42-45` (BYOK #1 select→input+datalist)
- Modify: `src/views/templates/partials/config-tab.html:67-70` (BYOK #2)
- Modify: `src/views/templates/partials/config-tab.html:92-95` (BYOK #3)
- Modify: `src/views/templates/partials/config-tab.html:117-120` (BYOK #4)
- Test: `test/unit/sidebarTemplate.test.mjs`

**Interfaces:**
- Consumes: `tmp27`/`tmp30`/`tmp33c`/`tmp33g`（已保存的模型名，来自 ctx）
- Produces: 模板变量 `byok1ModelValue`/`byok1ModelOptions`（及 #2~#4 同构），供 config-tab.html 的 `{{byokNModelValue}}` / `{{byokNModelOptions}}` 占位符使用

- [ ] **Step 1: 写失败测试 — 验证 input + datalist 渲染**

在 `test/unit/sidebarTemplate.test.mjs` 的 `DOM id 完整性` test 块内，`应该包含所有关键 DOM id` 子测试之后新增一个子测试。在 line 204（`});` 闭合 `应该包含所有关键 DOM id` 之后、`不应该有重复的 id` 之前）插入：

```js
  await t.test('应该将模型选择渲染为 input + datalist 组合控件', () => {
    const html = renderSidebarHtml(mockContext);
    // 4 个槽位都应有 input[list] + datalist
    for (const n of [1, 2, 3, 4]) {
      assert.ok(html.includes(`id="cfgByok${n}Model"`), `应包含 cfgByok${n}Model input`);
      assert.ok(html.includes(`list="cfgByok${n}ModelList"`), `input 应关联 datalist cfgByok${n}ModelList`);
      assert.ok(html.includes(`id="cfgByok${n}ModelList"`), `应包含 datalist cfgByok${n}ModelList`);
    }
    // 不应再有 select#cfgByokNModel（旧控件）
    assert.ok(!html.includes('<select id="cfgByok1Model"'), '不应再使用 select 作为模型选择');
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/unit/sidebarTemplate.test.mjs`
Expected: 新增的 `应该将模型选择渲染为 input + datalist 组合控件` 测试 FAIL（因为当前仍是 `<select>`，不含 `list="cfgByok1ModelList"`）

- [ ] **Step 3: 改 sidebarTemplate.js — 4 处模板变量拆分**

将 `src/views/sidebarTemplate.js:140`：
```js
    byok1ModelOption: tmp27 ? `<option value="${esc(tmp27)}" selected>${esc(tmp27)}</option>` : '<option value="" disabled selected>请先加载模型</option>',
```
改为：
```js
    byok1ModelValue: esc(tmp27 || ''),
    byok1ModelOptions: '',
```

将 `src/views/sidebarTemplate.js:159`：
```js
    byok2ModelOption: tmp30 ? `<option value="${esc(tmp30)}" selected>${esc(tmp30)}</option>` : '<option value="" disabled selected>请先加载模型</option>',
```
改为：
```js
    byok2ModelValue: esc(tmp30 || ''),
    byok2ModelOptions: '',
```

将 `src/views/sidebarTemplate.js:178`：
```js
    byok3ModelOption: tmp33c ? `<option value="${esc(tmp33c)}" selected>${esc(tmp33c)}</option>` : '<option value="" disabled selected>请先加载模型</option>',
```
改为：
```js
    byok3ModelValue: esc(tmp33c || ''),
    byok3ModelOptions: '',
```

将 `src/views/sidebarTemplate.js:197`：
```js
    byok4ModelOption: tmp33g ? `<option value="${esc(tmp33g)}" selected>${esc(tmp33g)}</option>` : '<option value="" disabled selected>请先加载模型</option>',
```
改为：
```js
    byok4ModelValue: esc(tmp33g || ''),
    byok4ModelOptions: '',
```

- [ ] **Step 4: 改 config-tab.html — BYOK #1 select→input+datalist**

将 `src/views/templates/partials/config-tab.html:42-45`：
```html
            <div class="row" style="gap:6px;margin-bottom:6px">
                <select id="cfgByok1Model" style="flex:1;font-size:12px;padding:5px 8px">{{byok1ModelOption}}</select>
                <button type="button" class="btn btn-s sm" data-ws-action="fetchModels" data-ws-slot="1" style="padding:4px 8px">加载模型</button>
            </div>
```
改为：
```html
            <div class="row" style="gap:6px;margin-bottom:6px">
                <input list="cfgByok1ModelList" id="cfgByok1Model" value="{{byok1ModelValue}}" placeholder="输入或选择模型名" style="flex:1;font-size:12px;padding:5px 8px" autocomplete="off">
                <datalist id="cfgByok1ModelList">{{byok1ModelOptions}}</datalist>
                <button type="button" class="btn btn-s sm" data-ws-action="fetchModels" data-ws-slot="1" style="padding:4px 8px">加载模型</button>
            </div>
```

- [ ] **Step 5: 改 config-tab.html — BYOK #2 select→input+datalist**

将 `src/views/templates/partials/config-tab.html:67-70`：
```html
            <div class="row" style="gap:6px;margin-bottom:6px">
                <select id="cfgByok2Model" style="flex:1;font-size:12px;padding:5px 8px">{{byok2ModelOption}}</select>
                <button type="button" class="btn btn-s sm" data-ws-action="fetchModels" data-ws-slot="2" style="padding:4px 8px">加载模型</button>
            </div>
```
改为：
```html
            <div class="row" style="gap:6px;margin-bottom:6px">
                <input list="cfgByok2ModelList" id="cfgByok2Model" value="{{byok2ModelValue}}" placeholder="输入或选择模型名" style="flex:1;font-size:12px;padding:5px 8px" autocomplete="off">
                <datalist id="cfgByok2ModelList">{{byok2ModelOptions}}</datalist>
                <button type="button" class="btn btn-s sm" data-ws-action="fetchModels" data-ws-slot="2" style="padding:4px 8px">加载模型</button>
            </div>
```

- [ ] **Step 6: 改 config-tab.html — BYOK #3 select→input+datalist**

将 `src/views/templates/partials/config-tab.html:92-95`：
```html
            <div class="row" style="gap:6px;margin-bottom:6px">
                <select id="cfgByok3Model" style="flex:1;font-size:12px;padding:5px 8px">{{byok3ModelOption}}</select>
                <button type="button" class="btn btn-s sm" data-ws-action="fetchModels" data-ws-slot="3" style="padding:4px 8px">加载模型</button>
            </div>
```
改为：
```html
            <div class="row" style="gap:6px;margin-bottom:6px">
                <input list="cfgByok3ModelList" id="cfgByok3Model" value="{{byok3ModelValue}}" placeholder="输入或选择模型名" style="flex:1;font-size:12px;padding:5px 8px" autocomplete="off">
                <datalist id="cfgByok3ModelList">{{byok3ModelOptions}}</datalist>
                <button type="button" class="btn btn-s sm" data-ws-action="fetchModels" data-ws-slot="3" style="padding:4px 8px">加载模型</button>
            </div>
```

- [ ] **Step 7: 改 config-tab.html — BYOK #4 select→input+datalist**

将 `src/views/templates/partials/config-tab.html:117-120`：
```html
            <div class="row" style="gap:6px;margin-bottom:6px">
                <select id="cfgByok4Model" style="flex:1;font-size:12px;padding:5px 8px">{{byok4ModelOption}}</select>
                <button type="button" class="btn btn-s sm" data-ws-action="fetchModels" data-ws-slot="4" style="padding:4px 8px">加载模型</button>
            </div>
```
改为：
```html
            <div class="row" style="gap:6px;margin-bottom:6px">
                <input list="cfgByok4ModelList" id="cfgByok4Model" value="{{byok4ModelValue}}" placeholder="输入或选择模型名" style="flex:1;font-size:12px;padding:5px 8px" autocomplete="off">
                <datalist id="cfgByok4ModelList">{{byok4ModelOptions}}</datalist>
                <button type="button" class="btn btn-s sm" data-ws-action="fetchModels" data-ws-slot="4" style="padding:4px 8px">加载模型</button>
            </div>
```

- [ ] **Step 8: 运行测试确认新测试通过**

Run: `node --test test/unit/sidebarTemplate.test.mjs`
Expected: `应该将模型选择渲染为 input + datalist 组合控件` PASS。存量失败测试数量不增加（基线 20 个失败）。

- [ ] **Step 9: 运行 lint 确认无新增 warning**

Run: `npx eslint src/views/sidebarTemplate.js --max-warnings 50`
Expected: 无新增 warning（基线 64 个为已知债务，此文件改动不应增加）

- [ ] **Step 10: Commit**

```bash
git add src/views/sidebarTemplate.js src/views/templates/partials/config-tab.html test/unit/sidebarTemplate.test.mjs
git commit -m "feat: 模型选择改为 input+datalist 组合控件（模板层）"
```

---

### Task 2: 前端渲染逻辑适配 — sidebar.js fn25

**Files:**
- Modify: `resources/webviews/sidebar.js:526-574` (fn25 内部从操作 select.options 改为操作 input.list datalist)

**Interfaces:**
- Consumes: `fn25(arg0, arg1, arg2)` 调用方（fn31/fn32/externalConfigImported 处理）传的 `arg0` 从 `<select>` 变为 `<input>`，`arg0.list` 返回关联的 `<datalist>`
- Produces: fn25 行为不变（填充模型选项 + 设置选中值），仅渲染目标从 select 改为 datalist

> 注：`resources/webviews/sidebar.js` 是前端 webview 脚本，无 node --test 单元测试覆盖。验证靠 lint + 逻辑审查 + 实机验证。

- [ ] **Step 1: 改 fn25 — 从操作 select 改为操作 input.list（datalist）**

将 `resources/webviews/sidebar.js:526-574` 的 `fn25` 函数整体替换：

```js
  function fn25(arg0, arg1, arg2) {
    if (!arg0) {
      return;
    }
    const dl = arg0.list;
    const tmp32 = String(arg2 || "").trim();
    const tmp4 = [];
    const tmp5 = new Set();
    for (const tmp02 of arg1 || []) {
      const tmp03 = fn21(tmp02);
      if (!tmp03 || tmp5.has(tmp03)) {
        continue;
      }
      tmp5.add(tmp03);
      tmp4.push(tmp02);
    }
    const tmp6 = tmp32 && !tmp5.has(tmp32) ? [{
      id: tmp32,
      name: tmp32
    }].concat(tmp4) : tmp4;
    if (dl) {
      const tmp7 = Array.from(dl.options).map(arg02 => arg02.value + "\0" + (arg02.textContent || "")).join("");
      const tmp8 = tmp6.map(arg02 => fn21(arg02) + "\0" + (fn22(arg02) || fn21(arg02))).join("");
      if (tmp7 === tmp8) {
        if (tmp32 && arg0.value !== tmp32) {
          arg0.value = tmp32;
        }
        return;
      }
      dl.innerHTML = "";
      for (const tmp02 of tmp6) {
        const tmp03 = document.createElement("option");
        tmp03.value = fn21(tmp02);
        tmp03.textContent = fn22(tmp02) || tmp03.value;
        dl.appendChild(tmp03);
      }
    }
    if (tmp32) {
      arg0.value = tmp32;
    }
  }
```

关键变更说明：
- `arg0.list`（HTMLInputElement.list）拿到关联的 `<datalist>`，替代原 `arg0.options`（HTMLOptionsCollection）
- 去重逻辑（tmp4/tmp5）不变
- 选中值前置（tmp6）不变
- 比较现有 options：从 `dl.options` 取（HTMLDataListElement.options 仍返回 HTMLOptionsCollection）
- 空列表时不再渲染占位 option（input 有 placeholder），直接清空 datalist
- datalist 的 option 无 `selected` 概念，去掉 selected 相关逻辑；选中值靠 `arg0.value = tmp32` 体现

- [ ] **Step 2: 确认 fn25 调用方无需改动**

fn25 的所有调用方传的 `arg0` 都是 `fn4("cfgByok" + slot + "Model")`，该 id 现在是 `<input>` 元素。`HTMLInputElement.list` 自动返回 `list` 属性指向的 `<datalist>`。调用方代码无需改动。

验证调用点（应均为 `fn4("cfgByok" + ... + "Model")`）：
- `sidebar.js:691` (fn31): `fn25(tmp22, ...)` 其中 `tmp22 = fn4("cfgByok" + tmp12 + "Model")`
- `sidebar.js:716` (fn32 错误分支): `fn25(tmp4, ...)` 其中 `tmp4 = fn4("cfgByok" + tmp32 + "Model")`
- `sidebar.js:729` (fn32 成功分支): `fn25(tmp4, ...)` 同上
- `sidebar.js:1185` (externalConfigImported): `fn25(tmp13, ...)` 其中 `tmp13 = fn4("cfgByok" + tmp02 + "Model")`

所有调用点传的都是 input 元素，`arg0.list` 正常工作。

- [ ] **Step 3: 运行 lint 确认无新增 warning**

Run: `npx eslint resources/webviews/sidebar.js --max-warnings 50`
Expected: 无新增 warning（若 eslint 未配置扫描 resources/ 目录，则跳过此步，改为逻辑审查）

- [ ] **Step 4: 运行测试套件确认无新增失败**

Run: `node --test test/**/*.test.mjs`
Expected: 失败测试数量不增加（基线 20 个失败）

- [ ] **Step 5: Commit**

```bash
git add resources/webviews/sidebar.js
git commit -m "feat: fn25 适配 datalist 渲染（前端组合控件）"
```

---

## Self-Review

**1. Spec 覆盖检查：**
- ✅ 组合控件（input + datalist）：Task 1 HTML 改造 + Task 2 fn25 适配
- ✅ 始终可编辑：input 元素天然可编辑，placeholder"输入或选择模型名"
- ✅ 加载失败时显示错误 + 空输入框可编辑：fn32 错误分支（sidebar.js:715-723）不改，modelFetchStatus 显示红色错误；fn25 传空数组时清空 datalist，input 保留 value 可编辑
- ✅ 加载成功填充 datalist：fn32 成功分支调 fn25 填充
- ✅ 4 个 BYOK 槽位统一改造：Task 1 Step 4-7 覆盖 #1~#4
- ✅ 后端/保存逻辑不变：未改动 modelFetcher.js / profileStore.js / sidebarProvider.js
- ✅ 测试适配：Task 1 Step 1 新增 datalist 断言

**2. 占位符扫描：** 无 TBD/TODO，所有步骤含实际代码。

**3. 类型一致性：**
- `byok1ModelValue` / `byok1ModelOptions` 在 sidebarTemplate.js 定义，在 config-tab.html 通过 `{{byok1ModelValue}}` / `{{byok1ModelOptions}}` 消费——命名一致
- `fn25(arg0, arg1, arg2)` 签名不变，arg0 从 select 变 input，内部用 `arg0.list` 访问 datalist——调用方无需改
- datalist id `cfgByok1ModelList`~`cfgByok4ModelList` 在 HTML 定义、在 input 的 `list` 属性引用、在测试断言检查——命名一致