# Flowloud / 流声

Flowloud / 流声是一款面向 Microsoft Edge 与 Google Chrome 的本地优先网页朗读工具。它会识别论坛帖子、文章、小说章节和普通网页正文，并可使用系统语音、浏览器模型、Windows 本地 Qwen 或用户配置的在线 TTS。

项目由两部分组成：

- **Edge 扩展**：识别网页、控制朗读、管理音色，并在正文中显示当前句和逐词进度。
- **本地托盘网关**：管理 Qwen3-TTS Vulkan 服务，按需加载模型，并在闲置后释放显存。

网页正文默认在浏览器本地解析，并使用 `chrome.tts` 系统语音；不会因为打开网页而自动播放、下载模型或上传正文。只有用户主动选择在线 TTS 时，正文才会发送到其配置的服务。

## 我们能实现什么

- 识别 Discourse、Flarum、NodeBB 等论坛的楼层、作者和正文，并支持 XenForo 当前页回退。
- 使用 Mozilla Readability 与通用正文提取读取新闻、博客、小说和长文章。
- 为楼主、旁白和回复作者分配不同音色，支持楼主专属、作者固定和按楼层轮换三种策略。
- 通过扩展按钮的小弹窗完成开始、暂停、上一句、下一句、本页作者配音和常用阅读设置。
- 朗读开始后可在网页右下角显示悬浮播放器；它会展示加载文本、加载模型、合成、播放、暂停和错误状态，支持拖动吸附、位置记忆、最小化和回到当前朗读位置。是否显示由扩展 Popup 中的“网页悬浮窗”开关控制。
- 长台词会沿用正文逐词时间轴，在当前词离开安全区域时平滑滑动；暂停与减少动态效果设置会同步生效。
- 在正文中显示当前句、作者、音色、句子进度和逐词高亮；用户手动滚动后不会强行抢回页面位置。
- 网页点读默认关闭；开启后也会避开链接、按钮、输入框等交互元素，避免破坏网页本来的操作。
- 在设置中心调整阅读聚焦、主题、逐词颜色、光晕和动效。
- 通过麦克风录制或上传音频创建音色，并在音色库中重命名、删除和管理音色。
- 关闭来源标签页时停止该页面的播放和合成任务。
- 使用 MV3 offscreen 文档承载播放任务，避免扩展弹窗关闭后朗读被中断。
- 通过页面导览按区域、标题、段落、列表、表格、链接、按钮、表单和图片导航与朗读，不代替用户执行网页操作。

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

### 四种内置来源

- `browser-system`：默认，使用 `chrome.tts`，无需下载或配置。
- `browser-model`：用户确认后从 Hugging Face 下载固定 revision 的中文 VITS 或英文 Kokoro，在浏览器本地推理。
- `local-qwen`：连接 `http://127.0.0.1:7811`，需要托盘网关配对令牌；模型权重不纳入 Git。
- `openai-compatible`：用户配置 HTTPS Base URL、model、voice 和 API Key，调用 `/v1/audio/speech`。

Provider V3 按能力声明 `health`、`voices`、`synthesize`、`play`、`pause`、`resume`、`cancel` 和 `modelManagement`。全局只激活一个 Provider，音色使用 `providerId:voiceId` 命名空间并分别记忆。

音色录制和音频导入属于“为 TTS 后端准备参考音色”的流程，不代表扩展已经兼容所有语音克隆模型。

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
5. 弹窗关闭后朗读会继续；如已开启“网页悬浮窗”，网页右下角会继续显示播放状态和控制按钮。

也可以使用 `Alt+O` 播放或暂停当前页面。

### 5. 添加和分配音色

- 在 Popup 点击“设置”。
- 进入“音色与克隆”。
- 使用麦克风录制 5～15 秒参考音频，或批量上传本地音频。
- 保存音色后，在全局配音策略或 Popup 的“本页配音”中分配给作者。

“本页配音”只影响当前网页；关闭或导航离开该标签页后不会污染其他页面的全局设置。

## 界面说明

- **工具栏 Popup**：开始/暂停、上一句/下一句、网页点读、作者配音策略、本页作者音色和设置入口。
- **网页悬浮播放器**：由 Popup 中的“网页悬浮窗”开关决定是否显示；支持完整和最小化两种状态，可拖动到页面两侧并记住位置。
- **正文提示**：当前句标记、作者与音色提示、逐词动画和“回到朗读位置”。
- **设置中心**：阅读聚焦、主题、逐词样式、全局配音和音色管理。

## 基础无障碍行为

- 所有扩展控制使用键盘可聚焦的原生按钮、选择框和输入框。
- 播放、暂停、加载和错误状态提供可被辅助技术识别的状态文本。
- Popup 的轮询更新不会持续重置当前键盘焦点。
- 支持 `prefers-reduced-motion` 与 Windows 强制颜色模式。
- 网页点读默认关闭，且不会拦截链接、按钮、表单、媒体和代码块的原始点击行为。
- 正文高亮和滚动跟随不会主动抢占网页键盘焦点。

## 兼容性与限制

- 主要验证环境：Windows、Microsoft Edge、Manifest V3。
- Chromium 系浏览器理论上可使用相同扩展 API，但当前交付和说明以 Edge 为准。
- 支持普通 `http://` 和 `https://` 页面；浏览器内部页面、扩展商店和受限制页面无法注入内容脚本。
- 当前只内置本地 Qwen Provider，不包含模型权重。
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
- `dist/Flowloud-Edge/`：可直接在正常 Edge 中加载的扩展目录。
- `tests/`：网关和端口冲突测试。
- `docs/`：设计文档和可复现测试页面。

## 隐私与安全边界

- 网关和模型服务只绑定 `127.0.0.1`，不向局域网或公网开放。
- 加载、卸载和退出管理接口使用本地随机令牌。
- 本项目不包含模型权重、Vulkan 驱动、第三方服务凭据或浏览器用户数据。
- Mozilla Readability 和图标资源的许可见 `LICENSE`、`THIRD_PARTY_NOTICES.md` 与 `extension/vendor/readability/LICENSE.md`。
