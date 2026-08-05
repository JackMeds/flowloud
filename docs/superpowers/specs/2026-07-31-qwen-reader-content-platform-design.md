# Qwen Reader 通用内容适配平台设计

## 目标

在保留现有 Qwen3-TTS Vulkan、本地音色、多作者音色分配、录音室、悬浮球和页面内侧栏的前提下，把当前仅对单个 Flarum 站点可靠的扩展升级为通用网页朗读扩展。

交付版本必须做到：页面进入或 SPA 换帖后自动识别内容但不自动发声；用户可明确“读取本页/重新读取”；论坛语义优先于文章提取；长时 TTS 请求不再依赖 Manifest V3 service worker 的 fetch 生命周期。

## 核心决策

1. 保留现有扩展，不 Fork Read Aloud 或 ReadX。
2. 论坛按平台使用专用适配器，统一输出 `NormalizedDocument`。
3. 普通文章、小说和博客使用官方 Mozilla Readability；Readability 永远排在论坛适配器之后。
4. 未知页面依次回退到通用 DOM 提取和用户选区。
5. 内容扫描、音色分配、语音合成和播放是四个独立阶段；预设切换不触发正文识别。
6. 自动扫描只构建队列，不调用 TTS；只有播放、试听或明确的音色操作才可能加载模型。
7. 长时本地 TTS fetch 由 offscreen document 承担；service worker 只创建该文档、处理快速健康检查和浏览器入口。

## 统一数据模型

```js
{
  url: "https://example.test/topic/42",
  pageKey: "https://example.test/topic/42",
  title: "主题标题",
  adapterId: "discourse",
  blocks: [{
    id: "discourse:post:81",
    type: "forum-post",
    text: "可朗读正文",
    authorId: "user:7",
    authorName: "作者",
    floor: 3,
    isOp: false,
    postId: "81",
    sourceKey: "discourse:81",
    sourceSelector: "article[data-post-id=\"81\"]"
  }]
}
```

`pageKey` 忽略普通楼层锚点，用于判断是否仍是同一个主题或章节。论坛适配器必须把同一楼主在后续楼层的 `isOp` 继续标为 `true`，不能只把第一楼视为楼主。

## 适配器顺序

1. 用户当前选区（显式选择始终优先）。
2. Discourse：同源主题 JSON，缺失帖子按 ID 补取，DOM 回退。
3. Flarum：同源 JSON:API，分页跟随，DOM 回退。
4. NodeBB：当前主题路径的 `/api` JSON，DOM 回退。
5. XenForo：容错 DOM 适配器。
6. Mozilla Readability：新闻、博客、教程、小说和普通长文。
7. 通用 DOM：语义容器评分与清理。

每个适配器只负责识别和标准化，不负责音色、播放或 UI。

## 清理与短回复

- 论坛正文只从明确的 content root 提取。
- 删除脚本、样式、按钮、工具栏、签名、反应区、徽章、广告、隐藏节点和编辑控件。
- 论坛仅丢弃清理后为空或纯控制符号的内容；“顶”“同意”等短回复必须保留。
- Readability 的文章长度阈值不得用于论坛块。

## 页面生命周期

- 初次加载在设置恢复后自动扫描。
- 打开面板时若队列为空或过期，立即扫描。
- 播放前执行 `ensureCurrentDocument()`；URL/pageKey 变化时先重新扫描。
- 监听 `pushState`、`replaceState`、`popstate`、`hashchange` 和帖子容器的 DOM 增量。
- 每次扫描持有 generation；旧扫描完成时不得覆盖新页面。
- 切换到新主题时停止旧音频、取消预取、清除高亮和旧队列。
- 同一主题动态出现新楼层时，空闲状态自动防抖重扫；播放中只标记为过期，结束或手动重读后更新。

## UI

“正在朗读”页增加内容状态卡：

- 正在识别；
- 已识别 N 段 / M 位作者；
- 使用的适配器名称；
- 读取本页（空队列）或重新读取（已有队列）按钮；
- 页面在播放中发生变化时显示“内容已更新”。

播放按钮在必要时可以隐式扫描，但预设控件只改变音色分配。默认预设及音色配置从 storage 恢复，无需每页重新点击。

## 多音色约束

- 楼主音色永远不进入回复音色池。
- 同一楼主在主题内的所有发言保持楼主音色。
- 回复音色池至少保留一个有效音色；非法更改不得写入 storage。
- 每个合成缓存键包含文本、音色、模型和速度。
- 切换 `voice` 只改变单次 `/v1/audio/speech` 请求，不重启模型。

## MV3 长请求

- 新增 `offscreen.html` 和 `offscreen.js`。
- background 的 `tts:prepare` 单实例创建 offscreen document。
- content script 和 voice studio 先 prepare，再向 offscreen 目标发送后端操作。
- offscreen 持有 `AbortController`、60 秒产品超时、API 客户端和音色同步世代。
- 后端 PID 变化时，浏览器本地保存的同名音色也要重新 POST，以覆盖网关默认音色。
- 预取失败只退化为前台重新合成，不得把 `null` 当成音频结果。

## 安全与许可证

- TTS 仅允许 `http://127.0.0.1:7811`。
- 论坛 API 只请求当前页面同源地址并携带同源凭据。
- 不执行远程脚本、不使用 `eval`、不上传网页正文或录音。
- Mozilla Readability 固定版本随扩展本地打包，保留 Apache-2.0 声明和来源信息。
- 移除不必要的 `tabs` 权限，新增 `offscreen` 权限。

## 验收

1. Flarum、Discourse、NodeBB、XenForo fixtures 正确得到作者、楼层、楼主和短回复。
2. 普通文章由 Readability 提取，内部按钮和推荐控件不进入正文。
3. 页面首次加载自动构建队列但不发出 TTS 请求。
4. “重新读取”强制获得当前页面内容。
5. SPA 换帖后旧队列和旧音频失效。
6. 预设无需点击即可应用，最后一个回复音色不能被取消。
7. 模拟 35 秒以上的合成不会依赖 service worker fetch，取消和超时有明确结果。
8. 预取失败后当前段落可以前台重试。
9. 全部 Node 测试、脚本语法检查、打包检查和浏览器 harness 通过。
10. 最终 `dist/Qwen-Reader-Edge` 可在 Edge 作为解压缩扩展重新加载。
