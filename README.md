# Qwen 网页朗读（Qwen Reader）

Qwen Reader 是一套面向 Windows 本地运行的网页朗读工具：由轻量托盘网关管理本机 Qwen3-TTS Vulkan 服务，并通过 Microsoft Edge Manifest V3 扩展把论坛、小说、长文章和普通网页转换成可控制、可追踪的多音色朗读。

它的设计目标是“本地优先、按需加载、可中断、可扩展”：浏览器只连接回环地址，模型默认不常驻显存；阅读内容在浏览器端提取和分段，音频由本机 TTS 服务生成。

## 能实现什么

- 在网页上自动识别正文、论坛楼层、小说章节和长文章，并支持“读取本页 / 重新读取”，不会自动开始播放。
- 使用 Mozilla Readability 提取文章正文，并在通用 DOM 回退策略下处理非标准页面。
- 适配 Discourse、Flarum、NodeBB，以及当前页可识别的 XenForo 内容；同一套归一化文档模型也支持通用网页扩展。
- 为楼主和回复分配不同音色，支持音色轮换、音色库、音色命名和本地录音室。
- 提供悬浮球、右侧阅读栏、播放/暂停/跳转/停止，以及句子、单词和页面焦点跟随效果。
- 支持本地音频导入、录音、转写相关能力，以及按句/按词的时间线和高亮同步。
- 通过 MV3 offscreen 文档承载长时间合成任务，降低 service worker 在模型冷启动或长音频生成期间提前终止的风险。
- 通过流式传输、取消、状态查询和 request/playback ID 管理播放会话。

## 兼容性

- 浏览器：Microsoft Edge Manifest V3；代码使用 Chromium MV3 扩展 API，理论上也适用于支持相同 API 的 Chromium 浏览器，但本项目当前以 Edge 的 `edge://extensions/` 加载和验证为准。
- 页面：`http://` 和 `https://` 页面；Google 登录 iframe 被排除。论坛适配器覆盖 Discourse、Flarum、NodeBB，并对 XenForo 和普通 DOM 页面提供回退。
- 运行环境：Windows 本机；托盘网关使用系统自带的 .NET Framework 4 编译器构建，不要求额外 .NET SDK。
- TTS 后端：本机 Qwen3-TTS Vulkan 服务。网关通过 `127.0.0.1:7811/v1` 对扩展提供稳定入口，并按需在 `127.0.0.1:7812` 启动真正的模型服务。
- 模型与 Vulkan 驱动：需要用户自行准备可用的 Qwen3-TTS Vulkan 后端、模型文件和兼容的 Vulkan 驱动；本仓库不打包模型权重。

当前版本号见 `extension/manifest.json` 和 `extension/package.json`。扩展不依赖远程 SaaS 才能完成基本朗读，但具体音色、转写或云端能力取决于配置的 provider 和服务是否可用。

- Edge 继续使用 `http://127.0.0.1:7811/v1`。
- 真正的 Vulkan 模型服务仅在需要时启动于 `127.0.0.1:7812`。
- `POST /v1/audio/speech/stream` 提供标准 HTTP/1.1 chunked WAV 传输；当前 `qwentts.cpp` 后端仍是整段生成，健康能力会明确报告 `backendIncrementalGeneration: false`。
- 默认闲置 10 分钟后结束模型进程并释放显存。
- “邵思萌”和兼容别名 `qwen-clone` 会在每次加载时自动注册。
- 所有监听仅绑定回环地址；加载、卸载、退出管理接口需要本地随机令牌。

## 托盘菜单

- 立即加载模型
- 立即卸载模型
- 开关 10 分钟自动卸载
- 打开日志目录
- 开关开机自动启动
- 完全退出

## 命令

```powershell
.\QwenTrayGateway.exe
.\QwenTrayGateway.exe --load
.\QwenTrayGateway.exe --unload
.\QwenTrayGateway.exe --exit
```

## 构建和测试

使用系统自带的 .NET Framework 4 编译器，不需要安装额外 SDK：

```powershell
.\test.ps1
```

`tests\PortConflictTest.ps1` 需要测试端口已被另一个进程占用，用于验证网关会静默失败且不会结束未知进程。

## Edge 扩展

`extension\` 是配套的 Qwen 网页朗读扩展源码，包含：

- 自动扫描但不自动播放，并提供“读取本页 / 重新读取”；
- Discourse、Flarum、NodeBB API 适配和 XenForo 当前页适配；
- Mozilla Readability 长文章/小说提取与通用 DOM 回退；
- 楼主专属音色与回复音色轮换；
- 方案 A 悬浮球和右侧栏；
- 本地音色录制室；
- MV3 offscreen 长合成运行时，避免模型冷启动时 service worker 被提前终止。

构建交付目录：

```powershell
.\package-extension.ps1
```

输出为 `dist\Qwen-Reader-Edge`，可在 `edge://extensions/` 中加载。

加载步骤：打开 `edge://extensions/`，启用“开发人员模式”，选择“加载解压缩的扩展”，指向 `dist\Qwen-Reader-Edge`。先启动托盘网关，再在网页上点击扩展按钮或使用 `Alt+O` 打开侧栏。

当前用户桌面已提供“启动 Qwen 网页朗读”和“停止 Qwen 网页朗读（释放显存）”；
登录启动项只启动轻量网关，不会预加载模型或占用显存。

## 流式 TTS 协议

流式请求仍然使用原 `/v1/audio/speech` 的 JSON body，只需改为：

```http
POST /v1/audio/speech/stream HTTP/1.1
X-Qwen-Reader-Client: qwen-reader-extension-v1
X-Qwen-Request-Id: req-123
X-Qwen-Playback-Id: play-123
Content-Type: application/json
```

网关返回 `Transfer-Encoding: chunked`、`Content-Type: audio/wav`，chunk 内容是 WAV 字节本身，不是 base64 或 NDJSON。响应会带回两个 ID、`X-Qwen-Stream-Mode: wav-transport-chunked` 和 `X-Qwen-Backend-Incremental-Generation: false`。这表示模型先完成整段 WAV，网关随后边读边发送；它不是模型 token/音频级增量生成。最后的 HTTP trailer 为 `X-Qwen-Stream-Status: completed|cancelled|failed`，失败时另有 `X-Qwen-Stream-Error`。

取消和状态查询均只允许回环地址并要求固定客户端标头：

```http
POST /v1/audio/speech/cancel
X-Qwen-Reader-Client: qwen-reader-extension-v1
Content-Type: application/json

{"request_id":"req-123","playback_id":"play-123"}
```

取消会立即中止对应的后端 HTTP 请求，并返回 `202 cancellation_requested`；若没有活动请求则返回 `404 request_not_found`。同时提供 request ID 和 playback ID 时，两者必须属于同一条流，否则返回 `409 request_id_mismatch`，不会取消任何会话。状态查询为 `GET /v1/audio/speech/status/{request_id}`（也可使用 playback ID），返回 `active`、`completed`、`cancelled` 或 `failed` 及已发送字节数；若额外发送两个 ID 标头，同样执行严格配对校验。`GET /health` 和 `/gateway/status` 的 `capabilities`、`limits` 字段用于协商流式端点、取消能力和并发/超时/字节上限。

## 目录结构

- `src/`：Windows 托盘网关、HTTP/TCP 网关和模型进程生命周期管理。
- `extension/`：Edge 扩展源码、共享阅读逻辑、provider、音色和测试。
- `dist/Qwen-Reader-Edge/`：可直接加载的扩展交付目录，由 `package-extension.ps1` 生成。
- `tests/`：网关和端口冲突等 PowerShell/C# 测试。
- `docs/`：设计文档、计划和可复现的 UI/阅读效果测试页面。

## 安全边界与限制

- 网关和模型服务只绑定 `127.0.0.1`，不对局域网或公网开放。
- 加载、卸载和退出管理接口需要本地随机令牌；扩展到网关的请求还要求固定客户端标头。
- “流式”目前是 WAV 的 HTTP chunked 传输：后端仍可能先完成整段音频生成，健康状态会报告 `backendIncrementalGeneration: false`；这不是 token 级或音频帧级增量生成。
- 本项目不包含 Qwen 模型权重、Vulkan 驱动、第三方服务凭据或浏览器自动化缓存。
- `extension/vendor/readability/` 和图标资源带有各自的第三方许可说明，请同时阅读 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`。

## 开发验证

运行网关测试：

```powershell
.\test.ps1
```

运行扩展 Node.js 单元测试：

```powershell
cd extension
npm test
```

浏览器 harness 和审计页面位于 `extension/tests/browser/` 与 `docs/`；它们用于本地验证，不应把浏览器 profile、Crashpad、Cache 或生成的 WAV/截图提交到版本库。
