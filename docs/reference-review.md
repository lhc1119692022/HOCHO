> **2026-11-11 更新（0.7.0）**：本地 Relay、独立悬浮窗 / 侧边栏、窗口/屏幕共享已经去掉。插件只有原来的弹窗，Key 在弹窗设置里填。当前实际行为以 README.md 为准；本文保留作讨论记录。

# 参考项目评审：snooper-browser

参考项目：[xiukun/snooper-browser](https://github.com/xiukun/snooper-browser)（Apache-2.0）。
它不是 MOSS Live 项目，而是一个浏览器内多模态/字幕工作台。以下只记录对本项目有实际价值的部分。

## 值得学习

1. **权限失败要说人话**
   `src/lib/permissions.ts` 把 `NotAllowedError`、`NotFoundError`、`NotReadableError`、`AbortError` 分别映射成中文行动提示，而不是直接显示 DOMException。本项目沿用了这个原则（见 `src/live/session.js` 和 `src/permission`）。

2. **采集会话要有 generation / 取消语义**
   `captureGeneration` 和 `startLocks` 处理了“停止发生在启动过程中”的竞态，避免一个已经停止的 `getUserMedia` 留下活跃录音流。本项目在 `CompanionSession` 中保留 `stopping` 状态，并用 `switchTabAudio` 的新旧流顺序处理类似问题。

3. **不要假设截图一定可用**
   `chrome.tabs.captureVisibleTab` 在存在 `tabCapture` 活跃流时会失败。参考项目优先使用 capture 的 video track 取帧，失败才回退截图。本项目的 `TabAudioCapture` 同时保留视频轨，`ScreenSource` 优先从视频元素取帧，失败回退 `captureVisibleTab`。

4. **历史消息要按稳定 key 更新**
   参考项目 `chat-state.ts` 防止“答案已经由 session update 送达，又被本地追加一次”。本项目为每条消息使用稳定 ID（用户 turn、Agent `run_id`），流式事件只更新同一 ID。

5. **配置与密钥分离**
   参考项目 README 明确声称“no bundled keys”，但浏览器扩展如需访问 MOSS Live，浏览器 WebSocket 不能设置 `Authorization`。它也承认“browser WebSocket cannot send Authorization”。本项目因此采用本地 Relay：Key 只在 `.env`，插件只连 `127.0.0.1`。

## 需要纠正 / 不完全适用

1. **参考项目的实时字幕主要是 HTTP ASR/翻译，不是 MOSS Live 全双工 WebSocket**
   它可以借鉴音频分段、噪声门、ASR 幻觉过滤，但不能直接复刻 MOSS Live 协议。

2. **“no backend” 对 MOSS Live 不成立**
   浏览器原生 WebSocket 无法设置鉴权头；除非使用我们之前那种 `declarativeNetRequest` 改头方案（依赖 Chrome 版本且很难处理真实服务端的其他拒绝），否则必须有本地 Relay 或代理。Relay 是本项目明确选择。

3. **页面内工具栏不适合作为陪看窗口**
   参考项目把工具栏注入页面 DOM；一旦从 B 站切到 YouTube，工具栏留在原页面。本项目将主界面做成 Side Panel，并提供独立 Chrome 窗口 / Document Picture-in-Picture，不绑定页面 DOM。

4. **参考项目没有 MOSS Live 的“一个说话人/一条连接”约束**
   MOSS Live 文档明确“一条连接只接一个说话人”。如果为了“让 TA 听视频”把视频声和麦克风混成单声道，服务端会把视频台词当用户说话，触发错误 VAD。本项目的处理是：麦克风独占用户语音轨，视频声音走本地回放/音量压低 + 静默文字线索，不混音。

5. **参考项目的窗口/屏幕能力依赖 `getDisplayMedia` 用户选择**
   这适合 Web 应用，但 Chrome 扩展里 `desktopCapture.chooseDesktopMedia` 能给 offscreen 一个可消费的 `streamId`，更适合 MV3 的 Side Panel/offscreen 架构；本项目的窗口/屏幕模式采用后者。

## 对本项目的影响

- 保留参考项目的“错误可操作、历史不可覆盖、采集可恢复、Key 不落地插件”的思想；
- 替换其页面内工具栏和不适合 MOSS Live 的 HTTP 字幕路径；
- 新增本地 Relay、Side Panel、独立悬浮窗、`session_id` 持久化和 MOSS Live 专用协议适配。
