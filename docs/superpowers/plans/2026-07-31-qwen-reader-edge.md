# Qwen 网页朗读 Edge 扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建并部署一个采用方案 A 的 Edge 扩展，可自动识别论坛/小说正文、按作者切换本地 Qwen 音色并在插件内录制新音色。

**Architecture:** 新扩展使用 MV3 内容脚本注入 Shadow DOM 悬浮球与侧栏，纯函数模块负责提取、分块和音色分配；后台 service worker 独占本地 HTTP 调用与取消；独立扩展页面负责麦克风录制并保存 PCM WAV。论坛优先走 Flarum API，普通页面走评分式正文提取。

**Tech Stack:** Manifest V3、原生 JavaScript/CSS/HTML、Chrome Extension APIs、Web Audio API、Node.js 内置 `node:test`、Codex 内建浏览器。

## Global Constraints

- 本地接口固定为 `http://127.0.0.1:7811`，模型固定为 `qwen3-tts-1.7b-base`，响应格式固定为 WAV。
- 楼主音色 A 专属，任何非楼主内容不得使用 A。
- Flarum 正文至少两个可读字符即保留，不能使用旧扩展的 50/1000 字符阈值。
- 所有页面 UI 使用 Shadow DOM；播放/暂停图标不得使用文本字符 `Ⅱ`。
- 不执行远程代码，不上传正文或录音，不监听或调用非回环 TTS 地址。
- 生产代码必须先有失败测试；纯逻辑使用 Node `node:test`，DOM/UI 使用本地浏览器测试页。
- Node 命令使用 `C:\Users\15300\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`。

---

### Task 1: 扩展骨架与内容数据模型

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/background.js`
- Create: `extension/shared/defaults.js`
- Create: `extension/shared/text.js`
- Create: `extension/tests/text.test.cjs`
- Create: `extension/package.json`

**Interfaces:**
- Produces: `QwenReaderText.cleanText(text)`, `splitText(text, maxChars)`, `makeSegment(input)`.

- [ ] **Step 1: Write the failing tests**

测试必须以字面期望覆盖中文空白归一、两字符短回复保留、URL 清理和 260 字符分块；执行：

```powershell
& 'C:\Users\15300\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test extension\tests\text.test.cjs
```

预期因 `extension/shared/text.js` 不存在或接口缺失而失败。

- [ ] **Step 2: Implement minimal text helpers and MV3 shell**

`makeSegment` 返回 `{id, floor, authorId, authorName, isOp, text, sourceKey}`；`splitText`
优先在 `。！？；\n` 处分块且每块不超过 260 字符。manifest 按顺序加载共享模块和内容脚本，
后台为经典 service worker。

- [ ] **Step 3: Run the focused tests**

预期全部通过且无 warning。

### Task 2: Flarum 与普通网页正文提取

**Files:**
- Create: `extension/shared/extractors.js`
- Create: `extension/tests/extractors.test.cjs`
- Create: `extension/tests/fixtures/flarum-api.json`
- Create: `extension/tests/fixtures/generic-page.json`
- Create: `extension/tests/browser/extractor-harness.html`

**Interfaces:**
- Consumes: `QwenReaderText.cleanText`, `makeSegment`.
- Produces: `QwenReaderExtractors.parseFlarumApi(payload)`, `extractFlarum(document, fetchFn)`, `extractGeneric(document)`, `extractPage(document, fetchFn)`.

- [ ] **Step 1: Write failing parser tests**

Flarum fixture包含楼主、不同作者、仅两个汉字的短回复、点赞/回复插件文字。字面期望必须证明：
楼主识别正确、短回复存在、控件文字不存在、楼层顺序正确。

- [ ] **Step 2: Run RED**

运行 Node 测试，确认失败原因是提取接口尚未实现。

- [ ] **Step 3: Implement API parser and DOM fallbacks**

`extractFlarum` 从 URL 解析 discussion id，以 50 条一页请求
`/api/posts?filter[discussion]=ID&sort=number&page[limit]=50&page[offset]=N&include=user`，
遍历 `links.next`；失败后读取 `.Post` 和 `.Post-body`。普通页面以正文长度、段落数和链接
密度评分候选容器，并过滤设计规格中的无关元素。

- [ ] **Step 4: Run Node and browser fixture tests**

Node 测试必须全绿；浏览器测试页必须输出 `PASS`，并用 Codex 内建浏览器验证。

### Task 3: 楼主专属与多音色分配

**Files:**
- Create: `extension/shared/voice-assignment.js`
- Create: `extension/tests/voice-assignment.test.cjs`

**Interfaces:**
- Produces: `assignVoices(segments, {opVoice, replyVoices, mode})` and returns cloned segments with `voice`.

- [ ] **Step 1: Write failing assignment tests**

覆盖楼主在第 1、6 楼始终为 A、其他人永不使用 A、B/C 顺序轮换、作者稳定模式，以及
回复音色池为空时的中文错误。

- [ ] **Step 2: Run RED**

确认测试因 `assignVoices` 缺失而失败。

- [ ] **Step 3: Implement the three presets**

`op-exclusive` 默认按非楼主发言轮次轮换；`stable-author` 用首次出现顺序稳定映射；
`round-robin` 每个非楼主楼层轮换。所有模式从回复池中排除 A。

- [ ] **Step 4: Run GREEN**

运行整个 `extension/tests/*.test.cjs`，预期全部通过。

### Task 4: 本地 TTS 后台、缓存与取消

**Files:**
- Create: `extension/shared/api-client.js`
- Create: `extension/tests/api-client.test.cjs`
- Modify: `extension/background.js`

**Interfaces:**
- Produces: `createApiClient({fetchImpl, baseUrl, storage})` with `status()`, `voices()`, `ensureLocalVoices()`, `synthesize(request, signal)`, `registerVoice(profile)`.
- Background messages: `tts:status`, `tts:voices`, `tts:synthesize`, `tts:cancel`, `voice:save`, `voice:delete`, `voice:list`.

- [ ] **Step 1: Write failing boundary tests**

使用真实 `Request`/`Response` 和记录型 fake fetch，断言合成请求的 URL、model、voice、input、
WAV 格式；断言本地音色只在服务端缺失时注册；断言非 `127.0.0.1` 地址被拒绝。

- [ ] **Step 2: Run RED**

确认测试因 API 客户端缺失而失败。

- [ ] **Step 3: Implement API client and message router**

后台为每个播放 session 保存 `AbortController`；ArrayBuffer 转 base64 返回内容脚本；
错误统一为 `{ok:false,error:{code,message}}`，冷启动 fetch 超时 60 秒。

- [ ] **Step 4: Run GREEN**

运行 API focused test 和完整 Node suite。

### Task 5: 方案 A 悬浮球、侧栏与播放队列

**Files:**
- Create: `extension/content/reader.js`
- Create: `extension/content/reader.css`
- Create: `extension/shared/player-state.js`
- Create: `extension/tests/player-state.test.cjs`
- Create: `extension/tests/browser/ui-harness.html`

**Interfaces:**
- Consumes: extractors, assignment, background message contract.
- Produces: `QwenReaderPlayer.reduce(state, action)` and injected `qwen-reader-root` Shadow DOM UI.

- [ ] **Step 1: Write failing state tests**

覆盖初始播放、暂停/恢复、前进/后退边界、停止清空缓存、错误状态和当前作者/音色更新。

- [ ] **Step 2: Run RED**

确认 reducer 尚未存在。

- [ ] **Step 3: Implement reducer, audio pipeline and UI**

UI 必须复刻批准的 A 风格：紫色悬浮球、376 px 右侧面板、三个标签、楼主卡、进度、
标准 CSS 播放/暂停图形、队列作者与音色标签。当前音频播放时预取下一块；切换段落取消
旧 session；源 DOM 存在时高亮并滚动。

- [ ] **Step 4: Run automated and visual checks**

完整 Node suite 全绿；`ui-harness.html` 在 Codex 内建浏览器中确认浮球、展开、三标签、
暂停图标和 1280/390 px 响应式布局。

### Task 6: 音色录制室与本地持久化

**Files:**
- Create: `extension/voice-studio.html`
- Create: `extension/voice-studio.css`
- Create: `extension/voice-studio.js`
- Create: `extension/shared/wav.js`
- Create: `extension/tests/wav.test.cjs`

**Interfaces:**
- Produces: `QwenReaderWav.encodeMono16(samples, sourceRate, targetRate)` returning an `ArrayBuffer` with a 24 kHz mono PCM WAV.

- [ ] **Step 1: Write failing WAV tests**

使用手写 48 kHz 样本，断言 RIFF/WAVE 头、声道数 1、采样率 24000、16-bit、数据长度和
正负样本钳位。

- [ ] **Step 2: Run RED**

确认编码器缺失而失败。

- [ ] **Step 3: Implement recorder and registration UI**

用户手势触发 `getUserMedia({audio:true})`，限制 5～15 秒，ScriptProcessor 收集 PCM，
停止后编码、试听、保存并注册。禁止空名称、重名覆盖须二次确认，页面显示本地接口错误。

- [ ] **Step 4: Run GREEN and browser microphone preflight**

WAV 和完整 suite 全绿；内建浏览器验证页面加载和无麦克风情况下的明确错误。真实录音只在
用户点击时触发，不自动申请权限。

### Task 7: 构建、部署与真实 Edge 验收

**Files:**
- Create: `extension/README.md`
- Create: `package-extension.ps1`
- Create: `dist/Qwen-Reader-Edge/**`
- Modify: `README.md`

**Interfaces:**
- Produces: 可直接在 `edge://extensions` 加载的 `dist/Qwen-Reader-Edge`.

- [ ] **Step 1: Add packaging validation**

脚本在复制前解析 manifest、检查所有声明文件存在、扫描 `eval(` 和远程 `<script src>`，
失败时退出非零。

- [ ] **Step 2: Package and run full verification**

运行网关 `test.ps1`、扩展 Node suite、打包验证和 manifest JSON 解析，全部必须为零失败。

- [ ] **Step 3: Back up and deploy**

将当前已加载的 Read Aloud 目录备份为带时间戳目录，再把交付目录复制到稳定位置；不删除
用户原扩展备份。启动本地 Qwen 服务或托盘网关。

- [ ] **Step 4: Verify real flows**

在 Edge 中重新加载扩展；在 `https://bbs.viva-la-vita.org/d/23351` 验证提取、楼主 A、
短回复、B/C 切换和播放；在普通长文章验证自动正文；停止后确认 UI 和音频立即终止。

- [ ] **Step 5: Hand off**

记录加载目录、当前服务状态、快捷入口、已验证测试数量，以及尚需用户录制的额外音色。

