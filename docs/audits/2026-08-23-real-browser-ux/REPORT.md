# 真实浏览器 Popup、工具栏图标与悬浮播放器收口

## 1. 审计结论

本轮反馈成立，根因不是单一尺寸值，而是三个界面重复表达同一状态：Popup 重复品牌 Logo、浏览器工具栏用原生 badge 盖住 Logo、网页悬浮播放器又同时显示 Logo 与播放控件。高 DPI/缩放后，原生 badge 会进一步挤压并遮挡 16px 图标，Popup 顶部也会因品牌、状态和设置入口争抢宽度而换行。

已锁定为一个统一规则：

1. Popup 不展示 Logo，只展示“播放状态 + 当前语音来源 + 全部设置”。
2. 浏览器工具栏始终只展示同一个 Flowloud Logo，不再叠加播放、暂停或错误字符。
3. 工具栏状态只通过外圈颜色表达：灰色为待机、绿色为播放、橙色为暂停、红色为异常。
4. 所有 16/32/48/128 图标重新加入透明安全边距；状态图标单独生成 16/32 两档，避免浏览器缩放时裁切。
5. 网页悬浮球采用同一逻辑：只展示 Logo 和状态色外圈，不把暂停图标盖在 Logo 上。

## 2. 修改前证据

真实 Edge 截图中，Popup 顶部 Logo、标题、暂停状态和“全部设置”发生换行；展开播放器重复展示 Logo；工具栏暂停 badge 覆盖在图标角落。

![修改前：Popup 与展开播放器](./01-popup-and-expanded-player.png)

网页悬浮球的视觉体积也明显大于同页其他悬浮入口。

![修改前：悬浮球比例](./02-floating-orb-scale.png)

## 3. 修改后结果

### 3.1 Popup

- 宽度为 420 CSS px，高度保持浏览器允许的 600 CSS px。
- 顶部从 64px 降到 52px。
- Logo 与品牌文字已移除。
- 自动测量结果：顶部右侧留白约 20.7px；指定的标题、状态、菜单和快捷操作均无换行；Popup 无横向溢出。

![修改后：Popup 不再重复 Logo](./03-popup-no-duplicate-logo.png)

### 3.2 网页悬浮播放器

- 悬浮球从 52px 缩到 44px，删除额外 4px 白色外环阴影。
- 展开播放器从 364px 缩到 304px。
- 展开态不再重复 Logo，五个控件统一为 40px，仍保留上一句、播放/暂停、下一句、回到正文和收起。
- 播放、暂停和错误状态由 2px 外圈颜色区分，不覆盖 Logo。

![修改后：紧凑悬浮球和播放器](./04-floating-player-compact.png)

### 3.3 浏览器工具栏

原实现调用 `chrome.action.setBadgeText()` 写入 `▶`、`❚❚`、`!`，这正是遮挡和偏移的来源。新实现始终清空 badge，只调用 `chrome.action.setIcon()` 切换同一 Logo 的状态外圈资源。

| 状态 | 外圈 | 文件 |
| --- | --- | --- |
| 待机 | 灰色 | `flowloud-toolbar-idle-{16,32}.png` |
| 播放 | 绿色 | `flowloud-toolbar-playing-{16,32}.png` |
| 暂停 | 橙色 | `flowloud-toolbar-paused-{16,32}.png` |
| 异常 | 红色 | `flowloud-toolbar-error-{16,32}.png` |

## 4. 验收方式与边界

1. Storybook 仅用于视觉状态和尺寸测量，不作为扩展功能完成证据。
2. React typecheck、Popup 发布契约、background 工具栏状态契约和 reader 视觉契约必须通过。
3. 发布 ZIP 必须收录全部状态图标，且 background 中不得再出现播放/暂停 badge 字符。
4. 浏览器会缓存工具栏图标。测试正式包时必须在扩展管理页重新加载扩展，再观察新图标；只刷新网页不会更新 service worker 和图标资源。
5. Chrome Action Popup 高度上限为 600px，因此不再通过无限增加高度解决信息密度，而是通过减少重复品牌、固定顶部和页签切换解决。[Chrome Action API](https://developer.chrome.com/docs/extensions/reference/api/action)

## 5. 最终发布闸门

- React/WXT typecheck：通过。
- Extension Node tests：415/415 通过。
- Gateway tests：18/18 通过。
- Chrome/Edge Store gate：通过，64 个正式文件通过闭合检查。
- Chrome 与 Edge 正式 ZIP：各 123 个条目，均包含 8 个工具栏状态图标。
- Chrome ZIP SHA-256：`de3eb5ca498bc20836888a9746563dc5314ad6604598a071c053289c6b366d30`
- Edge ZIP SHA-256：`e9585c5eea1a7050c89a75f17b4f36b3b183e7e32926676661649500b9b58598`
