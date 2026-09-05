# Flowloud 使用与开发参考

[返回项目首页](../README.md) · [English](../README.en.md)

本文保留完整功能、Provider、网关、协议与开发说明。所有命令均从仓库根目录执行，除非代码块中另有 `cd`。首次使用请先阅读[首页快速开始](../README.md#快速开始)。

Flowloud / 流声是一款面向 Microsoft Edge 与 Google Chrome 的本地优先网页朗读、OCR 与翻译工具。它会识别论坛帖子、文章、小说章节、普通网页正文、图片和 PDF，并可使用系统语音、浏览器模型、本地服务或用户配置的云 API。

项目由两部分组成：

- **Edge 扩展**：识别网页、控制朗读、管理音色，并在正文中显示当前句和逐词进度。
- **本地托盘网关**：管理 Qwen3-TTS Vulkan 服务，按需加载模型，并在闲置后释放显存。

网页正文默认在浏览器本地解析，并使用 `chrome.tts` 系统语音；不会因为打开网页而自动播放、下载模型或上传正文。只有用户主动选择在线 TTS 时，正文才会发送到其配置的服务。

## 我们能实现什么

- 识别 Discourse、Flarum、NodeBB 等论坛的楼层、作者和正文，并支持 XenForo 当前页回退。
- 使用 Mozilla Readability 与通用正文提取读取新闻、博客、小说和长文章。
- 为楼主、旁白和回复作者分配不同音色，支持楼主专属、作者固定和按楼层轮换三种策略。
- 通过扩展按钮的小弹窗完成开始、暂停、上一句、下一句、本页作者配音和常用阅读设置。
- 朗读开始后可在网页边缘显示 40px 半隐藏悬浮球；悬停后播放与定位按钮从上方出现，展开按钮位于下方，点击悬浮球会展开紧凑的上一句、暂停/继续、下一句和回到正文播放器。它支持拖动吸附和位置记忆，是否显示由全局“显示网页悬浮球”开关控制。
- 长台词会沿用正文逐词时间轴，在当前词离开安全区域时平滑滑动；暂停与减少动态效果设置会同步生效。
- 在正文中显示当前句、作者、音色、句子进度和逐词高亮；用户手动滚动后不会强行抢回页面位置。
- 网页点读默认关闭；开启后也会避开链接、按钮、输入框等交互元素，避免破坏网页本来的操作。
- 在设置中心调整阅读聚焦、主题、逐词颜色、光晕和动效。
- 通过麦克风录制或上传音频创建音色，并在音色库中重命名、删除和管理音色。
- 关闭来源标签页时停止该页面的播放和合成任务。
- 使用 MV3 offscreen 文档承载播放任务，避免扩展弹窗关闭后朗读被中断。
- 通过页面导览按区域、标题、段落、列表、表格、链接、按钮、表单和图片导航与朗读，不代替用户执行网页操作。
- 从 Popup 打开文档与翻译工作台，处理当前网页、可见区域截图、粘贴文本、图片和用户选择的 PDF 页面。
- 数字 PDF 在浏览器本地提取文字；扫描页按所选 OCR Profile 顺序识别；原文/译文按稳定块 ID 双栏编辑、复制、重试和朗读。

当前重点是**正文与帖子朗读及轻量语义导览**。页面导览不点击按钮、不提交或修改表单，也不能替代 NVDA、Windows 讲述人等系统读屏工具。

## 我们是干什么用的

Flowloud 适合这些场景：

- 听论坛长帖，并用不同声音区分楼主和回复作者。
- 听新闻、博客、小说或长篇资料，同时保留正文定位。
- 在本机运行语音模型，不希望把整篇网页发送到远程 TTS SaaS。
- 为不同网站和作者快速调整音色，不反复复制文本到其他工具。
- 在阅读困难、低视力或需要听读辅助时获得基础的键盘、状态播报、减少动效和高对比度支持。

它不是网页自动化工具，也不会自动点击链接、填写表单或操作页面控件。

## 支持什么模型和接入方式

### 五种 TTS 来源

- `browser-system`：默认，使用 `chrome.tts`，无需下载或配置。
- `browser-model`：用户确认后默认从魔搭社区（ModelScope）下载固定 revision 的 Kokoro v1.1 中英权重和按需预设音色，在浏览器本地推理；Hugging Face 仅作为手动备用来源。
- `local-service`：只连接本机回环地址；首批原生适配 Flowloud Qwen、GPT-SoVITS、CosyVoice，并支持 OpenAI 本地兼容协议。
- `openai-compatible`：用户配置 HTTPS Base URL、model、voice 和 API Key，调用 `/v1/audio/speech`。
- `doubao-tts`：使用豆包语音原生单向流式协议，不伪装成 OpenAI 接口。

Provider V4 按能力声明音色、合成、传输分块、真正增量生成、取消、状态、克隆、模型管理和边界事件。所有结果携带 `providerId`、`requestId` 与结构化错误；全局播放协调器同时只允许一个可听会话，音色使用 `providerId:voiceId` 命名空间并分别记忆。

音色录制和音频导入属于“为 TTS 后端准备参考音色”的流程，不代表扩展已经兼容所有语音克隆模型。

### OCR 与翻译 API

Document/Language Provider V1 支持 OpenAI Chat Completions、OpenAI Responses、Ollama `/api/chat` 和 Flowloud 本地文档协议。设置中心提供 OpenAI、火山方舟、阿里百炼、智谱、DeepSeek、OpenRouter、Ollama 与 Flowloud 预设；OCR 和翻译可选择不同 Profile。API Key 默认只存在当前浏览器会话，远程服务必须使用 HTTPS。

Qwen 0.6B、1.7B 和更大模型通过 Ollama、vLLM/兼容服务或 Flowloud 本地网关运行，不放进浏览器扩展。网关的模型文件、模型 ID、量化和参考音频均可配置。

## 快速使用

### 1. 安装后直接使用

新安装默认使用系统语音，无需本地服务、API Key 或模型下载。只有选择本地 Qwen 时，才需要启动 `QwenTrayGateway.exe`，从托盘复制配对令牌并粘贴到设置中心。

网关默认监听 `127.0.0.1:7811`，真正的模型服务按需启动在 `127.0.0.1:7812`。默认闲置 10 分钟后结束模型进程并释放显存。

### 2. 生成可加载的扩展目录

```powershell
.\package-extension.ps1
```

输出目录为 `dist\Flowloud-Edge`。

### 3. 在正常使用的 Edge 中加载

1. 打开 `edge://extensions/`。
2. 启用“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择本项目的 `dist\Flowloud-Edge` 目录。
5. 刷新之前已经打开的网页。

后续代码更新后，只需重新运行 `package-extension.ps1`，再到 `edge://extensions/` 点击本扩展的“重新加载”，最后刷新目标网页。无需更换浏览器用户环境。

### 4. 开始朗读

1. 打开一篇文章、小说章节或论坛帖子。
2. 点击浏览器工具栏中的 Flowloud / 流声图标。
3. 等待弹窗显示已识别的段落数量。
4. 点击“开始朗读”。
5. 弹窗关闭后朗读会继续；如已开启“显示网页悬浮球”，网页边缘会继续显示小球播放入口。

也可以使用 `Alt+O` 播放或暂停当前页面。

### 5. 添加和分配音色

- 在 Popup 点击“设置”。
- 进入“音色与克隆”。
- 使用麦克风录制 5～15 秒参考音频，或批量上传本地音频。
- 保存音色后，在全局配音策略或 Popup 的“本页配音”中分配给作者。

“本页配音”只影响当前网页；关闭或导航离开该标签页后不会污染其他页面的全局设置。

## 界面说明

- **工具栏 Popup**：开始/暂停、上一句/下一句、朗读速度、语音来源和全局网页交互快捷开关；Popup 只承载即时控制。
- **本页配音编辑器**：从 Popup 打开独立页面，调整当前网页的作者音色，不把长作者列表塞进瞬时小窗。
- **网页悬浮球**：由全局“显示网页悬浮球”开关决定是否显示；支持拖动到页面两侧、贴边收缩并记住位置。
- **正文提示**：当前句标记、作者与音色提示、逐词动画和“回到朗读位置”。
- **设置中心**：阅读聚焦、主题、逐词样式、全局配音和音色管理。

## 基础无障碍行为

- 所有扩展控制使用键盘可聚焦的原生按钮、选择框和输入框。
- 播放、暂停、加载和错误状态提供可被辅助技术识别的状态文本。
- Popup 的轮询更新不会重建滚动容器，也不会持续重置当前键盘焦点。
- 支持 `prefers-reduced-motion` 与 Windows 强制颜色模式。
- 网页点读默认关闭，且不会拦截链接、按钮、表单、媒体和代码块的原始点击行为。
- 正文高亮和滚动跟随不会主动抢占网页键盘焦点。

## 兼容性与限制

- 主要验证环境：Windows、Microsoft Edge、Manifest V3。
- Chromium 系浏览器理论上可使用相同扩展 API，但当前交付和说明以 Edge 为准。
- 支持普通 `http://` 和 `https://` 页面；浏览器内部页面、扩展商店和受限制页面无法注入内容脚本。
- 浏览器只支持固定 revision 的 Kokoro v1.1 中英模型；它使用预设音色，不提供声音克隆。
- 图片和扫描 PDF 需要用户配置支持视觉的本地服务或云 API；扩展不内置 OCR 权重。
- XenForo 目前只保证当前已经加载的楼层。
- 后端的“流式”可能是先完成整段 WAV，再通过 HTTP 分块传输，并不等于模型逐帧生成。
- 音频上传转写使用浏览器可用的语音识别能力；支持情况取决于 Edge、系统权限和语言环境。

## 托盘网关命令

```powershell
.\QwenTrayGateway.exe
.\QwenTrayGateway.exe --load
.\QwenTrayGateway.exe --unload
.\QwenTrayGateway.exe --exit
```

托盘菜单提供立即加载模型、立即卸载模型、自动卸载开关、日志目录、开机启动和完全退出。

## 构建和测试

```powershell
.\test.ps1
cd extension
npm test
cd ..
.\package-extension.ps1
```

### 前端快速预览（无需反复打包或手动重载页面）

新前端位于 `extension-wxt/`，使用 WXT、React Aria Components 和 Storybook。Node.js 需要 22 或更高版本。

```powershell
cd extension-wxt
pnpm install
pnpm storybook
```

Storybook 默认打开 `http://127.0.0.1:6006`，可以独立预览 Popup、40px 半隐藏悬浮球、设置中心、本页配音、页面导览和音色工作室，并在保存文件后热更新。

需要验证扩展 Popup 与浏览器 API 桥接时运行：

```powershell
pnpm dev
```

然后只需在浏览器扩展管理页加载一次 `extension-wxt/.output/chrome-mv3-dev`；WXT 会持续构建并热更新前端。详细迁移边界与发布闸门见 `docs/frontend-migration.md`。

## 流式 TTS 协议

流式请求沿用 `/v1/audio/speech` 的 JSON body：

```http
POST /v1/audio/speech/stream HTTP/1.1
X-Qwen-Reader-Client: qwen-reader-extension-v1
X-Qwen-Request-Id: req-123
X-Qwen-Playback-Id: play-123
Content-Type: application/json
```

网关返回 `Transfer-Encoding: chunked` 和 `Content-Type: audio/wav`。chunk 内容是 WAV 字节，不是 base64 或 NDJSON。响应能力字段会区分传输分块、浏览器渐进播放和模型后端增量生成。

取消请求：

```http
POST /v1/audio/speech/cancel
X-Qwen-Reader-Client: qwen-reader-extension-v1
Content-Type: application/json

{"request_id":"req-123","playback_id":"play-123"}
```

状态查询为 `GET /v1/audio/speech/status/{requestId}`。同时提供 request ID 和 playback ID 时，网关会执行严格配对校验，避免一个页面取消另一个页面的任务。

## 目录结构

- `src/`：Windows 托盘网关、HTTP/TCP 网关和模型进程生命周期管理。
- `extension/`：Edge 扩展源码、共享阅读逻辑、Provider、音色和测试。
- `extension-wxt/`：WXT + React Aria 新前端、Storybook 状态矩阵和热更新开发环境。
- `dist/Flowloud-Edge/`：可直接在正常 Edge 中加载的扩展目录。
- `tests/`：网关和端口冲突测试。
- `docs/`：设计文档和可复现测试页面。

## 隐私与安全边界

- 网关和模型服务只绑定 `127.0.0.1`，不向局域网或公网开放。
- 加载、卸载和退出管理接口使用本地随机令牌。
- 本项目不包含模型权重、Vulkan 驱动、第三方服务凭据或浏览器用户数据。
- Mozilla Readability 和图标资源的许可见[扩展许可证](../extension/LICENSE)、[第三方声明](../THIRD_PARTY_NOTICES.md)与 [Readability 许可证](../extension/vendor/readability/LICENSE.md)。
