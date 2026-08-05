# Qwen 网页朗读托盘网关

这是本机 Qwen3-TTS Vulkan 后端的轻量托盘网关。

- Edge 继续使用 `http://127.0.0.1:7811/v1`。
- 真正的 Vulkan 模型服务仅在需要时启动于 `127.0.0.1:7812`。
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

当前用户桌面已提供“启动 Qwen 网页朗读”和“停止 Qwen 网页朗读（释放显存）”；
登录启动项只启动轻量网关，不会预加载模型或占用显存。
