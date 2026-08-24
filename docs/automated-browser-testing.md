# 真实网站自动调试

Flowloud 的浏览器回归使用项目固定的 Playwright Chromium，直接加载发布源 `extension/`。`extension-wxt/` 目前只负责 React 界面与测试工具依赖，不能单独代表完整扩展。

## 命令

从仓库根目录运行：

```powershell
pnpm dev:browser
pnpm e2e:target --url https://bbs.viva-la-vita.org/d/47653/3 --scenario continuation
pnpm e2e:real
pnpm e2e:browser
pnpm e2e:release
```

- `dev:browser` 打开隔离的持久 Chromium Profile，并自动加载 `extension/`。
- `e2e:target` 针对一个用户报告的网址运行提取或连续播放场景。
- `e2e:real` 运行 Flarum、Discourse 和普通文章矩阵。
- `e2e:browser` 同时运行本地确定性夹具和真实网站。
- `e2e:release` 组合单元测试、类型检查、商店闸门和浏览器回归。

需要在已有模型缓存上执行完整 Kokoro 下载、离线重启和合成检查时，可追加 `--with-browser-model`。默认发布回归会验证浏览器模型协议与界面，但不会为每次代码修改重复下载大模型。

首次安装依赖后，如本机没有对应版本 Chromium，运行：

```powershell
cd extension-wxt
pnpm exec playwright install chromium
```

## 诊断与隐私

共享夹具自动获取 MV3 Service Worker、注入可控系统语音探针，并收集页面、扩展和网络诊断。Cloudflare Beacon、跟踪保护、XSLT 弃用、懒加载和强制重排被归为网站噪声；只有扩展来源异常或行为断言失败才阻断测试。

失败时生成 trace、当前视口截图和不包含正文的 JSON 事件报告，保存在 `.tmp-playwright/`。该目录与持久测试 Profile 均被 Git 忽略。真实网页正文不写入日志或正式诊断包。

## 新增站点

在 `extension-wxt/e2e/site-cases.ts` 中添加 `RealSiteCase`，声明 URL、站点类型、场景、超时和最少片段数。需要登录的目标只能使用专用测试 Profile；禁止连接个人默认浏览器 Profile。

本地页面只用于制造暂停、取消、超时等确定性状态。论坛 DOM、SPA 路由、无限加载和正文提取必须使用真实站点用例验证。
