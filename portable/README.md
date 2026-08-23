# Flowloud Windows 便携后端

扩展始终只连接 `http://127.0.0.1:7811`。便携包不包含模型权重；运行 `Download-FlowloudModels.ps1` 后才会从上游下载，并逐文件校验 SHA-256。

网关启动后，在系统托盘菜单选择“复制扩展配对令牌”，再粘贴到扩展的“设置中心 → 朗读引擎 → 本地 Qwen”。令牌只用于本机回环网关，请勿分享或写入 Issue/日志。

- 推荐：`./Download-FlowloudModels.ps1 -Profile 0.6b-q4`
- 高质量：`./Download-FlowloudModels.ps1 -Profile 1.7b-q8`
- 指定参考音频并同步已有网关配置：`./Download-FlowloudModels.ps1 -Profile 1.7b-q8 -GatewayConfig ./gateway.json -ReferenceAudio ./voices/my-voice.wav`
- 删除模型：`./Download-FlowloudModels.ps1 -Profile 0.6b-q4 -Delete`

下载器使用固定 Hugging Face revision 和 SHA-256 校验。如果 `gateway.json` 已存在，会更新模型路径、模型 ID、别名和量化；参考音频只在显式传入 `-ReferenceAudio` 时修改。也可以直接编辑 `gateway.json` 或设置 `FLOWLOUD_TTS_MODEL`、`FLOWLOUD_TTS_CODEC`、`FLOWLOUD_TTS_MODEL_ID`、`FLOWLOUD_TTS_QUANTIZATION`、`FLOWLOUD_TTS_REFERENCE_AUDIO` 等环境变量，因此网关不限制 0.6B/1.7B。

qwentts.cpp 固定到提交 `a8a7716b530e49fed537c57711247c12fbbb903c`。Vulkan 不可用时启动器应给出明确提示，而不是静默回退或崩溃。
