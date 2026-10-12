# 代码导航

本文帮助定位职责和调用链，编码约束见 [AGENTS.md](AGENTS.md)，运行方法见 [README.md](README.md)。

## 从哪里开始读

| 目录／入口 | 职责 | 阅读重点 |
|---|---|---|
| `services/api/src/main/java/com/lycansync/api` | 认证、群组、聊天、状态和 RTC 凭证 | Controller → Service → Mapper；事务与业务异常 |
| `apps/web/src/AuthRoot.vue` | 登录与已登录界面的入口 | 会话建立、过期和退出 |
| `services/api/src/main/java/com/lycansync/api/auth/service/AccessLinkService.java` | 服主激活、单人邀请和恢复 | 链接行锁、一次性消费与会话原子替换 |
| `apps/web/electron/access-links.cjs` | 安装版邀请唤起校验 | 仅接受固定协议、HTTPS 服务器和一次性凭据 |
| `apps/web/electron/startup-update.cjs` | 安装版单次启动更新 | 主进程持有唯一检查任务；进入业务前校验、安装，跳过及迟到结果不能触发后续安装 |
| `apps/web/src/components/AccountAccessPrompt.vue` | 邀请确认 | 先检查，用户确认后兑换；已登录时保留原会话 |
| `apps/web/src/components/GroupEntryDialog.vue` | 创建／加入群组弹窗 | 管理表单、裁剪和提交状态；创建结果由 App 更新，加入暂仅预览 |
| `apps/web/src/profile/useAvatarCrop.ts`、`components/AvatarCropDialog.vue` | 头像选择和裁剪 | 先验证解码再展示；选择模块释放位图和对象 URL，裁剪器只输出 512 像素 PNG |
| `services/api/src/main/java/com/lycansync/api/common/image/AvatarImageProcessor.java` | 个人及群组头像规范化 | 检查裁剪载荷与解码尺寸，统一 256 像素 PNG 后保存；不上传原图、不新增存储链路 |
| `apps/web/src/components/InlineFeedback.vue`、`auth/authApi.ts` | 就近反馈与 HTTP 错误解析 | 固定反馈区不推动布局；保留状态／业务代码并统一空正文错误文案 |
| `apps/web/src/components/settings/MemberAccessSettings.vue`、`settings/useMemberAccess.ts` | 服主管理 | 就近展示生成／复制反馈；可见时轮询当前页记录，隐藏及销毁时停止，刷新不丢失原链接或成员选择 |
| `apps/web/src/App.vue` | 群组界面、状态同步、音频设置和共享选择编排 | 用户动作如何进入 RTC；页面状态不等于媒体资源 |
| `apps/web/src/components/ScreenSharePicker.vue`、`nativeVideoSourceSelection.ts` | 共享选择界面与来源快照 | 组件管理展示与焦点，来源模型管理排列和预览；App 持有刷新任务并把选择交给 RTC |
| `apps/web/src/components` | 聊天、成员、播放和诊断组件 | props / emit、轨道展示、挂载与销毁 |
| `apps/web/src/rtc/useRtcRoom.ts` | 房间连接、普通媒体采集发布、权限及离房清理 | 房间与任务身份；资源创建和停止路径 |
| `apps/web/src/rtc/screenShareStage.ts` | 本机四槽舞台与观看排列 | 自动补位、手动排除、替换顺序和单路观看；不停止采集 |
| `apps/web/src/rtc/screenShareViewing.ts`、`localScreenPreview.ts` | 远端观看需求与本地预览可见性 | 可见位置合并接收质量；隐藏不停止通话或对外共享 |
| `apps/web/src/rtc/remoteControlSession.ts` | 远控申请、授权、输入发送和撤销 | 申请标识、授权归属、迟到响应与释放 |
| `apps/web/electron/main.cjs` | 桌面窗口、HTTP 代理、IPC、音视频桥接 | 可信发送方校验、会话与主进程资源 |
| `apps/web/electron/media-helper.cjs` | 管理 helper 子进程与请求响应 | 启动、超时、当前会话和退出 |
| `apps/web/electron/preload.cjs`、`apps/web/src/desktop.d.ts` | 主进程与页面之间的固定接口 | 两端参数与事件必须同步 |
| `native/media-helper/src/lib.rs`、`protocol.rs` | 原生协议入口和运行时编排 | 命令分发、错误码、采集会话 |
| `native/media-helper/src/audio_capture*`、`audio_processing.rs` | WASAPI 麦克风与 Sonora 处理 | worker、设备格式、队列和停止 |
| `native/media-helper/src/screen_audio*` | 共享声音采集 | 应用声音／系统混音的平台边界 |
| `native/media-helper/src/sources*`、`capture*`、`d3d.rs` | 来源发现、视频采集和共享纹理 | 来源有效期、帧与 GPU 资源 |
| `native/media-helper/src/remote_input.rs` | 原生输入授权、注入和释放 | 身份与会话校验、按住状态、失败重试 |
| `native/media-bridge` | Electron 可调用的共享纹理原生桥 | helper 身份、纹理句柄复制与释放 |
| `native/activity-helper` | 检测运行中的 Steam 游戏，优先选择前台游戏 | 输出经桌面端进入成员状态链路；闲置时间由 Electron 获取 |

## 两条主要音视频链路

### Windows 桌面

```text
用户操作 → App.vue → useRtcRoom.ts → 原生会话对象
    → preload 固定 IPC → Electron main / MediaHelperManager
    → Rust helper → WASAPI 或 Windows 图形采集

音频：处理后的 PCM → 命名管道 → Electron → AudioWorklet → LiveKit 音轨
视频：共享纹理 → media-bridge → Electron → VideoFrame → LiveKit 音轨
```

`nativeMicrophoneAudio.ts`、`nativeScreenAudio.ts` 和 `nativeScreenVideo.ts` 持有页面侧资源。Worklet 在音频渲染线程消费队列；延后确认用于限制积压，不是远端播放确认。`useRtcRoom.ts` 负责把这些资源接入当前房间并协调停止。

共享声音的启动或发布失败只清理该声音轨道并提示仅共享画面；视频发布失败仍结束本次共享。观看端移出舞台、隐藏页面和全屏切换只改变本机显示或接收需求，不改变发送端采集及公开权限。当前舞台请求主层、小窗请求低层，尚无按舞台路数进一步调低分辨率的策略。

### 浏览器

```text
用户操作 → useRtcRoom.ts → Chromium 采集
    → 麦克风处理器（适用时）→ LiveKit 发布 → 远端订阅与播放
```

浏览器链路仍有用途，不能因为桌面换用 Rust 就删除。桌面原生失败不会静默改用浏览器采集。

桌面不再提供 Chromium 共享来源选择 IPC；误调用 `getDisplayMedia` 会被主进程明确拒绝。`desktopCapturer` 仅用于选择器的静态缩略图，不持有正式视频流。

## Rust 阅读路线与资源边界

推荐按调用顺序阅读，先看管理器如何持有会话，再看 Windows worker 如何操作设备：

- 麦克风：`audio_capture.rs`（启动、配置、停止和 worker 回收）→ `audio_capture/windows.rs`（WASAPI 采集线程、管道写入线程、队列和设备资源）→ `audio_processing.rs`（Sonora 处理顺序与 10 ms 输出块）。`screen_audio.rs` / `screen_audio/windows.rs` 展示共享声音对应的管理器、格式转换和独立队列。
- 视频：`lib.rs`（命令循环和 Runtime）→ `sources.rs`（来源注册与 revision）→ `sources/windows.rs`（窗口身份和 WinRT 来源发现）→ `capture.rs` / `capture/windows.rs`（视频会话、帧回调、停止及纹理槽位）→ `d3d.rs`（设备创建与 WinRT apartment）→ `native/media-bridge/src/lib.rs`（跨进程句柄副本）。

读这些实现时，可按本项目的实际用途理解常见类型：`Option` 表示尚无当前会话或诊断值，`Result` 携带启动、设备和清理错误；`Arc` 将配置、队列或诊断状态交给工作线程，`Mutex` 保护其中的可变数据。`Drop` 负责兜底停止 Worker、撤销 COM/WinRT 初始化或关闭句柄；`cfg(target_os = "windows")` 隔离平台 API，`cfg(feature = "shared-texture-output")` 隔离共享纹理输出。`unsafe` 集中在 Windows FFI 边界；检查时关注调用线程、外部句柄/缓冲区有效期和释放责任，例如来源回调参数、WASAPI 格式内存、WGC 帧对象及 media-bridge 的本地句柄副本。

音频队列容量代表最多可暂存的短块数；饱和时的丢块诊断与设备实际采集/处理统计不是同一个指标。视频 `dropped_notifications` 统计唤醒通知队列饱和，不代表 WGC 丢帧；帧接收、处理、时间戳异常和纹理槽位无法输出分别记录在不同诊断项。修改这些指标前先沿调用链确认计数发生的位置。

## 状态和权限要区分

- 房间身份、普通共享标识、原生采集 `sessionId`、远控授权标识和轨道 `trackSid` 各有用途，不可混作一个“连接 ID”。
- `eligibleTracks` 表示应用认定的公开媒体资格；`publishedSids` 表示当前实际发布。SDK 临时重发布只替换 SID；主动结束先撤销资格。
- 成员在线与活动来自业务 HTTP 状态链路，不由是否加入 LiveKit 推断。
- 当前远控依赖已有整屏共享；私密画面、自动切换与恢复尚未实现，具体边界见 README。

## 测试与工具边界

- `*.test.ts`、`electron/media-helper.test.cjs` 和 Rust 内嵌测试验证受控逻辑；`native/media-helper/tests/helper_process.rs` 验证子进程协议。
- `apps/web/tests` 是浏览器／桌面集成测试，可能启动服务或客户端，执行前确认影响。
- `electron/shared-texture-bridge.test.cjs` 仍引用 `shared-texture-smoke/main.cjs` 及 Rust `shared_texture_smoke` 示例，用合成纹理验证桥接与句柄释放。这组文件是测试依赖，不能按名称删除；运行会启动临时 Electron。
- 视频诊断探针仍由 `MediaDiagnostics.vue` 和固定 IPC 调用；它验证取帧和元数据，不是第二条正式视频发布链路。

## 后续整理顺序

先按调用链阅读，再补充缺失的职责和清理说明。`App.vue`、`useRtcRoom.ts`、Electron 主进程和原生运行时较大，后续仅在具体修改涉及多种独立职责时考虑局部拆分。Rust 文件中的内嵌测试不能作为拆分生产模块的依据。

麦克风与屏幕声音的页面会话和 Worklet 有相似流控，但声道、格式和启动约定不同；当前不为减少行数引入通用音频框架。新模块沿用已有语言风格，避免大批格式改动掩盖业务差异。
