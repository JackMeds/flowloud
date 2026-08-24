# Flowloud 前端迁移与发布路线

## 决策

前端采用两条并行轨道，避免再次把视觉重构和播放链路一起改坏：

1. `extension/` 是当前可发布轨道。先恢复悬浮球、Popup、暂停协议与正文定位，并由完整回归测试保护。
2. `extension-wxt/` 是 React 界面与开发预览轨道。使用 WXT 管理扩展构建与热更新，React Aria Components 提供标准交互语义，Storybook 提供无需重载扩展的组件预览与状态矩阵。

任何 React 页面只有在接通真实后台协议并通过对应回归后，才替换 `extension/` 中的生产表面。

## 当前完成度

| 表面 | 当前稳定实现 | React Aria / Storybook | 生产替换条件 |
| --- | --- | --- | --- |
| 工具栏 Popup | React 构建产物已同步到 `extension/`，由 `RuntimeBridge` 连接真实协议 | Storybook 故事显式标记为 Mock | Chrome/Edge 真机回归持续作为发布闸门 |
| 网页悬浮球 | 52px 收起态；展开后四个至少 44px 控件 | 已实现 Orb / Expanded 交互状态 | WXT 内容脚本桥接完成 |
| 设置中心 | 现有页面继续承担生产设置 | 已实现朗读、引擎、声音库、外观四类布局 | 所有设置迁移与权限测试通过 |
| 本页配音 | 独立生产页面 | 已实现作者分配、试听、恢复与应用状态 | 页面上下文 broker 接通并回归 |
| 页面导览 | 现有生产导览页 | 已实现结构导航、定位和开始/暂停状态 | 导览消息协议接通并回归 |
| 音色工作室 | 现有生产录音与批量导入 | 已实现文件导入、参考文本、移除与批量保存状态 | 录音、解码、转写和存储链路接通 |

## 日常开发

### 只调界面与交互

```powershell
cd extension-wxt
pnpm storybook
```

打开 `http://127.0.0.1:6006`。Storybook 保存后热更新，不需要重新打包扩展，也不会因为后台轮询把滚动位置和表单状态重置。所有故事均属于 Mock 视觉状态，不能替代扩展真机功能验收。

### 调试真实扩展

```powershell
pnpm dev:browser
```

该命令使用独立持久 Profile 启动项目固定的 Playwright Chromium，并自动加载发布源 `extension/`，不需要进入 `chrome://extensions/`。WXT 的 `pnpm dev` 只用于 React 页面开发，当前不能替代完整扩展运行时。

### 构建两种浏览器

```powershell
pnpm build
pnpm build:edge
pnpm typecheck
pnpm build-storybook
```

正式包仍以 `extension/` 为根。更新 React Popup 或设置中心后运行：

```powershell
pnpm build:release-ui
```

该命令只同步 WXT 生成的 Popup、设置中心 HTML、共享 CSS 与 JS 清单；后台、offscreen 和正文阅读核心继续保持单一来源。

生成商店候选包时统一从仓库根目录运行：

```powershell
.\scripts\package-release.ps1
```

发布脚本会重新执行 React/WXT 类型检查、Chrome 与 Edge 构建、生产资源同步、两组测试和商店闸门，并检查 ZIP 内所有 Manifest/React 引用都存在。不要手工复制旧的 WXT 产物进发布目录。

需要复核真实扩展页、Popup 和正文悬浮播放器时优先运行：

```powershell
pnpm e2e:browser
```

失败时会自动保留 trace、截图和分类诊断。旧的 `preview-extension.mjs` 仅保留给商店截图与 Edge 补充检查，不再作为日常调试入口。

## 两个发布检查点

### 检查点 A：可靠性恢复版

- `extension/` 全量 Node 测试必须全部通过。
- 浏览器 UI harness 必须验证 52px 完整悬浮球、收起态无隐藏控件、展开态四个至少 44px 的可用播放控件。
- Flarum 真站 API 回归必须通过；Discourse 在接口受 Cloudflare 保护时必须完成浏览器内 DOM 降级验证。
- 暂停失败必须在 3 秒内返回结构化错误，不能假装成功或无限重试。
- 重复句子必须使用稳定来源偏移，不能点击一句播放下一句。

### 检查点 B：React 全面替换版

- Popup、设置、本页配音、导览、音色工作室和悬浮播放器逐一接入现有后台协议。
- 每替换一个表面，都保留上一检查点的功能回归；不在同一次提交中重写播放引擎。
- Storybook 覆盖播放、暂停、加载、错误、空状态、长标题、长作者列表、键盘和减少动效。
- Chrome 与 Edge 生产构建、原生 Popup、内容脚本和 offscreen 播放全部通过后，才删除旧 DOM 渲染器与旧 CSS。

## 真站回归

```powershell
pnpm e2e:target --url https://bbs.viva-la-vita.org/d/47653/3 --scenario continuation
pnpm e2e:real
```

Playwright 会在真实 Chromium 页面中加载完整扩展，验证悬浮球注入、正文提取、动态队列与自动续播。站点防护和第三方页面噪声会与扩展错误分开报告，详细说明见 `docs/automated-browser-testing.md`。
