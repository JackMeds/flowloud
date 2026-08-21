# Flowloud Windows 便携后端

扩展始终只连接 `http://127.0.0.1:7811`。便携包不包含模型权重；运行 `Download-FlowloudModels.ps1` 后才会从上游下载，并逐文件校验 SHA-256。

网关启动后，在系统托盘菜单选择“复制扩展配对令牌”，再粘贴到扩展的“设置中心 → 朗读引擎 → 本地 Qwen”。令牌只用于本机回环网关，请勿分享或写入 Issue/日志。

- 推荐：`./Download-FlowloudModels.ps1 -Profile 0.6b-q4`
- 高质量：`./Download-FlowloudModels.ps1 -Profile 1.7b-q8`
- 删除模型：`./Download-FlowloudModels.ps1 -Profile 0.6b-q4 -Delete`

qwentts.cpp 固定到提交 `a8a7716b530e49fed537c57711247c12fbbb903c`。Vulkan 不可用时启动器应给出明确提示，而不是静默回退或崩溃。
