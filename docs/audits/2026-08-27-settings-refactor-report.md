# Flowloud 设置与音色重构调查报告

- 日期：2026-08-27
- 范围：Popup、Popup 内设置、独立 Options 设置页、旧声音工作室、TTS Provider 配置与音色数据流
- 本轮性质：调查与重构建议；未修改产品代码，未连接用户的真实本地服务或云 API

## 一、结论

当前问题不是单纯的视觉凌乱，而是一次“把设置集中到 Popup”的迁移停在了半路：新 Popup 设置中心、完整 Options 设置中心、旧声音工作室设置中心仍同时存在，并且共同读写同一份设置。用户面对的入口割裂、音色无法选择、连接状态不可信和 API 未验证，都是这个结构性问题的直接结果。

建议确立以下唯一产品边界：

1. **Popup 只保留快捷控制**：语音来源、当前音色、速度、播放与一个“打开设置”入口。
2. **Options 成为唯一完整设置中心**：它适合长表单、权限请求、模型下载、连接测试和错误恢复。
3. **声音工作室只负责声音资产**：录音、导入、克隆、重命名、删除和试听；不再承载阅读、引擎和存储设置。
4. **所有 Provider 共用同一条配置流程**：配置 → 验证 → 读取音色 → 选择音色 → 试听 → 启用。
5. **Schema 只保留一份音色选择状态**，旧字段仅在迁移入口读取，不再由 UI 双写。

不建议先在某一页临时补一个本地音色下拉框。那会让第四个入口继续存在，进一步扩大状态分叉。

## 二、调查方法与证据边界

本次以 `extension/` 为实际发布运行源，用仓库指定的隔离 Playwright Chromium 加载扩展，重新走查并截图。没有连接默认 Chrome/Edge Profile。

验证结果：

- 发布源扩展页面 E2E：1 项通过。
- 本次设置流程截图 E2E：1 项通过。
- TypeScript 类型检查：通过。
- 相关 Provider、Schema、Popup、声音工作室与浏览器模型单元/契约测试：64 项通过。

这些“通过”不能说明当前设置架构正确：现有测试中存在互相矛盾的产品契约，且一个字符串断言被注释误导，导致半迁移状态仍然全绿。

本轮没有执行真实云 API 请求，也没有使用用户密钥。OpenAI/Doubao 的真实试听路径存在于代码中，但尚无真实服务 E2E 证据；本地服务启动与连接失败也按用户要求暂不诊断。

## 三、当前设置拓扑

| 表面 | 当前职责 | 问题 |
|---|---|---|
| Popup 主界面 | 播放、来源、当前音色、速度、配音、更多 | 快捷控制与完整设置边界不清 |
| PopupSettingsCenter | Provider、外观、AI、快捷键、数据 | 在 420×600 的瞬时窗口里承担长表单、权限和下载 |
| Options / SettingsWorkspace | 8 个设置分类和完整 Provider 表单 | 与 Popup 重复；仍是可直接打开的完整设置中心 |
| voice-studio.html | 阅读、引擎、音色、存储，以及声音资产 | 旧的第三套设置中心；文案、模型来源和状态逻辑已漂移 |

此外，旧 `popup.html` 与旧 Popup 脚本仍保留在发布源目录，虽然 Manifest 当前使用 `popup-react.html`。

### 半迁移的直接证据

- `OptionsMoved.tsx` 明确写着“设置已经集中到 Popup”，但 Options 实际入口仍挂载 `OptionsWorkspace → SettingsWorkspace`。
- 单元测试声称“旧 Options 只做兼容跳转”，却只检查入口文件是否包含字符串 `OptionsMoved`；当前这个字符串只存在于注释中，测试仍通过。
- 浏览器 E2E 同时明确要求 Options 展示完整设置和浏览器模型音色库，也通过。

因此，两个相反的产品契约目前同时为绿色。

## 四、真实流程走查

### Step 1：Popup 日常控制 — 健康度：中

![Popup 主界面](../../extension-wxt/.tmp-settings-refactor-audit/01-popup-main.png)

优点是来源、速度和常用控制集中；问题是设置入口隐藏在当前来源的“管理语音来源”中，且当前截图同时出现连接异常，用户很难区分网页连接、TTS 连接和设置状态。

### Step 2：Popup 语音来源总览 — 健康度：中偏低

![Popup 语音来源总览](../../extension-wxt/.tmp-settings-refactor-audit/02-popup-provider-overview.png)

五种来源都可发现，但这里主要是配置入口，不是完整的“选择来源 + 选择音色”任务。状态文案依赖静态推导，不能代表真实连接结果。

### Step 3：Popup 本地 TTS — 健康度：差

![Popup 本地 TTS](../../extension-wxt/.tmp-settings-refactor-audit/03-popup-local-service.png)

表单只有适配器、Base URL、模型、访问令牌和保存/检测。唯一的下拉框是“适配器”，没有音色选择，也没有“读取音色”或“测试所选音色”。这与用户反馈完全一致。

### Step 4：Popup 在线 TTS — 健康度：未验证

![Popup 在线 TTS](../../extension-wxt/.tmp-settings-refactor-audit/04-popup-online-tts.png)

在线 TTS 有模型、音色、格式、密钥和试听短句，但主要操作位于内部滚动区域下方；必填字段不完整时主操作仍主要依赖点击后的错误恢复。真实 API 未在本轮调用。

### Step 5：Options 日常设置 — 健康度：中

![Options 日常设置](../../extension-wxt/.tmp-settings-refactor-audit/05-options-reader.png)

这套界面更适合长期设置，层级也比 Popup 稳定，但它与 Popup 的外观、来源、AI、快捷键和数据功能重复。

### Step 6：Options 语音来源 — 健康度：差

![Options 语音来源](../../extension-wxt/.tmp-settings-refactor-audit/06-options-engine.png)

五个 Provider 的完整配置纵向堆在一页，页面非常长。来源选择、模型缓存、本地连接、OpenAI、豆包全部同时出现，用户无法快速回答“我当前只需要配置哪一个”。本地服务仍没有音色选择。

### Step 7：Options 声音库 — 健康度：差

![Options 声音库](../../extension-wxt/.tmp-settings-refactor-audit/07-options-voice-library.png)

这里能管理浏览器模型的 103 个音色缓存，却不能在同一处把音色设为当前音色。下载/修复/试听在 Options，选择当前音色在 Popup；本地服务声音又要进入声音工作室。

### Step 8：旧声音工作室设置中心 — 健康度：差

![旧声音工作室设置中心](../../extension-wxt/.tmp-settings-refactor-audit/08-legacy-voice-studio.png)

声音工作室仍带有“阅读与显示 / 朗读引擎 / 音色与克隆 / 存储与数据”四套设置导航。当前使用系统语音时，“音色与克隆”被禁用，但同页又显示系统音色分配；界面风格和 React 设置中心也明显不同。

## 五、主要问题与根因

### P0-1：设置所有权没有收敛

三个设置中心都能写 `qwenReaderSettings`。新旧 UI、旧 Provider 设置脚本和声音工作室因此可以覆盖同一数据，但它们展示的字段、默认值和验证方式不一致。

直接风险：

- 一个页面保存后，另一个页面显示旧状态或不同解释。
- 修复只落在某个 UI，其他入口继续复现。
- 发布测试无法明确哪一个页面才是产品真相。

### P0-2：音色任务被按技术实现拆散，而不是按用户任务组织

当前实际路径：

- 浏览器系统音色：Popup 主界面选择。
- 浏览器模型音色：Options 下载/修复/试听，Popup 主界面选择。
- 本地服务音色：服务页配置连接，Popup 在切换为当前 Provider 后才可能显示音色；声音资产管理又在旧工作室。
- OpenAI 音色：Provider 表单手填，但正常播放还有另一份默认音色状态。
- 豆包音色：Provider 表单手填音色 ID。

本地音色下拉框只有在“本地服务已经成为当前来源、`/v1/audio/voices` 成功返回非空列表”时才会出现在 Popup 主界面。列表为空或请求失败时，组件直接不渲染下拉框，也没有就地恢复入口。

### P0-3：连接状态不是可信状态机

`providerStates()` 只真正读取浏览器模型状态；本地、OpenAI 和豆包都被静态标记为 `ready: false`。Popup 在测试成功后只临时把当前 React 状态改成 ready，关闭或重开后又恢复“待检测”。

代码已经声明并读取 `lastTestedAt`，但保存和测试成功路径没有写入它，只写 `lastConfiguredAt`。因此“已配置”“已授权”“已连通”“已返回声音”“已完成合成”没有被区分。

本地“保存并检测”只调用 `/health`，不会同时验证音色列表和所选音色的合成。于是健康检查成功也不能证明用户可以选音色或真正播放。

### P0-4：音色状态存在重复真相，在线音色尤其危险

当前同时保存：

- `providerVoices[providerId]`
- `voiceAssignmentsByProvider[providerId].narratorVoiceId`
- Provider 配置中的 `voice`
- 兼容字段 `opVoice` / `replyVoices`

Popup 每次更换音色必须同时写前两处。OpenAI Provider 表单修改的是 `providerSettings['openai-compatible'].voice`，但普通播放优先注入 `providerVoices['openai-compatible']`。同时 OpenAI 音色列表实现读取的是不存在于当前 Schema 的 `config.voices`，否则固定返回 `alloy`。

结果是：在线试听可能使用用户刚填的音色，而普通朗读仍使用旧的 `alloy`。这是需要在重构前先加回归测试的高风险缺口。

### P0-5：API 路径“有实现”，但没有形成发布级验证证据

现状需要分开评价：

- OpenAI 和豆包的“保存并试听”会发起真实合成，请求短句并校验返回音频；不是纯占位 UI。
- 本地服务只做健康检查，不验证音色与合成。
- 成功结果不会形成可靠、持久、可失效的验证记录。
- 单元测试使用 Mock Fetch 验证协议映射；没有覆盖 Popup/Options → 权限 → 保存凭据 → `provider:test` → 状态持久化的完整 E2E。
- 没有真实供应商凭据和端点的手工发布记录。

因此当前只能说“适配器代码路径存在”，不能说“API 连接已验证”。

### P1-1：Popup 承担了不适合瞬时窗口的任务

模型下载、103 音色管理、长表单、权限请求、API 试听和错误恢复都可能需要数十秒甚至更久。Popup 会因失焦关闭，也只有 420×600 的内部滚动空间。这使“点击后没反应”与“页面已经关闭/跳转/在下方显示状态”很难区分。

### P1-2：信息密度与可访问性风险

Popup 大量说明、状态与按钮文字使用 8–10px 字号。虽然 React 界面有键盘焦点样式，当前字号和多层内部滚动仍会增加低视力、缩放和触控使用难度。截图不能证明完整 WCAG 合规；仍需键盘、200% 缩放、读屏与状态播报测试。

### P1-3：旧实现已发生语义漂移

旧声音工作室仍展示 Hugging Face Repo/revision，而新 Schema 默认使用 ModelScope；`local-qwen` 与 `local-service`、`activeProviderId` 与 `providerId` 仍通过兼容层并存。兼容层已经从“迁移工具”变成了长期业务逻辑。

## 六、目标信息架构

### 1. Popup：只做快捷控制

保留：

- 播放/暂停/上一句/下一句
- 当前已启用且可用的语音来源
- 当前音色
- 速度
- 本页配音
- 一个明确的“打开设置”按钮

移除：

- PopupSettingsCenter 的 Provider 长表单
- 模型下载与删除
- API Key 管理
- AI Profile 编辑
- 数据导入/导出与恢复默认

### 2. 唯一完整设置中心：Options

建议顶级导航收敛为四类：

1. **阅读**：播放方式、网页交互、外观、快捷键。
2. **语音与音色**：来源、连接、模型、音色选择、角色配音、声音资产入口。
3. **OCR 与翻译**：AI Profile 与默认用途。
4. **数据与诊断**：导入导出、缓存、故障报告、恢复默认。

“语音与音色”页面顶部只展示当前来源和状态；下方只展开当前正在配置的 Provider，不再把五个长表单全部堆在一页。

### 3. 声音工作室：只做声音资产

保留：录音、文件导入、参考文本、克隆、试听、重命名、删除、批量处理。

移除：阅读与显示、朗读引擎、存储与数据、全局配音算法。工作室通过 `providerId` 上下文打开，完成后返回唯一设置页。

## 七、统一的 Provider 与音色流程

| Provider | 配置 | 验证 | 音色列表 | 选择与试听 |
|---|---|---|---|---|
| 浏览器系统语音 | 无 | 读取浏览器音色 | 系统返回 | 同页选择并试听 |
| 浏览器模型 | 模型来源/设备 | 模型校验 + 选中音色缓存校验 | 103 个目录，显示缓存状态 | 同页下载、选择、试听 |
| 本地服务 | 适配器/地址/令牌 | `/health` + `/voices` + 选中音色短句合成 | 后端返回 | 同页选择；空列表给出明确错误与恢复 |
| OpenAI 兼容 | 地址/模型/Key | 用户确认的短句合成 | 若服务不支持列表则使用手工音色 ID | 测试的音色就是正常播放使用的音色 |
| 豆包 | App/Resource/Key | 用户确认的短句合成 | 配置的音色 ID | 测试、选择和播放使用同一 ID |

统一页面必须显示明确状态：

`未配置 → 已配置未验证 → 验证中 → 可用 / 验证失败 / 配置已变更需重验`

在线服务的“保存并试听”需明确提示只发送试听短句且可能计费；本地服务则必须在 health 成功后继续读取音色，不能把 health 等同于可播放。

## 八、数据模型建议

升级到 Schema V7，并只保留以下单一真相：

```text
activeProviderId
providerConfigs[providerId]
defaultVoiceIdByProvider[providerId]
roleOverridesByProvider[providerId]
providerVerification[providerId]
```

规则：

- `defaultVoiceIdByProvider` 是 Popup、设置页和普通朗读共同读取的唯一默认音色。
- 楼主默认使用 `defaultVoiceIdByProvider`；角色配置只保存回复池和例外覆盖，不重复保存旁白音色。
- Provider 配置不再单独保存另一个 `voice`；协议层从统一默认音色生成请求字段。
- `providerVerification` 保存 `lastVerifiedAt`、配置指纹、已验证音色和能力快照。配置或凭据改变后状态立即变为“需重验”。
- `providerVoices`、旧 narrator 字段、`opVoice`、`replyVoices`、`local-qwen` 和 `providerId` 只在 V6→V7 迁移时读取；迁移后不再由 UI 双写。
- 密钥继续独立存放在 session/remembered secret storage，不进入公开设置、导出或诊断。

## 九、实施顺序

### Phase 0：先锁定产品契约和失败测试

- 明确 Options 为唯一完整设置中心。
- 把“Options 仅跳转”和“Options 必须展示完整设置”这两条相反测试合并为一个真实契约。
- 测试实际渲染的组件，不再用可被注释满足的字符串断言。
- 为 OpenAI 音色一致性、本地 voice list、验证状态持久化先写失败测试。

### Phase 1：统一 Schema 与 Provider 状态机

- 实现 V7 幂等迁移。
- 移除 UI 双写，统一默认音色。
- 建立 configured / verified / stale / failed 状态。
- 本地验证链加入 voices 和短句合成；在线验证记录配置指纹。

### Phase 2：重做“语音与音色”单一流程

- 在 Options 同一页面完成 Provider 配置、验证、音色选择和试听。
- 浏览器模型音色目录增加“设为当前音色”，不再只做缓存管理。
- 本地服务连接成功后原地加载音色；失败时显示具体阶段与恢复操作。
- Popup 只镜像统一状态，并深链到 Options 对应 Provider。

### Phase 3：收窄声音工作室并清理旧入口

- 删除声音工作室中的阅读/引擎/存储设置导航。
- 停止加载 `settings-center.js` 和 `provider-settings.js`。
- 清理旧 Popup 文件和长期兼容字段，但保留一次性数据迁移测试。
- 更新 README、发布说明和截图测试。

## 十、验收标准

1. 浏览器工具栏中只有一个“设置”入口，任何管理按钮都打开同一个 Options 页面并定位到正确区域。
2. Popup 不再包含 API Key、模型下载、导入导出等长任务。
3. 四类 TTS 来源的默认音色都能在“语音与音色”同一页选择；Popup 立即镜像相同值。
4. 本地 health 成功但 voices 失败时不得显示“可用”；voices 为空时必须显示明确错误和恢复入口。
5. OpenAI 试听音色与普通朗读音色完全一致，不再回退到另一份 `alloy`。
6. Provider 配置改变后，之前的成功验证自动失效。
7. V6→V7 迁移幂等，旧用户的来源、默认音色、回复池和作者覆盖不丢失。
8. Playwright 从发布源 `extension/` 覆盖：设置深链、本地验证三种失败、在线 401/404/超时/非音频/成功、浏览器模型下载后选择、Popup 镜像。
9. 真实发布前跑 `pnpm e2e:browser` 和 `pnpm e2e:release`；云 API 另保留一次带测试账号的供应商烟雾记录。
10. 完成键盘、焦点、200% 缩放、读屏状态播报和小尺寸 Popup 回归。

## 最终建议

把这次工作定义为“设置系统重构”，不要定义为“本地音色下拉框修复”。第一步应先锁定一个完整设置中心和一份音色真相，再修具体 Provider。否则任何局部修复都会继续被另外两套入口和兼容字段覆盖。
