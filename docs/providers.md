---
title: Provider 协议与数据流
---
# Provider 协议与数据流

## TTS Provider V4

| 来源 | 协议 | 数据去向 | 凭据 |
|---|---|---|---|
| 浏览器系统语音 | `chrome.tts` | 浏览器/操作系统 | 无 |
| 浏览器模型 | Kokoro v1.1 中英 ONNX | 本机 WebGPU；失败后明确回退 WASM | 无 |
| 本地服务 | Flowloud Qwen、GPT-SoVITS、CosyVoice、OpenAI 本地兼容 | 用户授权的回环地址 | 会话默认，可选本机记住 |
| OpenAI 兼容 TTS | `/v1/audio/speech` | 用户授权的 HTTPS origin | 会话默认，可选本机记住 |
| 豆包 TTS | `/api/v3/tts/unidirectional` | 火山语音 origin | 会话默认，可选本机记住 |

浏览器只内置一套 `@uzen/kokoro-js` + Transformers.js + ONNX Runtime Web 运行时。模型 `onnx-community/Kokoro-82M-v1.1-zh-ONNX` 固定到 `6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3`，权重和音色按需进入 Cache Storage，不进入扩展 ZIP。Kokoro 是预设音色模型，不显示参考音频或克隆入口。

## Document/Language Provider V1

| 协议 | OCR/视觉 | 翻译 | 探测方式 |
|---|---:|---:|---|
| OpenAI Chat Completions 兼容 | 按 Profile 能力 | 是 | 本地配置校验，首次真实请求确认 |
| OpenAI Responses 兼容 | 按 Profile 能力 | 是 | 本地配置校验，首次真实请求确认 |
| Ollama `/api/chat` | 视觉模型可用 | 是 | 本地配置校验，首次真实请求确认 |
| Flowloud Document V1 | 是 | 是 | `/health` + `/v1/capabilities` |

内置 Profile 预设包括 OpenAI、火山方舟、阿里百炼、智谱、DeepSeek、OpenRouter、Ollama 与 Flowloud。预设只填写协议和常用地址；模型、能力、超时、鉴权和非敏感自定义 Header 可修改。

数字 PDF 的文字层始终在浏览器本地解析。图片和扫描页只发送给用户选定并确认的 OCR Profile；翻译只发送对应文本块，不上传原始 PDF，也不使用 OpenAI Files。

## 本地大模型

Qwen 0.6B、1.7B 或更大模型不在浏览器内运行。它们通过 Ollama、vLLM/兼容服务或 Flowloud 网关接入。网关的 `ModelPath`、`CodecPath`、`ModelId`、`ModelAlias`、`Quantization`、`VoiceReferenceWav` 和音色名称均可在 `gateway.json` 或 `FLOWLOUD_TTS_*` 环境变量中设置，并在首次加载后端时验证文件。

便携下载器的模型仓库固定到 revision `968442208ea86f312b6b67ac8ef0c1b551967e35`；下载后会校验 SHA-256，并在已有 `gateway.json` 时更新所选模型 ID、量化和路径。
