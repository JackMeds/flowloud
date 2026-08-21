---
title: Provider 数据流
---
# Provider 数据流

| 来源 | 正文去向 | 下载 | 密钥 |
|---|---|---|---|
| 浏览器系统语音 | 本机浏览器语音服务 | 无 | 无 |
| 浏览器模型 | 本机 WebGPU/WASM | 用户确认后下载权重 | 无 |
| 本地 Qwen | `127.0.0.1:7811` | 用户下载 Windows 后端与模型 | 无 |
| OpenAI 兼容在线 TTS | 用户配置的 HTTPS origin | 由服务决定 | 会话默认，可选本机记住 |

浏览器模型拒绝远程脚本、`trust_remote_code`、自定义加载代码和非 Hugging Face 模型主机。
