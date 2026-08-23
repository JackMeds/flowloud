---
title: 添加 Provider
---
# 添加 Provider

## 文档与翻译

1. 在 `extension/shared/document-provider-v1.js` 增加协议适配器，或只增加一个复用现有协议的 preset。
2. 声明 `visionOcr`、`textTranslation`、`pdfInput`、`structuredOutput`、`streaming`，以及输入/输出类型和鉴权字段。
3. 将厂商响应转换成 `DocumentArtifact` 或 `TranslationArtifact`；块 ID 必须稳定并在翻译后保持不变。
4. 使用 Provider Core 生成 request ID、关联取消信号、超时和标准错误。认证失败、限流、能力不匹配、格式错误和取消必须可区分。
5. 远程地址只允许 HTTPS；本机回环地址可用 HTTP。权限只能申请该 Profile 的精确 origin。
6. 添加协议夹具测试、取消测试、错误映射测试和一次真实服务记录。工作台不应因新增适配器而修改。

当前协议：OpenAI Chat Completions、OpenAI Responses、Ollama `/api/chat`、Flowloud Document V1。

## TTS

TTS Provider V4 单独维护音色、合成、流式、取消、模型管理与播放能力。豆包使用原生 `/api/v3/tts/unidirectional` 适配器；不要把私有语音协议伪装为 OpenAI `/v1/audio/speech`。

## 安全检查

- 密钥只从 secret store 注入，不能进入 Profile 导出。
- 自定义 Header 会丢弃 Authorization、Cookie、API Key、token 和 secret 类字段；鉴权必须走单独密钥字段。
- 日志只记录 provider、stage、code、request ID 和有限状态，不记录正文、图片、音频或完整响应。
