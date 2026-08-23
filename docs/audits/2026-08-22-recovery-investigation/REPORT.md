# Flowloud 前端回归调查与恢复方案

日期：2026-08-22  
分支：`codex/sync-latest-project`  
基准提交：`fa296f5`

## 结论

当前版本不是“还差一点打磨”，而是一次已经进入交互契约、CSS 覆盖层和测试契约的回归。最直接的恢复路线不是继续在 Orb v2 上追加补丁，也不是立即重写整个扩展，而是：

1. 先把网页悬浮播放器恢复到 `fa296f5` 中仍可用的 mini player 基线；
2. 将暂停协议和段落定位作为两个独立的功能修复处理；
3. 再用 WXT、Storybook 和成熟的无障碍组件库逐步替换手写的开发工具与交互控件。

现有 `373/373` 测试通过，但这不能证明产品可用：部分测试明确要求“小圆球”和 `36px`，浏览器 harness 只检查节点存在或 class 改变，没有检查按钮在计算样式后是否可见、是否有足够命中区，也没有覆盖暂停重试耗尽的终态。

## 审计范围与限制

- 阅读了用户引用的 Codex 对话，并把其中“已完成”“已验收”的说法与当前代码、Git 历史和实际渲染逐项核对。
- 对当前工作区和 `fa296f5` 历史基线分别启动了同一浏览器测试页并截图。
- 运行了扩展 Node 测试：`373` 通过、`0` 失败。
- 当前截图来自仓库内 browser harness/stub，足以暴露 CSS、布局和交互契约回归，但不是目标论坛、真实 TTS provider、原生浏览器 action popup 的完整端到端证明。
- 没有用户实际发生“播放错位”的网页样本，因此本报告能指出代码风险和缺失的验收条件，不能宣称已经在生产页面复现全部错位场景。

## 关键流程审计

### 1. 折叠悬浮球 — 不健康

![当前折叠悬浮球](02-current-minimized.png)

- CSS 把 launcher 缩成 `36 × 36px`（`extension/content/reader.css:2104`），贴边时再 `translateX(±50%)`（`1995`、`1999`），实际露出的主表面只有约 `18px`。
- 这正是“太小、难点”的直接原因，也低于 WCAG 2.2 对普通指针目标 `24 × 24 CSS px` 的最低要求。即便不以合规为唯一目标，连续使用的播放入口也不应贴边藏掉一半。
- 建议验收线：球体视觉尺寸 `40–44px`，可点击区域至少 `44px`，默认完整露出；仅允许装饰性阴影越界，不允许主要交互面越界。

参考：[W3C WCAG 2.2 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)

### 2. 展开播放器 — 不健康

![当前展开播放器](01b-current-playing-detail.png)

- 展开后 DOM 中确实恢复了上一句/下一句节点（`reader.css:2267`），但 Orb 通用规则把所有图标统一成白色（`reader.css:2080–2083`）。展开态没有为次要按钮恢复深色图标，导致白色图标落在浅色卡片上，肉眼几乎不可见。
- 当前 harness 在 `extension/tests/browser/ui-harness.html:299–301` 只是程序化点击 `.qr-mini-context`，随后检查 `.qr-mini-copy` 节点存在；它没有检查上一句/下一句的计算颜色、可见面积、按钮名称或真实命中。
- 因此“点击后没有之前播放控件”的反馈与代码和截图完全一致，不是主观偏好问题。

### 3. `fa296f5` 历史基线 — 功能较健康，视觉仍可继续打磨

![fa296f5 mini player 基线](03b-head-playing-detail.png)

- 当前 Git HEAD 的提交内容（不含工作区未提交的 Orb v2 改动）仍保留完整的上一句、播放/暂停、下一句、收起和跟随控制。
- 仓库另有 `stash@{0}: pre-integration legacy floating player`，但它更老、与当前架构偏差更大。恢复时应优先以 `fa296f5` 为最小回退基线，stash 只用于追溯行为，不直接整包覆盖。
- 恢复应限定在 mini player 的 markup/state/CSS 和对应测试，不应重置整个脏工作区，也不应丢弃其他已完成的设置中心、声音编辑器或播放功能改动。

### 4. Popup — 有风险

![当前 Popup B+C 对照页](05-current-popup-lab.png)

- 当前顶部播放区的基本结构比悬浮球稳定，但 transient popup 同时承载来源、倍速、页面交互、作者策略、页面音色和编辑入口，信息密度偏高。
- `popup-lab.html` 是开发对照页，不是实际用户每次会看到三个 Popup 的流程；它可以保留作 Storybook/设计测试材料，不应继续充当生产交互的主要验收方式。
- 建议生产 Popup 固定两层：顶部始终是当前内容和三枚核心 transport controls；第二层只保留倍速和“更多设置”。Provider、作者策略、页面音色编辑进入明确的二级页/Popover，避免每次打开都滚动和重新理解。

## 根因

### P0 — Orb v2 的产品假设本身被写进了测试

- `extension/content/reader.js:204` 把 `miniPlayerMinimized` 默认设为 `true`。
- `extension/tests/reader-visual-contract.test.cjs:37–46` 明确测试“小圆形命中区”和 `36px`，所以测试通过实际上在确认用户不想要的设计。
- Orb 改造在 `reader.css` 末尾追加了约 330 行高优先级覆盖，旧 mini player 规则仍在前面，形成两套状态互相覆盖。白色图标回归就是这种 CSS 级联的直接结果。

处理：撤销/隔离未提交 Orb v2 覆盖层，恢复 `fa296f5` mini player 行为，再用新的可视状态契约重建测试；不要继续往 CSS 文件尾部补第三层规则。

### P0 — 暂停失败被伪装成“成功但未应用”

- `extension/background.js:344–358` 捕获 offscreen 控制失败后返回 `{ ok: true, paused/resumed: false, count: 0 }`，把“没有接收端/后台音频页不可用”伪装成正常 no-op。
- `extension/content/reader.js:1270–1344` 对 `count=0` 反复重试；达到 40 次时直接 return，没有进入明确失败态、恢复按钮或告诉用户实际播放状态。
- 因此 UI 可能长期停在“正在暂停/正在继续”，而测试覆盖的是 offscreen 正常存在、identity 正确的理想路径。

处理：

1. background 返回带 code 的失败结果，如 `offscreen_unavailable`、`playback_not_found`、`identity_mismatch`，不要返回 `ok: true`。
2. reader 使用一个有 deadline 的控制状态机；暂停/恢复必须由同一 playback identity 的确认事件落地。
3. deadline 到期后进入 `control_failed`，恢复按钮可操作，展示可重试错误，并保持最后一个已确认的真实播放状态。
4. 新增“offscreen 缺失”“错误 identity”“早期 pause 排队”“重试耗尽”“ended 与 pause 竞态”端到端测试。

### P1 — 播放定位仍混合了稳定 locator 与文本启发式

- 当前改动优先使用渲染几何命中（`reader.js:1069`），对点击点错到下一句有帮助。
- 但 `findUnusedSegmentMatch`（`reader.js:2301`）在重复文本中选择第一个“尚未使用”的候选。相同句子、虚拟列表、DOM 重排、API 顺序和页面顺序不一致时，“未使用”不是稳定身份。

处理：让 `segmentId`/`sourceLocator` 成为队列、DOM range、高亮和音频事件的唯一身份；索引只用于显示。每个 segment 至少携带容器 fingerprint、unit index、源字符区间和 playback generation。重复文本只能作为最后降级匹配，不能作为主键。

### P1 — 预览与测试给出了错误安全感

- 现有 preview 会在原生 popup 打不开时 fallback 到普通扩展页；这能验证渲染，但不能验证工具栏锚点、popup 生命周期和失焦关闭。
- harness 对悬浮球只断言宽高不超过 `44px`（`ui-harness.html:287`），这反而奖励了过小设计。
- 现有源码正则测试没有真实浏览器的计算样式、对比度、命中和焦点验证。

处理：保留 Node 单测，但把 UI 验收拆成 Storybook 浏览器组件测试、视觉快照、真实扩展 E2E 三层；只有三层都通过才允许写“前端回归通过”。

## 推荐技术栈：停止重复造开发工具和基础控件

### 1. WXT：扩展开发、构建和热更新

采用 WXT 管理 manifest、popup/options/content/background/offscreen 入口和开发浏览器。WXT 基于 Vite，UI 支持 HMR；开发时 content script 可在保存后单独重载，不需要每次手动重载整个扩展。官方迁移指南也明确建议先建 vanilla 项目、逐文件迁移，并最终比较 manifest 权限，适合这个仓库而不是一次性大重写。

参考：[WXT](https://wxt.dev/)、[WXT FAQ：content script 保存后单独重载](https://wxt.dev/guide/resources/faq)、[WXT 增量迁移](https://wxt.dev/guide/resources/migrate.html)

### 2. Storybook + Vitest browser mode：快速预览全部状态

为 `FloatingPlayer`、`PopupTransport`、`QuickSettings`、`VoiceAssignmentEditor` 建独立 stories。至少覆盖：折叠左右边、展开、loading、playing、pausing、paused、resume pending、error、小视口和长文本。Storybook 支持在隔离环境开发、真实浏览器交互、watch mode、无障碍和视觉回归，能把“改一次打一次包”的流程变成保存后立即看到状态。

参考：[Storybook React + Vite](https://storybook.js.org/docs/get-started/frameworks/react-vite)、[Storybook UI testing](https://storybook.js.org/docs/writing-tests)、[Storybook accessibility testing](https://storybook.js.org/docs/writing-tests/accessibility-testing)

### 3. React Aria Components：替换手写 Switch/Select/Tabs/Toolbar/Tooltip

UI 表层使用 React + React Aria Components；播放、提取、provider、offscreen 和 source locator 保持框架无关。React Aria 已提供 Select、Switch、Tabs、Toolbar、Tooltip、Slider 等基础行为和无障碍交互，可保留 Flowloud 的视觉样式，同时减少自己实现键盘、焦点、状态和屏幕阅读器语义的 bug。

参考：[React Aria Components](https://react-aria.adobe.com/getting-started)

## 分阶段恢复计划

### 阶段 A — 先恢复可用性（P0）

1. 冻结 Orb v2 与发布包更新，先保留当前脏工作区快照。
2. 只恢复 `fa296f5` 的 mini player markup、状态和 CSS；把点击定位与暂停修复拆成独立提交，避免 UI 回退误伤功能改动。
3. 修复 offscreen 控制错误协议和 reader 控制终态。
4. 用真实计算样式断言上一句/下一句可见，使用真实 pointer 点击，不再用 DOM `.click()` 代替用户操作。

完成标准：悬浮播放器完整可见、核心按钮都能看见和点击；暂停无论成功或失败都在有限时间内进入明确终态。

### 阶段 B — 修正播放身份（P1）

1. 从用户发生错位的页面保存一个脱敏 fixture。
2. 队列、DOM range、音频和高亮统一使用稳定 `segmentId/sourceLocator`。
3. 增加重复句、DOM 重排、分页论坛、动态加载、错误 caret 指向下一句等回归场景。

完成标准：点击第 N 句时，播报、高亮、Popup 文案和恢复位置都属于同一 segment identity；DOM 重排后仍能解析到同一来源。

### 阶段 C — 建立日常前端开发环境（P1）

1. 先按 WXT 官方方案迁移 vanilla 入口并保持权限不变。
2. 抽出纯 UI model/adapter，让 Storybook 不依赖真实扩展 API。
3. 只把 Popup、FloatingPlayer、设置控件迁移到 React Aria；不重写播放核心。
4. 建立 `dev`、`storybook`、`test-storybook`、`build` 四条固定命令；开发构建输出不进入 release 目录，release zip 只在发布时生成。

完成标准：保存 Popup/悬浮播放器代码后立即刷新对应 UI；content script 自动重载；只有 background/offscreen 与真实网站集成测试才需要完整扩展浏览器会话。

## 新的验收清单

- 折叠 launcher 完整露出，视觉尺寸至少 `40px`、主命中区建议 `44px`。
- 点击非播放区域展开；点击中心只执行播放/暂停；拖动结束不误触点击。
- 展开态上一句/播放暂停/下一句都可见、可聚焦、具备可读名称，图标和背景有清晰对比。
- popup 的 transport 首屏固定可见；次要设置不会把主任务推出首屏。
- pause/resume 在正常路径得到 identity 确认；后台缺失时 3 秒内明确失败并恢复可操作状态。
- 重复句、DOM 重排和分页场景中不会播错段或高亮错位。
- Storybook 视觉、交互、a11y 测试与真实扩展 E2E 同时通过。
- WXT 迁移前后 manifest 权限、host permissions 和扩展 ID 策略保持不变。

## 本次验证结果

- Node tests：`373 passed / 0 failed`。
- 当前折叠球、当前展开态、`fa296f5` 基线和 Popup B+C 对照页均已在本轮浏览器会话中重新渲染并截图。
- 未对产品源代码做修改；本轮只新增本调查报告和证据截图。
