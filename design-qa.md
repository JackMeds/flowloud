# Flowloud split edge-menu and expand-icon floating player — Design QA

## Source visual truth

- Selected visual language: `C:\Users\15300\.codex\generated_images\01a026f8-c5b9-7ec3-b7f1-903fb89c7c74\exec-3e4ad747-f09c-4625-bbf2-403185dec434.png`.
- Scoped user delta: playback and locate controls above the orb; expand below; the pointer path must remain interactive; the expanded card uses a button-matched outer radius and a smaller attached-edge radius; the ambiguous single chevron is replaced by standard maximize/restore icons.
- Implementation: `extension-wxt/components/FloatingPlayer.tsx`, `extension-wxt/styles/components.css`, `extension/content/reader.js`, and `extension/content/reader.css`.

## Capture normalization

- Browser implementation viewport: 1280 × 720 CSS px.
- Implementation screenshots: 1280 × 720 px at device scale factor 1.
- Source image: 1536 × 1024 px; contact sheets normalize both artifacts to equal comparison columns.
- State: right-edge half-hidden orb, hover-revealed split shortcuts, upper shortcut pointer path, lower expand pointer path, and expanded player.

## Evidence

- Full-view comparison: `docs/audits/floating-edge-split-menu/comparison-full.png`.
- Focused shortcut comparison: `docs/audits/floating-edge-split-menu/comparison-focused.png`.
- Focused expanded-card comparison: `docs/audits/floating-edge-split-menu/comparison-card.png`.
- Default capture: `docs/audits/floating-edge-split-menu/implementation-default.png`.
- Hover capture: `docs/audits/floating-edge-split-menu/implementation-hover-split.png`.
- Upper pointer-path capture: `docs/audits/floating-edge-split-menu/implementation-hover-upper.png`.
- Expanded capture: `docs/audits/floating-edge-split-menu/implementation-expanded.png`.
- Expand-icon full comparison: `docs/audits/floating-expand-icon/comparison-full.png`.
- Expand-icon focused comparison: `docs/audits/floating-expand-icon/comparison-focused.png`.
- Maximize hover capture: `docs/audits/floating-expand-icon/implementation-maximize-hover.png`.
- Minimize expanded capture: `docs/audits/floating-expand-icon/implementation-minimize-expanded.png`.

## Findings

- No remaining P0, P1, or P2 mismatch.
- Typography: existing Flowloud font stack, weights, sizes, truncation, and line heights are unchanged; no new wrapping or hierarchy drift was introduced.
- Spacing and layout: 40px orb, 44px hit target, 32px shortcuts, and 8px rhythm are preserved. Playback and locate now sit above; expand sits below. Transparent 8px padding bridges keep both pointer paths continuous.
- Colors and tokens: the neutral white/blue treatment and state colors remain mapped to existing tokens.
- Image and icon quality: the unclear chevron was replaced by Lucide `Maximize2` and `Minimize2`; exact library icons are used in React and packaged as SVG assets for the real extension. No placeholder, emoji, raster scaling, or handcrafted replacement asset was introduced.
- Copy: accessible labels explicitly distinguish the upper controls from the lower expand control; visible product copy is unchanged.
- Expanded edge: outer left corners are 9px to match control-button curvature; the attached right corners are 3px, so the two edges no longer look symmetrical.

## Primary interactions and console

- Moved from the revealed orb through the upper transparent bridge into the locate button: menu remained open.
- Returned to the orb and moved through the lower transparent bridge into the expand button: menu remained open.
- Clicked the lower expand button: the compact card opened correctly.
- Clicked the `Minimize2` control in the expanded card: the player returned to the half-hidden orb.
- Browser console checked after default, hover, upper-path, lower-path, and expanded states: no warnings or errors.

## Comparison history

1. Earlier P1: shortcuts were placed to the left and the 8px dead gap caused the menu to close before the pointer reached a control. Fixed by splitting the actions into `is-above` and `is-below` groups and turning their 8px padding into continuous hover bridges. Post-fix evidence: `implementation-hover-upper.png` and `implementation-expanded.png`.
2. Earlier P2: the expanded left edge used a larger arc that did not match the controls, while the attached edge treatment was inconsistent between Mock and production. Fixed both implementations to `9px 3px 3px 9px`. Post-fix evidence: `comparison-card.png`.
3. Latest P2: a lone upward chevron did not communicate whether the action expanded, collapsed, or moved the player. Replaced it with the paired `Maximize2`/`Minimize2` convention in Mock and production. Post-fix evidence: `docs/audits/floating-expand-icon/comparison-focused.png`.

## Verification

- Node extension suite: 422 passed, 0 failed.
- React/WXT TypeScript check: passed.
- Chrome MV3 build: passed.
- Edge MV3 build: passed.
- Chrome/Edge store gate: passed.

final result: passed

---

# Flowloud 方案 3「音色优先工作台」— Design QA

## Source visual truth

- 唯一视觉目标：`docs/design/voice-workbench-option-3.png`。
- 实现范围：唯一 Options 设置中心、统一音色目录、当前 Provider 配置面板、音色分配栏、Popup 快捷控制与纯资产声音工作室。
- 受控产品差异：实现保留豆包 TTS Provider 筛选项，并使用真实表单控件代替生成稿中的装饰性复制图标；这两项不改变视觉层级或主要操作路径。

## Capture normalization

- 参考稿：1440 × 1024 px。
- 浏览器实现：1440 × 1024 CSS px，截图 1440 × 1024 px，device scale factor 1。
- 参考稿固定状态只用于视觉布局比对；生产截图必须读取真实 Provider 状态、音色目录和当前分配，不得复用参考稿中的音色名称。
- 窄屏验收：960 × 640 CSS px；Provider 面板改为可展开侧栏，页面无水平裁切。

## Evidence

- 生产实现截图：`docs/design/voice-workbench-option-3-implemented.png`（真实运行时音色目录）。
- 视觉参考全视图对照：`docs/design/voice-workbench-option-3-comparison.png`（左：参考稿；右：历史布局验证稿）。
- 视觉参考聚焦对照：`docs/design/voice-workbench-option-3-comparison-focus.png`（上：参考稿；下：历史布局验证稿）。
- 动态数据全视图对照：`docs/design/voice-workbench-runtime-comparison.png`；聚焦版：`docs/design/voice-workbench-runtime-comparison-focus.png`。
- Playwright 运行证据保存在忽略目录 `.tmp-playwright/test-results/`，包括 Popup、960px Options、1440px 工作台、声音工作室和文档工作台截图。

## Findings

- 没有剩余 P0、P1 或 P2 视觉差异。
- 布局：左侧 232px 设置导航、中央目录与右侧 320px Provider 面板的桌面轨道和参考稿一致；搜索、筛选、目录、分配区的垂直节奏没有裁切。
- 字体与控件：正文保持 14–16px，主要按钮、筛选器和输入框至少 40px；中文标签清晰且无溢出。
- 信息架构：Options 只保留一个“语音与音色”；Popup 只有一个完整设置入口；声音工作室不再出现阅读、Provider 或存储设置。
- 状态与操作：可用、需下载、未配置、已连接和失败阶段使用不同标签及唯一主操作；不可用音色不能设为默认。
- 资产与图标：继续使用 Flowloud Logo、现有 Lucide/React Aria 组件和品牌蓝白色板，没有新增 UI 框架或临时绘制资产。

## Comparison history

1. 第一轮 P1：旧内容容器的 1040px 上限导致右侧操作列被配置面板遮挡。为语音工作台解除旧宽度约束后，目录和操作列完整显示。
2. 第二轮 P2：右侧 Provider 面板从标题下方开始，且当前音色缺少“试听/当前默认”动作。桌面面板上移为全高轨道，并补齐当前音色操作。
3. 第三轮 P2：搜索区、筛选器和目录起始位置与参考稿存在垂直密度偏差。统一搜索区高度、筛选间距和目录节奏后完成同状态复核。
4. 最终复核：全视图与聚焦对照均未发现裁切、错误层级、不可操作主控件或 P0/P1/P2 视觉偏差。

## Verification

- Schema/后台/运行时 Node 契约测试：478 passed，0 failed。
- React/WXT TypeScript：passed。
- Chrome MV3 与 Edge MV3 release UI build：passed。
- 完整 Playwright 浏览器套件：5 passed，2 environment-skipped，0 failed。
- 真实站点矩阵：3 passed，1 environment-skipped，0 failed。
- `pnpm e2e:release`：`RELEASE PASS 0.10.0-alpha.1`。

final result: passed

## Production data correction

- 用户反馈后，移除了 VoiceWorkbench 的生产演示目录、演示 Provider 状态和演示设置；正常 Options 路由不再解析或启用 `demo=voice-workbench`。
- 目录初始为空，Provider 音色通过后台 `voice:list` 按 Provider 独立读取；任一 Provider 失败不会用其他音色或占位音色补齐。
- 未配置的 OpenAI/豆包不会展示 Alloy 等伪目录；浏览器系统音色、浏览器模型目录和本地 TTS 音色均以当前运行时返回为准。
- Popup 初始状态也改为无标题、无作者、无音色的真实加载态；Storybook fixtures 保留在 stories 文件中且不进入生产入口。
- 生产 bundle 检查未发现 `demoPopupModel`、`Mock 界面预览` 或方案 3 示例音色字符串。

## Production data verification

- 正常 Options 路由截图显示运行时返回的 Microsoft 系统音色和浏览器模型音色，不再显示“晓晓、云健、Jenny、Alloy”等方案示例数据。
- Schema/后台/运行时 Node 契约测试：478 passed，0 failed。
- React/WXT TypeScript：passed；目标 UI E2E：passed；本轮完整 release 门禁通过。

final result: passed
