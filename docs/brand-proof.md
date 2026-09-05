# 品牌截图：真实扩展工作台

[查看原始截图](../assets/brand/product-proof.png) · [返回 README](../README.md)

## 来源与捕获

- 源码提交：[`05be31b962c9228eea740c3c7b480480c2a9c2d3`](https://github.com/JackMeds/flowloud/commit/05be31b962c9228eea740c3c7b480480c2a9c2d3)。直接加载此 checkout 的 `extension/`，未更改运行时代码或 manifest。
- 扩展版本：`0.10.0-alpha.1`，Manifest V3。
- 捕获时间：2026-09-04 23:40:57 UTC（北京时间 2026-09-05 07:40:57）。
- 页面：`chrome-extension://igdokkjfnkfnnlmimemjalimnicadbma/document-workbench.html`。本次扩展 ID 来自隔离安装，不是固定商店 ID。
- 方法：Playwright 驱动 Google Chrome for Testing；新建独立 Profile，以 `--load-extension` 加载当前源码。未连接个人浏览器 Profile。
- 原始 PNG：1400 × 1040，135,294 字节，未拼接、重绘或后期修改 UI。
- SHA-256：`027fc180839c894dae01379dc2d88953517679f0d8154235b02516819a50d22c`。

## 实际操作

打开真实扩展文档工作台，选择“粘贴文本”，输入下列三段，选择“仅识别”并点击“开始处理”。页面实际返回“识别完成 · 3 个文本块”，随后直接截图。捕获过程中未出现页面 JavaScript 异常。

```text
【品牌演示 · 虚构示例文本】
给长文章一点声音。阅读可以从一段安静的文字开始，也可以在需要的时候继续听下去。

把不寻常的想法，做成真正能用的软件。每一个段落都保留自己的位置，方便校对、复制和朗读。

这份内容专为产品截图制作，不含真实用户资料。本次仅演示本地文本分块，没有调用 OCR、翻译或云端语音服务。
```

## 证据边界

截图证明当前扩展的本地文本输入、分块与校对界面可用。三段文案均专为演示创作；“仅识别”在文本输入下使用本地分块，不是调用 OCR 模型。右侧空译文明确显示“当前流程不生成译文”。没有配置密钥、连接服务、下载模型或发起朗读；本图不作为云端翻译、OCR 或语音质量的验证。

页面由扩展自身渲染，不是 Storybook、静态效果图或旧版本审计图。复现时需使用可加载扩展的 Chromium 和新的隔离 Profile，按上述 UI 步骤输入相同示例文本。
