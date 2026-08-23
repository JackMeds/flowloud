# Flowloud 功能收口与发布验收记录

日期：2026-08-23  
版本：`0.9.0-beta.2`

## 自动化放行结果

- Windows 网关测试：18 / 18 通过。
- 扩展 Node 测试：413 / 413 通过，无 skip / todo。
- React/WXT TypeScript 检查、Chrome 构建、Edge 构建和生产资源同步通过。
- Manifest V3 / 双商店 release gate 通过，共检查 64 个生产文件。
- Chrome、Edge ZIP 各 115 个条目；Kokoro、Transformers、WASM、拼音/音素处理、默认音色和第三方许可证闭合。
- ZIP 不包含 `tests`、`node_modules`、`popup-lab`、`.env` 或已知凭据模式。

| 包 | 大小 | SHA-256 |
|---|---:|---|
| `flowloud-0.9.0-beta.2-chrome.zip` | 20,944,721 bytes | `b8b4fe3f5b9b7bb4ea19ca21719f941187b14e2e386c59905026da5c891a16dd` |
| `flowloud-0.9.0-beta.2-edge.zip` | 20,944,721 bytes | `6ad096fcf95df8d512045d2e57e9cdff011250ec99f15b8b1494818d30367bd3` |

## 浏览器模型真机证据

两套正式模型均在加载真实 MV3 扩展的 Edge 干净配置中使用 WASM 验证，不使用 Storybook 或模型夹具代替。

| 模型 | 固定 revision | 下载后校验 | 浏览器重启后离线校验 | 离线合成 | 精确删除 |
|---|---|---|---|---|---|
| 中文 VITS | `3265ca20151fb9c79fa00c8f3874cacb2c15b2ce` | ready | cached / ready | WAV 135,726 bytes | missing / cached=false |
| 英文 Kokoro | `1939ad2a8e416c0acfeecc08a694d14ef25f2231` | ready | cached / ready | WAV 139,245 bytes | missing / cached=false |

Kokoro 下载取消另外验证了同一 `requestId` 的 typed `cancelled`，没有把旧下载结果误记为成功。原始 JSON 见 [evidence](./evidence/)。

## 播放与页面生命周期

- 全局只保留一个可听会话；B 页播放会完整接管 A 页。
- 系统语音不再用会中断当前 utterance 的下一段预取。
- 暂停、恢复、停止、等待首包时的暂停意图以及迟到事件由统一播放身份约束。
- 普通切换标签页继续播放；SPA/完整导航、刷新和关闭来源标签页停止并清理高亮、合成和音频资源。
- 精确点读覆盖首句/次句、重复内容、内联节点、动态 DOM，以及 80% / 100% / 150% / 200% 页面缩放。
- 悬浮球为完整可见的 52px 收起态；展开控制的主命中区至少 44px。

## 最终解包目录浏览器回归

- Edge 稳定版使用干净配置加载生产扩展：React Popup/设置、A→B 接管、完整导航停止、关闭来源页停止、悬浮播放器和 80% / 100% / 150% / 200% 精确点读矩阵通过。
- Chrome for Testing 使用干净配置加载 `dist/Flowloud-Chrome`：同一完整矩阵通过；Popup 为生产数据桥接状态，`mock: false`，设置中心 7 个页签和受保护密钥输入可用。
- 正式包按规则排除 `popup-lab`；回归工具只把确定性的 HTML harness 临时放入测试副本，harness 相对引用的仍是最终解包目录内的生产 `reader.js` 与 CSS。
- 两个自动化环境均只能退回直接打开生产 popup 页面；没有把浏览器工具栏 action popup 的自动打开超时判定为通过。原始报告见 [Chrome](./evidence/chrome-preview/preview-report.json) 与 [Edge](./evidence/edge-preview-report.json)。

## 仍需发布人员完成的外部验收

以下项目依赖本仓库之外的服务、账户或人工浏览器壳层操作，因此没有用夹具伪装成已完成：

- 使用固定服务版本分别运行真实 Qwen、GPT-SoVITS、CosyVoice 和 OpenAI 兼容在线 TTS 试听；当前契约与回环夹具已通过，但本机没有同时运行这些外部服务，也没有在线 API 凭据。
- 人工从 Chrome 与 Edge 工具栏打开 action popup，检查浏览器原生锚点、失焦关闭和权限提示。自动化可验证同一生产 popup 页面，但不能可靠操纵浏览器工具栏气泡。
- NVDA、强制颜色、400% 缩放、低磁盘空间、权限拒绝、扩展商店上传表单与商店审核结果。
- 商店提交和 Windows 可执行文件代码签名需要发布账户/证书，不属于本次本地实现动作。
