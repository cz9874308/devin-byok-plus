# Changelog

所有重要更改都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并且本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.4.1] - 2026-07-09

### Fixed
- **修复子代理误触发任务完成提示音**：Fast Context 等辅助子 agent 调用底层工具成功后会误触发任务完成提示音。现改为仅携带真实工具的主对话请求才有资格发声，只带 `do_not_call` 哨兵或无工具的辅助子 agent 结束时不再响铃。新增 `isSoundEligibleRequest()` 判据，并为 `shouldSignalCompletion()` 增加 `soundEligible` 门控参数。

## [2.4.0] - 2026-07-09

### Added
- **GitHub 版本更新提示**：启动时检测 GitHub 最新 Release，若存在新版本则在侧栏提示，便于用户及时升级。
- **放开工具白名单**：透传所有 Devin 工具，不再按内置白名单过滤，兼容上游新增工具（原仅放行已知工具集）。
- **聊天标签改名补丁**：支持将聊天输入框 Agent 标签 "Cascade" 改名为自定义文案（默认 "Devin Proxy"），接入补丁管理器实现一键应用/还原，带可自定义文案输入框。由于目标 bundle（`workbench.desktop.main.js` / `sessions.desktop.main.js`）受 `product.json` 完整性校验，补丁会同步更新对应 checksum。
- **BYOK 槽位可配置上下文窗口**：各 BYOK 槽位支持独立配置 contextWindow，贯通 `.env`（`BYOKn_CONTEXT_WINDOW`）→ 运行态 → `GetUserStatus` 响应改写，UI 层新增上下文窗口档位输入项。用于让 Devin 客户端 UI 显示并使用自定义的上下文窗口大小。
- **任务完成提示音**：任务完成时播放提示音（`resources/sound/completion.mp3`），支持开关配置。

### Changed
- 插件图标统一改为 W 造型。

### Fixed
- 修复 BYOK 503 回退时标题被上游报错覆盖的问题（fallback title guard）。

## [2.3.0] - 2026-07-04

### Added
- **OpenAI service_tier=fast 支持**（移植上游 v2.4.0）：各 BYOK 槽位支持独立配置 `OPENAI_SERVICE_TIER`（取值 `fast` 或空），启用 OpenAI 优先级通道（priority tier）。UI 层新增 "GPT Fast Mode" 下拉选项（仅在协议为 `openai/gpt` 时显示），配置通过 `.env` 持久化并支持热重载。模型名以 `-priority` 结尾时自动启用 fast 模式。三层回退机制：slot 级配置 → BYOK1 回退 → 全局 `OPENAI_SERVICE_TIER`。诊断报告集成 service tier 状态显示。
- **手动协议选择**：BYOK 配置卡片新增 Protocol 下拉框（anthropic / openai / gemini），支持手动覆盖自动检测的 provider。协议变更时思考强度下拉和 GPT Fast Mode 行会联动显隐/重建选项，避免协议与参数不匹配。存储于 `BYOKn_PROTOCOL` 环境变量，空值时回退自动检测。扩展 `profileStore` 支持 protocol 字段持久化到 profiles.json。
- **方案编辑器 UI 优化**：方案编辑器从嵌入式改为独立折叠卡片，默认隐藏以减少首屏信息密度。卡片标题栏显示当前激活方案名，支持点击展开/折叠。Tutorial 教程文案同步更新方案管理流程说明。

### Changed
- BYOK 配置卡片 Thinking Effort 行在手动协议下**总是显示**（之前仅按模型名自动判断）；协议切换时立即根据新协议重建思考强度选项列表。
- `sidebarTemplate.js` 新增 `buildProtocolOptions()` 和 `buildOpenAIServiceTierOptions()` helper，统一下拉选项生成逻辑。
- `profileStore.js` 的 `sanitizeProtocol()` 和 `detectModelProtocol()` 增强协议白名单校验与自动识别（anthropic/openai/gemini）。
- `diagnostics.js` 的 `resolveDiagnosticModelRoute` 扩展支持 4 个 BYOK 槽位的 service tier 读取（BYOK1=Opus, BYOK2=Opus Thinking, BYOK3=Sonnet, BYOK4=Sonnet Thinking）。

### Fixed
- 修复协议手动切换后思考强度选项未联动更新的问题。
- 修复 GPT Fast Mode 行在非 OpenAI 协议下仍显示的问题（现按 protocol 严格控制可见性）。

## [2.2.0] - 2026-07-03

### Added
- **4 槽位 BYOK 扩展**：从 2 槽位扩展到 4 槽位，新增 Claude Sonnet 4 BYOK（#3）与 Claude Sonnet 4 Thinking BYOK（#4），支持更灵活的多模型配置。UI 层新增 BYOK #3/#4 配置卡片（紫色/琥珀色条纹），表单自动保存与槽位状态徽章完整支持 4 槽位。
- **多渠道 Profile 系统**：引入配置方案（Profile）管理能力，支持创建/切换/重命名/复制/删除多套独立配置，每个方案管理 4 个 BYOK 槽位 + 高级配置，存储于 `~/.devin-byok-plus/profiles.json`（0o600 权限保护）。向后兼容：现有 2 槽位用户无感迁移，旧 profiles.json 自动补齐 byok3/byok4 字段；BYOK #3/#4 为可选扩展槽位，不强制配置。
- **Prompt Cache / Token 优化**（移植上游 v2.3.0）：Anthropic 请求自动对 system / tools / 消息稳定前缀打 `cache_control` 断点并携带 `anthropic-beta: prompt-caching-2024-07-31` 头；网关不支持时自动标记能力并立即无缓存重试（不计入重试次数/熔断）。OpenAI/Gemini 路径按 name 稳定排序 tools、稳定请求前缀以提升隐式前缀缓存命中。新增环境变量 `PROMPT_CACHE_ENABLED` / `ANTHROPIC_PROMPT_CACHE` / `OPENAI_PROMPT_CACHE` / `PROMPT_CACHE_SORT_TOOLS` / `PROMPT_CACHE_TAIL_MESSAGES`。
- **Token 用量日志**（移植上游 v2.3.0）：各 provider 流结束时输出统一 `📊` 日志（input/output/cached/creation/命中率/模式/路由/cache 状态），用于观测缓存效果与 token 消耗。
- **上游地址覆盖**：`PROXY_API_HOST`（hybrid-server）与 `PROXY_INFERENCE_HOST`（inference-proxy）支持自定义上游 API 地址。

### Changed
- `EXPOSE_BACKEND_INFO` 默认值由 `true` 改为 `false`：system prompt 末尾追加的动态 backend 信息会破坏前缀缓存；如需恢复请显式设置 `EXPOSE_BACKEND_INFO=true`。
- ws-bridge 运行时注入的消息现作为「易变尾部」处理，prompt cache 断点自动前移，内部标记发送上游前剥除。
- `release.js` 脚本移除自动写入 CHANGELOG 功能，改为用户手动维护，避免重复追加条目。

### Fixed
- 修复 `config-hotreload.test.mjs` 中 oversized POST body 测试的请求体大小（20000→64001 字节，真正超过 64000 上限以正确触发 413 检查）。
- 修复代理层 `models.js` 的 `/api/models` 端点 slot 参数解析（原仅接受 1/2，导致 BYOK #3/#4 "加载模型"按钮失效）。
- 修复 `chat.js` 和 `diagnostics.js` 的 `MODEL_MAP` 缺失 Sonnet 4 BYOK 两个模型键，导致 Sonnet 4 请求无法路由。
- 修复 `sidebarProvider.js` 的 `importExternalConfig` / `fetchModels` 处理器 slot 范围校验（原仅支持 1/2，扩展到 1-4）。
- 修复 `profileStore.js` 的 `projectToEnvConfig` / `listProfiles` 对缺失槽位字段的防御性处理，避免旧数据访问 undefined 崩溃。

## [2.1.2] - 2026-06-28

### Fixed
- 修复强制 `tool_choice` 指向的命名工具缺失时被静默丢弃：当请求用 `tool_choice={type:"tool",name:"finish"}` 等强制调用某工具、但该工具不在本轮 `tools` 也不在历史中时，旧逻辑会丢弃 tool_choice 并退回 auto（可能导致收尾工具 `finish` 不被调用）。现自动为该命名工具补齐占位定义并放行 tool_choice，使模型能真正调用它完成收尾。
- 回退"工具调用中途断流时检测/重试/优雅收尾"的处理：经排查，上游中转（如 `10.0.1.36:8090`）在转发 `edit` 等大参数 `tool_use` 流时会在约 230 字节处**确定性截断**（重试逐字节相同的请求仍卡在同一位置，故重试无效）。该截断在加入检测前一直存在，只是旧逻辑会把残破 JSON 原样发给客户端、由 Devin 自动重做本轮（表现为"卡一下后继续"）。新增的检测/重试/优雅收尾反而打断了这一自愈路径（要么红错中断、要么静默丢失编辑）。现已完全回退到 `f628d9d` 的行为：截断的 `tool_use` 原样发出，交由客户端自愈重做。**根因在上游中转，需在中转侧排查为何对大参数 tool_use 流式输出在约 230 字节处断流。**
- 修复流式 tool_use 参数被截断时整个代理进程崩溃退出（`TypeError: Cannot create property 'old_string' on string`）：当上游 SSE 在工具调用中途断流、`arguments` 为非法/截断 JSON 时，`normalizeToolArguments` 会原样返回字符串，随后 `remapKey` 在字符串上写属性而抛错并使 hybrid-server 退出重启。现 `normalizeToolInvocation` 在参数非普通对象时跳过键重映射并原样返回，`remapKey`/`remapArrayKey` 增加类型守卫作为兜底。
- 修复 AmazonQ/Bedrock 报错 `TOOL_CONFIG_MISSING`（"The toolConfig field must be defined when using toolUse and toolResult content blocks"）：当历史消息含 `tool_use`/`tool_result` 内容块、但本次请求未携带工具定义时（工具被 KNOWN_TOOL 过滤丢弃或后续轮次未重发），代理会依据历史出现的工具名合成最小占位工具定义，确保 Bedrock 必需的 `toolConfig` 字段被填充；合成的占位工具不会强制 `tool_choice`。

## [2.1.1] - 2026-06-18

### Added
- **标签页式 UI 重构**：全新的 3 标签页布局（配置连接、控制状态、系统补丁），信息分组更清晰
- **快捷键支持**：Cmd/Ctrl + 1/2/3 快速切换标签页，提升专业用户操作效率
- **智能配置徽章**：自动检测配置完整性，未配置时显示警告徽章，配置完整时自动隐藏
- **淡入淡出动画**：流畅的标签页切换体验（0.2s ease-in-out）
- **响应式优化**：完整的小屏幕适配（≤400px），自动调整字体、间距和徽章尺寸
- **视觉增强**：底部彩色激活指示条、改进的阴影效果、BYOK 配置块彩色条纹边框
- HTML 模板纳入 VSIX 打包，修复安装后模板丢失问题

### Changed
- **Provider 模块化拆分**：将 `sidebarProvider.js` 拆分为 5 个独立服务模块（`services/diagnostics`、`services/environmentProbe`、`services/modelFetcher`、`services/promptTemplates`、`services/thinkingEffort`），Provider 代码量减少约 32%
- **视图模块化**：侧栏 HTML 拆分为 `views/templates/partials/`（config-tab、control-tab、system-tab、tutorial），告别单文件 HTML 巨石
- **视觉统一**：侧栏视觉语言统一，输入框溢出修复，提示词重构为可折叠卡片，折叠交互一致化
- 基于上游 v2.1.0 + v2.0.4，包含配置热重载修复、模型验证增强、静默自动保存

### Technical
- 新增 `switchTab()` 函数处理标签页切换
- 新增 `updateTabBadges()` 函数动态更新配置状态
- 新增 CSS 关键帧动画和媒体查询（Tailwind CSS 构建）
- `src/` 目录按功能分层：`managers/`、`providers/`、`services/`、`utils/`、`views/`、`proxy/`
- 178 个单元测试，覆盖 Provider 拆分后的关键路径

## [2.0.4] - 2026-06-16

### Fixed
- 修复配置热重载 Bug：解决 POST 请求超时问题，支持预缓冲请求体
- 增强默认模型验证：提前拦截未配置模型的请求，避免无效 API 调用
- 修复前端 JavaScript 智能引号导致的语法错误

### Added
- 实现静默自动保存功能：配置变更后自动保存（650ms 防抖），提升用户体验
- 新增 7 个单元测试，覆盖配置热重载和模型验证关键路径
- 代码质量提升：提取 `authorizeConfigPost()` 和 `applyConfigPostBody()` 函数，实现关注点分离

### Changed
- 改进错误消息：提供更清晰的配置指引（英文版）
- 优化配置更新流程：支持预缓冲和流式两种请求体处理方式
- 完善函数导出：`requiresConfiguredDefaultModel()` 现在可供外部测试使用

## [2.0.3] - 2026-06-13

### Fixed
- 修复 Anthropic SSE 响应流处理问题，增强流式响应稳定性
- 修复 Bedrock 兼容性问题和配置重载回退机制
- 修复 Windows 本地回环连接和扩展激活崩溃问题

### Changed
- 重构代理脚本架构，优化代码组织和可维护性
- 项目正式更名为 **Devin BYOK Plus**（随 Windsurf → Devin Desktop 品牌更新）
- 更新项目归属信息，明确 fork 关系和致谢说明

### Added
- 新增请求重试机制，提高网络请求可靠性
- 新增熔断机制，防止级联失败
- 完善错误处理和降级策略

## [2.0.2] - 2026-06-10

### Fixed
- 改进网关兼容性
- 修复 MCP 工具过滤问题
- VSIX 升级时保留用户配置

## [2.0.1] - 2026-06-09

### Added
- 发布去混淆可读源代码
- 更新项目文档

## [2.0.0] - 2026-06-08

### Added
- 支持双 BYOK 槽位（BYOK #1 和 BYOK #2）
- 支持多模型路由（Claude / GPT / Gemini）
- 支持思考强度控制（adaptive / budget_tokens / reasoning.effort / thinking_level）
- 完整的网关能力检测和回退机制
- OpenAI Responses API 支持及自动回退
- Gemini 3.x thinking_config 支持

### Changed
- 全面重构代理架构
- 优化配置管理和运行时热更新

## [1.1.0] - 2026-06-07

### Changed
- 品牌更新：Windsurf → Devin Desktop
- 项目更名为 Devin BYOK Bridge
- 保留对旧版 Windsurf 安装路径的兼容

## [1.0.0] - 2026-06-06

### Added
- 初始发布 Windsurf BYOK Bridge
- 基础 BYOK 代理功能
- Claude 模型支持
- 本地代理服务器
- 补丁系统

---

**历史版本**（fork 自 [ycx932436/devin-byok-bridge](https://github.com/ycx932436/devin-byok-bridge)）

感谢原作者 [@ycx932436](https://github.com/ycx932436) 的开创性工作！
