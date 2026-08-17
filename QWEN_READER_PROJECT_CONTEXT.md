# Qwen 网页朗读项目：完整背景、架构与 AI 交接文档

> 文档用途：把本文件交给一个完全不了解历史、没有看过对话、尚未阅读代码的 AI 或开发者，使其能快速理解项目目标、当前实现、运行方式、关键约束、源码位置、测试方式和后续开发边界。
>
> 当前状态基准：2026-08-17，Edge 扩展版本 `0.5.2`。

---

## 1. 一句话概述

这是一个运行在 Windows 11 + Microsoft Edge 上的完全本地网页朗读系统：浏览器扩展自动识别论坛、小说、新闻和长文章的正文，区分楼主与回复作者，为不同作者动态分配不同克隆音色，然后通过本机 `qwentts.cpp` Vulkan 后端和 Qwen3-TTS 1.7B Base Q8 模型合成语音。

它不是单纯的“选中文字后朗读”插件，而是由以下两部分组成：

1. **Edge Manifest V3 扩展**：负责正文提取、论坛作者识别、多音色调度、播放队列、点读、高亮、音色录制与批量导入。
2. **Windows 托盘网关**：负责按需启动/停止 Vulkan 模型、代理 OpenAI 风格 TTS API、闲置自动释放显存，并提供类似 Ollama 的托盘控制体验。

核心设计目标是：

- 不需要用户手动选择文字；
- 论坛中楼主保持专属音色，其他作者使用有限音色池轮换；
- 不朗读点赞、签名、按钮、图片尺寸、裸链接、广告等网页杂项；
- 支持逐句高亮、自动定位和直接点击正文跳转朗读；
- 所有 TTS 正文和克隆音频只发送到本机 `127.0.0.1`；
- 不朗读时模型自动卸载，避免影响游戏显存和性能。

---

## 2. 用户环境与已验证后端

当前主要使用环境：

- 操作系统：Windows 11
- 浏览器：Microsoft Edge
- GPU：AMD Radeon RX 9070 XT，16GB 显存
- GPU 推理后端：Vulkan
- TTS 运行器：`ServeurpersoCom/qwentts.cpp`
- 模型：Qwen3-TTS 1.7B Base Q8 GGUF
- Talker 模型文件名：`qwen-talker-1.7b-base-Q8_0.gguf`
- Codec/Tokenizer 文件名：`qwen-tokenizer-12hz-Q8_0.gguf`
- 模型别名：`qwen3-tts-1.7b-base`
- 语言：`Chinese`

早期曾尝试官方 Qwen Python + Windows ROCm PyTorch。虽然 PyTorch 能识别 RX 9070 XT，但实际生成会立即 EOS，输出约 0.16 秒静音，因此该路线已被废弃并清理。当前可靠路线是 `qwentts.cpp + Vulkan`，已经实际在 RX 9070 XT 上生成过非静音中文 WAV。

已测得模型热加载时大致占用：

- 专用显存约 4.1GB；
- 工作内存约 2.3GB；
- 模型不运行时，轻量网关不占用 GPU；
- 闲置 10 分钟后模型进程自动结束并释放显存。

---

## 3. 总体架构

```text
网页 / 论坛 / 小说
        │
        ▼
Edge Content Script
  ├─ 识别站点类型
  ├─ 提取正文、作者、楼层、楼主身份
  ├─ 统一为 NormalizedDocument / Block
  ├─ 文本清理与逐句分块
  ├─ 为每个句子分配 voice
  ├─ 点读、队列、高亮、滚动跟随
  └─ 发送 tts:synthesize 消息
        │
        ▼
MV3 Service Worker（background.js）
  ├─ 消息路由
  ├─ 音色存储事务
  ├─ 创建/复用 Offscreen Document
  └─ 取消、超时和错误封装
        │
        ▼
Offscreen Document（offscreen.js）
  ├─ 长时间 fetch 不受 service worker 生命周期影响
  ├─ 同步浏览器本地音色到后端
  ├─ 调用 localhost TTS
  └─ WAV Blob → Base64，返回给页面播放器
        │
        ▼
127.0.0.1:7811 — QwenTrayGateway
  ├─ 校验扩展客户端标头
  ├─ 检测模型是否已加载
  ├─ 冷启动 Vulkan 后端
  ├─ 转发请求到 127.0.0.1:7812
  └─ 闲置 10 分钟后结束后端
        │
        ▼
127.0.0.1:7812 — qwentts.cpp tts-server.exe
        │
        ▼
RX 9070 XT / Vulkan / Qwen3-TTS Q8
```

---

## 4. Windows 托盘网关

### 4.1 职责

托盘网关是一个使用 C# 和系统自带 .NET Framework 4 编译的小型 Windows Forms 程序，产物为：

```text
build/QwenTrayGateway.exe
```

它做四件事：

1. 常驻监听 `127.0.0.1:7811`；
2. 第一次语音或音色请求到来时，启动 `tts-server.exe` 到 `127.0.0.1:7812`；
3. 代理后端响应，不改变 Edge 扩展的 API 地址；
4. 连续闲置 10 分钟后结束模型进程，释放显存。

### 4.2 主要配置

配置文件名为 `gateway.json`，与 `QwenTrayGateway.exe` 部署在同一运行目录。默认字段：

```json
{
  "GatewayHost": "127.0.0.1",
  "GatewayPort": 7811,
  "BackendPort": 7812,
  "BackendExecutable": "<runtime>/bin/tts-server.exe",
  "ModelPath": "<runtime>/models/qwen-talker-1.7b-base-Q8_0.gguf",
  "CodecPath": "<runtime>/models/qwen-tokenizer-12hz-Q8_0.gguf",
  "ModelAlias": "qwen3-tts-1.7b-base",
  "Language": "Chinese",
  "IdleMinutes": 10,
  "AutoUnload": true,
  "BackendStartTimeoutSeconds": 60,
  "VoiceReferenceWav": "<runtime>/voices/邵思萌/reference.wav",
  "VoiceName": "邵思萌",
  "VoiceAlias": "qwen-clone",
  "ManagementToken": "随机本地令牌",
  "LogDirectory": "<runtime>/logs"
}
```

### 4.3 API 行为

无需加载模型即可调用：

- `GET /health`
- `GET /gateway/status`

会自动加载模型并转发到 7812：

- `POST /v1/audio/speech`
- `GET /v1/models`
- `GET /v1/audio/voices`
- `POST /v1/audio/voices`
- `DELETE /v1/audio/voices/{name}`

管理接口：

- `POST /gateway/load`
- `POST /gateway/unload`
- `POST /gateway/exit`

管理接口必须携带：

```http
X-Qwen-Gateway-Token: <gateway.json 中的 ManagementToken>
```

所有会接触真正 TTS 后端的普通请求必须携带：

```http
X-Qwen-Reader-Client: qwen-reader-extension-v1
```

如果缺少这个标头，网关会返回：

```text
A trusted Qwen Reader client header is required.
```

这不是模型错误，而是本地网关的安全边界。扩展的 `shared/api-client.js` 已经自动添加该标头；用其他客户端直接调用时必须自行添加。

### 4.4 进程安全

- 网关只监听回环地址，不开放局域网访问；
- 后端端口如果已被未知进程占用，网关报错，不会强行杀进程；
- 停止模型前会核对实际可执行文件路径是否与配置中的 `tts-server.exe` 一致；
- 有语音请求进行时不会自动卸载；
- 模型启动失败、60 秒内未健康或音色注册失败时，会停止失败进程并返回明确错误。

### 4.5 托盘菜单和命令行

托盘菜单：

- 当前状态；
- 立即加载模型；
- 立即卸载模型；
- 开启/关闭 10 分钟自动卸载；
- 打开日志目录；
- 开启/关闭开机自动启动；
- 完全退出网关和模型。

命令行：

```powershell
QwenTrayGateway.exe
QwenTrayGateway.exe --load
QwenTrayGateway.exe --unload
QwenTrayGateway.exe --exit
QwenTrayGateway.exe --no-tray
QwenTrayGateway.exe --config C:\path\gateway.json
```

程序用命名互斥量保证 7811 网关只有一个实例。

---

## 5. Edge 扩展

### 5.1 基本信息

- 名称：Qwen 网页朗读
- 当前版本：`0.5.2`
- 规范：Manifest V3
- 主浏览器：Microsoft Edge
- 快捷键：`Alt+O`
- 后端地址：`http://127.0.0.1:7811`
- 权限：`storage`、`unlimitedStorage`、`offscreen`
- Host Permission：仅 `http://127.0.0.1:7811/*`
- Content Script：注入全部 HTTP/HTTPS 网页，但外部语音请求只发给本机网关。

### 5.2 页面 UI

当前 UI 采用附着于原网页的轻量阅读器，而不是把网页重排为独立阅读模式：

- 一个无背景圆、无按钮外框的品牌小图标；
- 图标可以拖动，松手后自动吸附到浏览器窗口左边或右边；
- 记录左右边缘和归一化纵向位置，窗口改变后仍能恢复合理位置；
- 右侧紧凑侧栏，可拖动侧边缘调整宽度；
- 三个标签页：正在朗读、作者配音、音色库；
- 播放、暂停、停止、上一句、下一句；
- 当前队列、当前作者、当前音色和进度；
- 点读开关使用可访问的滑动 Switch，而不是裸复选框。

### 5.3 高亮和点读

- 使用精确 DOM Range 将朗读队列中的句子映射回原网页；
- 优先使用 CSS Custom Highlight API：`qwen-reader-current`；
- 高亮视觉是文字边缘扩散光，不是矩形背景块；
- 如果浏览器不支持 Custom Highlight，则退回 `.qwen-reader-speaking`；
- 当前句会尽量滚动到屏幕中间；
- 用户滚轮、触摸滑动、翻页键或拖动滚动条后，进入“手动浏览”状态，不继续抢滚动；
- 用户点击“回到朗读位置”后才恢复自动跟随；
- 点读开启时，悬浮正文会显示极简音色和播放标记；
- 点读关闭时，鼠标悬浮不显示角色名或播放按钮；正在实际播放时仍保留当前句状态标记；
- 点击正文某一句，可以从该句开始播放；
- DOM 动态替换、虚拟列表刷新或滚动后旧节点失效时，会重建 Source Locator；
- 页面上无关的旧文字选区不会阻止点读，只有点击落在当前选区内部时才跳过。

### 5.4 自动扫描但不自动播放

扩展加载页面后会自动扫描并构建队列，但绝不会自动发声。用户需要主动点击播放。

侧栏提供：

- `读取本页`：使用现有或刚生成的队列开始朗读；
- `重新读取`：取消旧扫描、旧预取和旧音频，重新提取当前页面；
- SPA 站内换帖、`pushState`、`replaceState`、`popstate`、Hash 路由和动态内容变化会触发重新识别；
- 播放过程中出现动态楼层时不会立即打断，停止后再合并/重新扫描。

---

## 6. 内容提取系统

### 6.1 为什么不能只用 Mozilla Readability

Mozilla Readability 适合新闻、博客、小说和单作者长文章，但它的数据模型只有一篇 article 和一个 byline，不能表达：

- 多个帖子；
- 多个作者；
- 楼层；
- 楼主身份；
- 两三个字的短回复；
- 回复之间的音色分配。

因此扩展采用“论坛专用适配器优先，Readability 作为文章回退”的架构。

### 6.2 适配器优先级

大致顺序：

1. Flarum
2. Discourse（LinuxDo 属于此类）
3. NodeBB
4. XenForo
5. Mirror/Card 风格论坛（例如特定 `.mm-post .card-body` 页面）
6. Mozilla Readability
7. 通用 DOM 正文算法
8. 显式选区模式（只在主动要求时使用，普通扫描不会因为页面存在选区而退化成选区朗读）

### 6.3 各论坛策略

#### Flarum

- 优先同源 JSON:API；
- 跟随分页并补全楼层；
- API 不可用时使用 DOM 回退；
- 保留同一帖子内的自然段；
- 首帖作者之后的发言仍标记为楼主；
- 匿名作者用用户名、楼层等可用信息建立稳定身份，避免所有匿名用户合并。

#### Discourse

- 识别 `/t/.../{topicId}`；
- 读取主题 JSON；
- 根据 `post_stream.stream` 补取初始 JSON 中缺失的帖子；
- 使用 `post_number` 作为楼层；
- 使用主题首帖作者判断 OP，而不是只判断第一段队列；
- 保留短回复和自然段。

#### NodeBB

- 通过页面路径对应的 `/api/...` JSON 获取主题；
- 即使用户从第 2 页进入，也从 canonical topic API 开始补全；
- 自动跟随分页并去重；
- 当前设置最多读取 100 页，超过时 `complete=false` 并产生警告。

#### XenForo

- 普通用户无法使用需要管理员 API Key 的正式 REST API，因此主要使用 DOM；
- 当前只保证浏览器当前已加载页面中的楼层；
- 会移除引用、签名、操作栏和反应区域；
- 结果应明确表现为“当前页提取”，不能虚假宣称整个主题已完整读取。

#### Mirror/Card 论坛

- 识别卡片式楼层容器；
- 支持正文仅由 `<br>` 分隔、没有 `<p>` 的页面；
- 多个视觉段落可以共享一个源容器，再通过精确文字 Range 定位。

### 6.4 内容过滤

提取策略以“正文允许列表”为主，而不是先复制整个楼层再猜测删除。会过滤：

- 图片、图片尺寸、附件文件名和图片元数据；
- 裸 URL；
- 点赞、回复、举报、编辑等操作按钮；
- 引用的旧回复；
- 签名；
- 反应、徽章、导航；
- 广告和推荐区域；
- 隐藏元素、脚本、样式、表单控件。

带有可读描述文字的链接会保留描述文字；纯 URL 被移除。

论坛短回复不能按长度过滤。`顶`、`嗯`、`1`、`同意` 都是合法内容。

---

## 7. 统一内容数据模型

所有适配器最终都产生统一文档，播放器不需要知道来源站点。

简化结构：

```js
NormalizedDocument = {
  url: string,
  pageKey: string,
  title: string,
  kind: "forum" | "article" | "selection",
  adapterId: string,
  blocks: NormalizedBlock[],
  complete: boolean,
  warnings: string[],
  stats: object
}

NormalizedBlock = {
  id: string,
  type: "paragraph" | "article" | "selection",
  text: string,
  authorId: string,
  authorName: string,
  floor: number | null,
  isOp: boolean,
  postId: string,
  sourceKey: string,
  sourceSelector: string,
  sourceLocator: {
    adapter: string,
    containerSelector: string,
    unitIndex: number,
    fingerprint: string
  } | null
}
```

`sourceLocator` 是高亮和点读的关键：

- `containerSelector` 找回楼层正文容器；
- `unitIndex` 表示原本的视觉段落序号；
- `fingerprint` 用清理后的文字定位，即使 DOM 顺序变化仍尽量匹配原段落；
- 多个 `<br>` 段落可共享同一个容器，再由 `sentence-range.js` 找到精确文本节点边界。

---

## 8. 文本分段与标点保护

TTS 最大默认分块长度为 260 字符。分段优先考虑：

- 自然段换行；
- 中文句末标点 `。！？；`；
- 最大长度边界。

连续句末标点会作为一个标点簇附着在前一句，而不是每个句号生成一个 TTS 请求。例如：

```text
正文。。。。。。下一句。
```

应该得到两段可朗读文本，而不是 `正文。` 加五个独立 `。`。

纯标点片段会在三个位置被防御性过滤：

1. `splitText()` 不输出纯标点；
2. `toPlaybackSegments()` 再过滤；
3. 播放器遇到历史/异常队列时继续跳过不可朗读项。

发送给 TTS 前，`prepareSpeechText()` 会柔化异常重复标点，但原始 `segment.text` 保留，用于网页精确高亮。

---

## 9. 多作者、多音色分配

### 9.1 不可违反的核心规则

1. 楼主音色 A 只属于楼主；
2. 其他作者绝不能使用 A；
3. 同一个帖子被切成多个音频片段时，中途不能换音色；
4. 单作者文章和选区使用主讲/楼主音色，不需要伪造多作者；
5. 音色可以按请求切换，不需要重启模型。

默认：

```text
楼主音色：邵思萌
回复音色池：qwen-clone
```

如果两者映射同一参考音频，系统可以工作，但不同作者听起来不会有明显差异。用户可在音色录制室增加更多音色。

### 9.2 三种预设

#### 楼主专属（`op-exclusive`）

- 楼主始终使用 A；
- 其他连续作者从 B/C/D 音色池依次分配；
- 同一作者连续楼层或同一帖子切片保持当前音色。

#### 作者稳定（`stable-author`）

- 同一个回复作者在整个主题内始终使用同一个非楼主音色；
- 作者数量大于音色数量时允许复用。

#### 顺序轮换（`round-robin`）

- 按回复帖子顺序使用 B/C/D/B/C/D；
- 同一帖子切片不换音色；
- 不强调作者长期稳定。

---

## 10. 播放、预取、取消与 MV3 生命周期

Manifest V3 的 Service Worker 会被浏览器暂停，模型冷启动和长音频生成可能超过其普通生命周期。项目因此使用 `offscreen` 文档作为长任务代理。

播放链路：

1. Content Script 生成带 UUID 随机部分的 `clientId / playbackId / requestId`；
2. `background.js` 确保 Offscreen Document 存在；
3. Offscreen 先确保浏览器保存的本地音色已在当前后端 PID 中注册；
4. Provider registry 选中 `local-qwen`，并用 `GET /health` 动态协商能力；
5. 优先调用 `POST /v1/audio/speech/stream`，Provider 异步事件流由 Offscreen
   转换为 WAV 输入并尝试渐进播放；
6. 无流式能力或流不可播时，回退到 `POST /v1/audio/speech` 整段合成；
7. 整段 WAV Blob 转 Base64 返回 Content Script，渐进流则留在 Offscreen 播放；
8. 同时预取后续少量句子。

取消模型：

- 切换页面、重新扫描、停止、跳句时会取消旧 session；
- Offscreen 使用 `AbortController` 按不可变播放身份取消；
- Offscreen 作业表使用 `clientId + requestId` 复合键；Provider 拒绝任何活动的重复
  request ID，取消时同时核对 client/playback/session；
- Provider 在本地中止后 best-effort 调用 `POST /v1/audio/speech/cancel`；
  `GET /v1/audio/speech/status/{requestId}` 可查询网关作业状态；
- 被旧 seek 抢走的预取仍可取消；
- 失败的预取允许一次前台重试；用户取消的预取不应偷偷重试；
- 新 seek 有 admission gate，旧异步请求完成后也不能反向覆盖当前状态。

---

### 10.1 Provider V2 契约与流式传输

扩展共享层的 `extension/shared/provider-v2.js` 定义统一 TTS Provider V2：

```js
{
  id,
  version: 2,
  capabilities,
  health(options),
  voices(options),
  synthesize(request, options),
  stream(request, options),
  cancel(requestId, options)
}
```

`createProviderRegistry()` 负责注册、选择和能力协商；Offscreen 的
`tts:status`、`tts:voices`、`tts:synthesize`、流式合成和取消均通过
选中的 Provider 执行，音色保存/删除/同步仍由 `api-client.js` 负责。

流式能力分为
`transportStreaming`、`progressivePlayback` 与 `backendIncrementalGeneration`，
不能把 HTTP 分块误报成后端增量生成。内置 `local-qwen` 适配器沿用旧的本地
`api-client.js`，只允许 `http://127.0.0.1:7811`，并通过 `migrateProviderConfig()`
幂等迁移 `apiBaseUrl`、`model`、`responseFormat` 等旧设置。`stream()` 的数据事件
为 `{ type: "data", data, sequence }`，结束事件为 `{ type: "end", final: true }`；
实际传输端点为 `POST /v1/audio/speech/stream`。

`transportStreaming` 表示 HTTP 分块可读；`progressivePlayback` 表示 Offscreen 已能边收
边播；`backendIncrementalGeneration` 才表示模型边生成边输出。当前 qwentts.cpp
仍整段生成 WAV，所以只静态承诺传输流式；渐进播放是浏览器的运行时结果，
后端增量生成为 `false`。`GET /health` 可动态降级静态能力；明确不支持或
流无法播放时，会回退到 `POST /v1/audio/speech` 整段合成。

---

## 11. 音色录制室与音色库

音色录制室是扩展自己的 Options Page：`voice-studio.html`。

### 11.1 录音

- 浏览器内申请麦克风；
- 建议录制 5～15 秒清晰人声；
- 可填写音色名称和准确台词；
- 处理为 24kHz、单声道、PCM16 WAV；
- 保存到浏览器扩展本地存储，并注册到本机 Qwen 后端。

### 11.2 批量导入

- 支持多文件选择和拖放；
- 浏览器 `AudioContext.decodeAudioData` 负责解码，因此可用格式取决于 Edge 支持，常见 WAV/MP3/M4A/AAC/OGG 通常可处理；
- 自动混合声道、分析响度、裁剪稳定的 5～15 秒人声窗口；
- 默认目标约 10 秒；
- 连续有声、没有前后静音的干净样本也有绝对阈值回退，不应被误判无语音；
- 批量处理使用单一串行 Worker，避免多个语音识别同时运行；
- 每个文件有独立名称、台词、试听、状态和错误；
- 处理失败不会阻塞其他文件；
- 注册失败可以重试，不需要重新解码或重新识别；
- 取消/清空后会停止任务并释放 File、PCM、WAV、Base64 和 Object URL。

### 11.3 台词识别的隐私边界

音色注册和 Qwen TTS 是本地的，但“自动识别参考音频台词”使用 Edge `SpeechRecognition`。在 Edge 上，这通常可能调用 Microsoft 在线语音识别服务。

因此必须准确描述：

- 参考音频用于本地音色克隆；
- 如果启用自动台词识别，选中的 5～15 秒片段可能发送给 Microsoft；
- 网络失败会重试有限次数；
- 识别失败不阻止用户手填台词；
- 用户手动编辑过的台词优先，迟到的云识别结果不能覆盖。

不要对用户声称“台词识别也是完全离线”。

### 11.4 重命名与只读音色

浏览器保存的完整本地音色可以重命名。重命名不是简单改字符串，而是事务：

1. 以新名称注册后端音色；
2. 原子更新 `voiceProfiles` 和楼主/回复音色设置；
3. 删除后端旧名称；
4. 存储失败则回滚新注册；
5. 旧名称删除失败则加入清理队列，下次列出音色时重试。

只存在于后端、没有浏览器本地 WAV/特征资料的音色显示为只读，无法从扩展中重命名。这是数据完整性限制，不是 UI 漏做。

扩展使用 `unlimitedStorage`，因为多份 10～15 秒 WAV 的 Base64 很容易超过 Chromium 默认 10MB `storage.local` 配额。

---

## 12. 安全与隐私

### 12.1 本地边界

- 网关和模型仅监听 `127.0.0.1`；
- 不修改 Windows 防火墙；
- 不向局域网公开模型；
- 正文 TTS 请求只发给 `127.0.0.1:7811`；
- 扩展不包含远程 JavaScript；
- Manifest CSP 只允许自身脚本和本机 7811 连接；
- 管理接口使用随机 Token；
- TTS 接口要求固定扩展客户端标头。

### 12.2 日志原则

网关日志位于运行目录下 `logs/gateway.log`。日志用于记录：

- 网关启动/停止；
- 后端 PID；
- 模型加载/退出；
- 音色注册；
- 错误类型。

不应主动记录完整网页正文、完整录音或管理令牌。

### 12.3 第三方代码

- Mozilla Readability：Apache-2.0；
- 图标资源许可证见 `assets/icons/LICENSE.md`；
- 统一声明见 `THIRD_PARTY_NOTICES.md`。

---

## 13. 目录结构

```text
浏览器TTS/
├─ src/                         Windows 托盘网关 C# 源码
│  ├─ Program.cs               单实例、命令行和程序入口
│  ├─ Core.cs                  配置、安全、闲置策略、日志
│  ├─ HttpRequestData.cs       最小 HTTP 请求解析
│  ├─ BackendController.cs     Vulkan 后端进程生命周期
│  ├─ TcpGateway.cs            7811 HTTP 网关、鉴权和转发
│  └─ TrayApplication.cs       系统托盘菜单和开机启动
├─ tests/                       网关测试
├─ build.ps1                   使用系统 csc.exe 编译
├─ test.ps1                    编译并运行网关测试
├─ build/                      网关编译产物与测试输出
├─ dist/Qwen-Reader-Edge/      当前实际可加载的 Edge 扩展 v0.5.2
├─ .worktrees/
│  └─ voice-library-cloud-transcription/
│     ├─ extension/            保留的 v0.5.0 扩展同步开发镜像（历史快照）
│     ├─ package-extension.ps1 正确的扩展打包脚本
│     └─ dist/Qwen-Reader-Edge 打包输出
├─ extension/                  根目录规范扩展源码，目前为 v0.5.2
├─ docs/                       历史设计、计划、审计截图
└─ QWEN_READER_PROJECT_CONTEXT.md
```

### 13.1 极重要：当前 Source of Truth

2026-08-16 已完成 Phase 0 源码回填，当前目录关系为：

```text
根目录 extension/                                      = 当前规范源码 0.5.2
.worktrees/voice-library-cloud-transcription/extension/ = 保留的同步开发镜像（历史快照 0.5.0）
根目录 dist/Qwen-Reader-Edge/                           = 当前交付包 0.5.2
```

根目录 `package-extension.ps1` 也已同步到新版安全打包脚本，因此后续开发默认在根目录
`extension/` 进行，并从仓库根目录打包。保留 worktree 是为了不破坏既有未提交成果；未经用户
明确授权，不要删除 worktree 或清理其中的改动。

当前正确开发目录：

```text
C:\Users\15300\Documents\浏览器TTS
```

正确扩展源码：

```text
C:\Users\15300\Documents\浏览器TTS\extension
```

当前 Git 工作树还有大量未提交的用户功能变更。不要使用：

- `git reset --hard`
- `git checkout -- .`
- 删除 worktree
- 用旧分支覆盖 dist

除非用户明确授权且已经先备份当前状态。

---

## 14. 构建、测试和打包

### 14.1 网关

在仓库根目录：

```powershell
.\test.ps1
```

脚本会：

1. 用 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` 编译 `QwenTrayGateway.exe`；
2. 编译 `GatewayTests.exe`；
3. 运行网关测试。

不需要安装完整 Visual Studio 或额外 .NET SDK。

### 14.2 扩展自动测试

当前测试位于真实 worktree：

```powershell
cd C:\Users\15300\Documents\浏览器TTS\.worktrees\voice-library-cloud-transcription\extension
node --test tests\*.test.cjs
```

截至 2026-08-15，完整扩展测试为：

```text
223 tests / 223 pass / 0 fail
```

覆盖范围包括：

- API 客户端和安全标头；
- Offscreen 生命周期、超时、取消；
- Flarum、Discourse、NodeBB、XenForo、Mirror/Card、Readability、Generic 提取；
- 分页、匿名作者、楼主身份、短回复；
- 图片、URL、引用和页面杂项过滤；
- `<br>` 视觉段落；
- 句子 Range、Source Locator、点击坐标命中；
- 标点簇和纯标点防护；
- 播放状态、预取和竞态取消；
- 点读、高亮、手动滚动接管、拖拽吸附图标、Switch UI；
- 音频导入、WAV、云台词识别、批处理、取消、资源清理；
- 音色保存、删除、重命名事务和存储失败回滚。

浏览器集成 Harness：

```text
extension/tests/browser/ui-harness.html
extension/tests/browser/extractor-harness.html
extension/tests/browser/voice-studio-harness.html
```

最近一次内置浏览器 UI Harness 结果：`PASS`。

### 14.3 正确打包

```powershell
cd C:\Users\15300\Documents\浏览器TTS\.worktrees\voice-library-cloud-transcription
.\package-extension.ps1
```

输出：

```text
.worktrees/voice-library-cloud-transcription/dist/Qwen-Reader-Edge
```

打包脚本会验证：

- Manifest V3；
- Manifest 引用闭包；
- HTML 本地脚本引用；
- 必要文件存在；
- 不包含 `eval()`；
- 不包含远程脚本；
- 源文件和打包文件 SHA-256 一致。

用户实际 Edge 当前加载的交付目录是：

```text
C:\Users\15300\Documents\浏览器TTS\dist\Qwen-Reader-Edge
```

从 worktree 打包后，需要把完整打包结果同步到这个目录，然后在 `edge://extensions/` 点击“重新加载”，并刷新已经打开的网页。

---

## 15. 日常使用流程

1. Windows 登录后，轻量网关和托盘图标自动启动；模型不预加载。
2. 用户打开帖子、小说或文章。
3. 扩展自动扫描，侧栏显示“已识别 N 句”，但不会发声。
4. 用户点击播放，扩展向 7811 发第一句请求。
5. 网关冷启动 7812 模型并注册 `邵思萌`、`qwen-clone` 和浏览器保存的本地音色。
6. 第一段冷启动可能额外等待约 5～10 秒。
7. 后续句子热生成，并预取少量下一句。
8. 用户可暂停、前后跳句、点读正文或切换作者音色。
9. 用户手动滚动时，自动跟随暂停，不抢操作。
10. 最后一次模型请求完成 10 分钟后，网关结束 `tts-server.exe`，释放显存。

无需重启电脑。电脑重启后只需要开机启动项自动运行网关；模型仍按需加载。

---

## 16. 当前已知限制

1. **主网关是 Windows 专用**：使用 .NET Framework、Windows Forms、Startup 快捷方式和 Windows Vulkan 二进制。
2. **扩展以 Edge 为主要目标**：理论上兼容 Chromium MV3，但未承诺所有 Chrome/其他系统组合。
3. **XenForo 只保证当前页**：没有管理员 API Key 时无法稳定读取整个主题。
4. **未知论坛不一定保留作者语义**：通用 DOM 和 Readability 可朗读正文，但可能退化为单主讲音色。
5. **Readability 不处理多作者论坛**：不能把它放到论坛适配器之前。
6. **NodeBB 有 100 页安全上限**：超限必须标记结果不完整。
7. **冷启动存在等待**：自动卸载后的第一次朗读要重新加载模型。
8. **后端内置音色只读**：没有浏览器本地参考资料就不能安全重命名。
9. **自动台词识别可能联网**：Edge SpeechRecognition 不是本地离线模型。
10. **worktree 仍保留未提交镜像**：根目录已经是 v0.5.2 规范源码，但不要擅自删除旧 worktree。
11. **当前改动大量未提交**：任何清理 Git 的动作都可能破坏用户成果。

---

## 17. 后续开发不可回归的产品原则

交给其他 AI 开发时，应明确以下规则：

### 内容

- 自动识别正文，但绝不自动播放；
- 论坛短回复不能按字符数丢弃；
- 论坛适配器必须优先于 Readability；
- 图片、尺寸、附件元数据、裸 URL、签名、引用和操作控件不能进入 TTS；
- 多个 `<br>` 视觉段落不能合并成一个巨大段落；
- 适配器输出必须统一为 `NormalizedDocument`。

### 音色

- 楼主音色不能进入其他作者音色池；
- 同一帖子切片不能中途换音色；
- voice 切换应当按请求完成，不重启模型；
- 重命名必须同时修复楼主/回复音色设置，并保持事务回滚。

### 播放

- 纯标点永远不能发给 TTS；
- 页面切换、重新扫描和跳句必须取消旧请求；
- 旧异步结果不能覆盖新播放状态；
- 用户手动滚动后不能继续抢滚动；
- 点读关闭时不显示悬浮点读控件；
- 当前句高亮应精确到句子，不使用遮挡正文的大矩形覆盖层。

### UI

- 插件附着在原网页上，不应大改网页排版；
- 视觉应紧凑、克制、编辑器式，不堆大量紫色圆角卡片；
- 悬浮图标应可拖动并吸附边缘；
- 侧栏宽度只用拖边调整，不重复增加 Range 滑块；
- 控件必须有明确语义和键盘可访问性；
- 动画应短、轻，并支持 `prefers-reduced-motion`。

### 隐私与安全

- 正文与克隆音频仅发给 localhost；
- 台词云识别必须明确告知可能发送给 Microsoft；
- 不开放局域网监听；
- 不删除未知端口进程；
- 不移除 `X-Qwen-Reader-Client` 安全标头；
- 不记录完整正文、音频或 Token。

---

## 18. 建议其他 AI 的上手顺序

1. 先阅读本文件。
2. 确认当前工作目录是仓库根目录，规范扩展源码位于根目录 `extension/`。
3. 阅读当前 `extension/manifest.json`。
4. 阅读以下核心模块：
   - `shared/normalized-document.js`
   - `shared/extractors.js`
   - `shared/forum-content.js`
   - `shared/text.js`
   - `shared/voice-assignment.js`
   - `shared/sentence-range.js`
   - `shared/source-locator.js`
   - `shared/follow-controller.js`
   - `content/reader.js`
   - `background.js`
   - `offscreen.js`
   - `voice-studio.js`
5. 阅读与目标功能最接近的测试，不要只读实现。
6. 修改前运行全量扩展测试，记录基准。
7. 为新问题先增加回归测试，再修改实现。
8. 完成后运行全量测试和至少一个真实浏览器 Harness。
9. 从仓库根目录打包，验证版本和哈希。
10. 未经用户明确许可，不重置、清理或删除当前未提交改动。

---

## 19. 可直接复制给另一个 AI 的任务前缀

```text
你正在维护一个 Windows + Edge 的本地 Qwen 网页朗读系统。请先完整阅读仓库根目录的 QWEN_READER_PROJECT_CONTEXT.md，再执行我的具体任务。

当前 v0.5.2 扩展规范源码位于：
C:\Users\15300\Documents\浏览器TTS\extension

根目录 package-extension.ps1 已同步为安全打包脚本，可以从根目录打包。旧 worktree 仍保留为未提交镜像，不要擅自删除或清理。

当前实际 Edge 交付目录：
C:\Users\15300\Documents\浏览器TTS\dist\Qwen-Reader-Edge

请保留现有未提交修改，不使用 git reset --hard、git checkout -- .，不删除 worktree。修改前先运行现有测试，修改后运行全量 Node 测试和相关浏览器 Harness。论坛适配器优先于 Readability；楼主音色只能给楼主；纯标点不得发送到 TTS；用户手动滚动后不得抢滚动；正文和克隆音频只允许发送到 localhost。

我的具体任务是：
<在这里填写新任务>
```

---

## 20. 当前交付结论

截至本文件生成时：

- Windows 托盘网关已可构建和运行；
- qwentts.cpp Vulkan 路线已在 RX 9070 XT 上生成有效中文语音；
- 网关支持按需加载、闲置卸载、托盘退出和开机启动；
- Edge 扩展已升级至 `0.5.2`；
- 实际交付目录已经同步为 `0.5.2`；
- Phase 0 源码回填完成，根目录 `extension/` 与安全打包脚本已成为规范入口；
- 新增 Unicode 感知分句、Emoji 安全朗读副本和 `SpeechSourceMap`；
- Extraction Engine v2 已建立候选评分骨架，文章页会比较 Readability 与 Generic 结果；
- 第二阶段 Provider V2 与流式 TTS 已完成：统一 Provider registry、能力协商、流式事件、渐进播放和整段 WAV 回退；
- `0.5.2` 修复长段落首句的精确 Range 映射与预取身份衔接，逐词高亮带有可降级的平滑动效，流式合成在尚未开始出声时也可排队暂停并可靠恢复；
- `GenericThreadDetector` 可从未知论坛的重复结构推测帖子、作者、楼层和楼主身份；
- 扩展自动测试 `317/317` 通过；
- 网关自动测试 `17/17` 通过；正式打包 `0.5.2` 共 48 个发布文件，源包与 dist 逐文件 SHA256 差异为 0；
- Extractor、Voice Studio 与 UI 三套隔离 Edge Harness 全部通过；
- 当前交付重点转为真实 Edge/Gateway 回归与后续 DOM Distiller 候选、更多未知论坛 fixture 和质量阈值校准；现有未提交改动仍需保留，后续可在用户授权后整理提交历史与旧 worktree。
