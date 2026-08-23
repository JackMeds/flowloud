# Flowloud / 流声

## 简短说明

用系统语音、Kokoro、本地语音服务或自选 API 朗读网页、识别图片/PDF 并翻译文本。

## 详细说明

Flowloud 会识别论坛、文章、小说和普通网页正文，保留段落与作者结构，并在播放时提供句子和逐词高亮。

- 默认系统语音，安装后立即可用
- 浏览器本地 Kokoro v1.1 中英模型，确认后才下载并缓存
- 本地服务适配 Qwen、GPT-SoVITS、CosyVoice 与 OpenAI 本地兼容协议
- OpenAI 兼容在线 TTS，密钥默认只保存到会话结束
- 文档与翻译工作台：当前网页、截图、粘贴文本、图片和 PDF 选页
- OpenAI Chat/Responses、Ollama 与 Flowloud 文档协议，OCR 和翻译可选不同 Profile
- 数字 PDF 本地提取；图片与扫描页在每个会话首次云端处理前确认
- 页面导览：区域、标题、段落、列表、表格、链接、按钮、表单与图片
- 无遥测、无广告、无后台收集

页面导览不会点击链接、触发按钮或修改表单，也不替代读屏软件。

## 权限理由

- `storage`：保存设置、音色与模型缓存元数据。
- `unlimitedStorage`：保存用户主动下载的浏览器模型和本地音色。
- `offscreen`：Popup 关闭后继续音频播放，并处理暂停、结束和进度事件。
- `activeTab`、`scripting`：仅在用户点击扩展或快捷键后读取并高亮当前网页。
- 可选主机权限：本机回环服务、Hugging Face 下载和用户配置的 TTS/OCR/翻译 API 精确 origin；均在相应用户操作时请求。
