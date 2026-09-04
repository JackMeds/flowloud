# Qwen 网页朗读

这是一个面向 Microsoft Edge 的本地网页朗读扩展，界面采用“方案 A：精致紧凑侧栏”。

当前发布版本：`0.5.0`。本版本完成 Provider V2 统一契约与流式 TTS 播放链路，保留整段合成回退。

## 功能

- 页面载入和站内换帖后自动识别正文，但不会自动发声；
- “读取本页 / 重新读取”可以随时强制重建当前朗读队列；
- Flarum、Discourse（含 LinuxDo）和 NodeBB 优先读取同源论坛 API；
- XenForo 提取当前已加载页面，并明确标记为当前页结果；
- 新闻、博客、小说和普通长文使用本地打包的 Mozilla Readability；
- 文章页同时评估 Readability 与 Generic 候选，记录质量分数并选择更可靠的结果；
- 未知论坛会通过重复帖子结构、作者覆盖率和正文密度进行启发式识别；
- 未识别站点继续使用通用正文回退，保留“顶”“同意”等短回复；
- 过滤点赞、回复、举报、签名、引用、徽章、广告和导航等控件；
- 楼主使用专属音色 A，其他楼层从回复音色池轮换；
- 页面悬浮球、右侧栏、暂停、前进、后退和段落定位；
- 使用 `Intl.Segmenter` 进行 Unicode 感知分句，并在不支持时回退到内置规则；
- Emoji 仅从送往 TTS 的副本中移除，原文和精确高亮保持不变；
- 每个播放片段携带 `SpeechSourceMap`，为后续逐词/短语时间轴高亮提供稳定映射；
- 在扩展音色录制室录制 5～15 秒参考音频；
- 长时间的模型冷启动和 WAV 合成在 MV3 offscreen 文档中完成；
- Provider V2 统一健康检查、音色、整段合成、流式合成与取消，并按能力自动选择链路；
- 流式传输可用时优先边接收边播放，流不可渐进播放时自动回退到整段 WAV；
- 只连接本机 `http://127.0.0.1:7811`，不上传正文或录音；
- 与托盘网关配合，闲置十分钟后自动释放模型显存。

## 安装

1. 打开 `edge://extensions/`；
2. 打开“开发人员模式”；
3. 选择“加载解压缩的扩展”；
4. 选择整个 `Qwen-Reader-Edge` 目录；
5. 刷新已经打开的网页。

右下角紫色 `Q` 是朗读入口。也可以点击 Edge 工具栏图标或按 `Alt+O`。

更新开发版时，在 `edge://extensions/` 找到本扩展并点击“重新加载”，然后刷新
已经打开的网页。

## 第一次使用

默认配置为：

- 楼主音色 A：`邵思萌`
- 回复音色：`qwen-clone`

这两个名称在当前后端可能指向同一段参考录音，因此第一天可以直接朗读，但人物差异有限。
在“音色库 → 录制新音色”中增加第二、第三个音色后，再到“作者配音”勾选回复音色池，
即可获得明显的多人区分。

打开网页后，扩展会先建立队列。看到“已识别 N 段”后再点击播放；自动扫描、手动
“重新读取”和站内换帖都只更新队列，不会擅自调用 TTS 或播放声音。

## 提取范围

- Discourse、Flarum、NodeBB 会处理分页或缺失楼层，并保持首帖作者后续发言的楼主身份；
- 无账户 ID 的匿名/访客回复会按可用用户名或楼层区分，不会把所有访客误判为楼主；
- NodeBB 最多自动读取 100 页；超过上限时结果会明确标记为未完整提取；
- XenForo 目前只保证浏览器当前页已经加载的楼层，侧栏会显示相应适配器信息；
- Readability 只用于单作者文章，不会覆盖已经识别出的论坛结构；
- 页面切换会取消旧扫描、旧预取和旧音频，防止上一帖的内容进入新队列。

## Provider V2 与流式合成

TTS 访问统一通过 `shared/provider-v2.js` 的 Provider V2 契约：每个提供方必须提供
`id`、`version`、`capabilities`，以及 `health()`、`voices()`、`synthesize()`、
`stream()`、`cancel()`。`createProviderRegistry()` 负责注册、按能力协商和选择提供方；
`normalizeProviderError()` 将网络、超时、取消和 HTTP 错误归一化为稳定错误码。

当前内置 `local-qwen` 适配器只允许 `http://127.0.0.1:7811`，兼容旧的
`apiBaseUrl`、`model`、`responseFormat` 设置。`stream()` 优先读取本地服务的
`POST /v1/audio/speech/stream` `ReadableStream`，逐块返回
`{ type: "data", data, sequence }`，结束时返回
`{ type: "end", final: true }`。Offscreen 会把该异步事件流接入 WAV 播放器；
若健康检查明确禁用流式能力，或流无法渐进播放，则回退到
`POST /v1/audio/speech` 整段合成。

三层能力不可混用：`transportStreaming` 只表示 HTTP 响应可分块读取；
`progressivePlayback` 表示浏览器已经能边收边播；
`backendIncrementalGeneration` 表示模型本身边生成边输出。当前 qwentts.cpp
后端仍整段生成 WAV，因此适配器只静态承诺传输流式，不声明后端增量生成。

`GET /health` 的动态能力可覆盖静态声明；`tts:status`、音色列表、
合成和流式都通过 registry 选中的 Provider 调用。取消使用
`POST /v1/audio/speech/cancel`，请求状态使用
`GET /v1/audio/speech/status/{requestId}`。每次朗读使用唯一 request ID；
重复 ID 会返回 `duplicate_request`，取消还会校验 client/playback/session 身份，
避免一个页面中断另一个页面的合成。

## 隐私

网页正文只会发送到本机回环地址。录音保存于当前 Edge 用户的扩展本地存储，并注册到
本机 Qwen 服务；扩展不包含远程脚本或云端语音接口。

Mozilla Readability 固定源码版本和 Apache-2.0 许可证见
`THIRD_PARTY_NOTICES.md` 与 `vendor/readability/LICENSE.md`。

## 当前阶段

第二阶段 Provider V2 与流式 TTS 已完成并纳入 `0.5.0` 交付包；Extraction Engine v2
同时保留候选评分、未知论坛启发式检测和 Unicode/SpeechSourceMap 能力。
