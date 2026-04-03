# Living Room Mode — 大屏纯享页框架设计

> 版本：0.1  
> 日期：2026-04-02  
> 目标：为 NAS Bridge 新增一个适合客厅电视、投影和大屏浏览器的纯享页，并为后续 Android TV 壳应用复用同一套页面打基础。

配套细化文档：

- [LivingRoomFocusModel.md](LivingRoomFocusModel.md)
- [LivingRoomAndroidTVShell.md](LivingRoomAndroidTVShell.md)

---

## 1. 目标与边界

### 1.1 目标

新增一个独立的大屏页，用于把现有文件索引里“可以直接播放的内容”以 10-foot UI 的方式展示出来，重点解决以下问题：

1. 在电视上直接浏览和播放视频、音频内容。
2. 操作方式适配鼠标、键盘和遥控器方向键，不依赖精细触控。
3. 尽量复用现有 Web 播放、P2P、HLS、缩略图、鉴权和分享链路。
4. 页面本身既能在浏览器里独立打开，也能被后续 Android TV App 直接复用。

### 1.2 v1 范围

第一阶段只覆盖“可播放媒体库”场景：

- 视频文件：`video/*`
- 音频文件：`audio/*`
- 扩展名兜底：`mkv/mp4/mov/m4v/webm/avi/mp3/flac/wav/m4a/aac/ogg`

第一阶段不把以下内容塞进大屏页主流程：

- 上传、管理、终端监控、用户管理
- 文本文件、PDF、普通图片的通用预览
- 聊天室、评论面板、复杂编辑动作
- 完整文件树管理体验

### 1.3 v2 可扩展项

后续可以逐步加入：

- TV 直播源入口，复用现有 `TVStream` 的 HLS 能力
- 最近播放、按目录聚合影视库
- 文件弹幕开关
- 二维码登录 / 配对登录
- Android TV 原生壳层增强

---

## 2. 为什么做成独立入口页

当前仓库已经不是单入口 Web：

- `web/index.html` -> `src/main.jsx`
- `web/share.html` -> `src/share-main.jsx`
- `web/vite.config.js` 已经支持多入口打包

因此大屏纯享页最合适的方案不是塞进现有 `App.jsx` 的工作台标签里，而是新增第三个独立入口：

```text
web/living-room.html
  -> web/src/living-room-main.jsx
  -> web/src/LivingRoomPage.jsx
```

这样做有几个直接好处：

1. 可以彻底去掉后台工作台的侧边栏、管理信息和噪音 UI。
2. 电视端可以直接把这个页面设为启动页，不需要先进控制台再切标签。
3. Android TV App 后续只需要加载这个 URL，不需要理解整个后台工作台结构。
4. 不必为了一个新页面把当前 `App.jsx` 强行改成完整路由系统。

---

## 3. 复用策略

### 3.1 复用现有能力

大屏页不应该重造底层能力，优先复用这些现有模块：

1. 认证与 API 访问：复用 `apiRequest`、`/api/me`、`/api/files`、`/api/clients`。
2. P2P 控制面：复用 `P2PBridgePool`。
3. 预览传输链路：复用现有预览 / HLS / 转码逻辑，而不是新写一套播放器协议。
4. 视频容器与控制条：优先复用 `VideoViewportSurface.jsx` 和 `VideoPlayerControls.jsx`。
5. 缩略图 / 封面：复用当前浏览器和分享页里的 `thumbnailFile` 与预览首帧能力。
6. TV 流媒体播放：后续接入直播时复用 `TVStream.jsx` 里的 HLS 初始化经验。

### 3.2 需要先抽出来的公共层

当前有一些播放能力散落在 `App.jsx`、`SharePage.jsx` 和 `PreviewModal.jsx` 中。为了让大屏页真正可复用，建议先抽出以下公共层：

```text
web/src/media/mediaCapabilities.js
  - isVideoMime
  - isAudioMime
  - isTextPreviewMime
  - canBrowserPlayVideoMime
  - guessPlayableByExtension

web/src/media/mediaSession.js 或 useMediaSession.js
  - 统一打开视频/音频
  - 统一决定直放 / blob / HLS / 转码
  - 统一封装播放态、错误态和恢复策略

web/src/media/playableLibrary.js 或 usePlayableLibrary.js
  - 从 /api/files 结果中过滤 playable 内容
  - 分组、排序、生成 shelf 数据
```

如果不先做这一步，大屏页很容易复制一份 `App.jsx` 里的播放分支，后面维护会很重。

这里要特别强调：

1. 复用的是媒体能力和传输链路，不是直接把 `PreviewModal.jsx` 原样搬到大屏页。
2. `PreviewModal.jsx` 更适合桌面弹窗预览，客厅页应复用底层会话和播放器部件，重新组织 UI 壳层。

---

## 4. 页面形态

### 4.1 页面定位

页面不是“文件管理器大屏版”，而是“客厅媒体入口”。

它应该更像媒体中心：

- 打开后优先看到可播放内容，而不是一堆文件元数据
- 默认暗色、低反光、远距离可读
- 鼠标可操作，但所有核心路径都能靠方向键 + OK + Back 完成
- 独立入口使用独立的深色主题和 CSS 变量，不继承控制台当前的亮色工作台视觉

### 4.2 页面主状态

建议把页面明确分成 5 个状态：

1. `booting`：校验 token、初始化 P2P。
2. `loading-library`：加载媒体库、缩略图、继续观看数据。
3. `browsing`：展示媒体货架与焦点卡片。
4. `playing-video` / `playing-audio`：大屏播放状态。
5. `error`：鉴权失败、文件不可播、P2P / HLS 建立失败。

### 4.3 页面布局

推荐采用“双层界面”：平时是浏览层，点开后进入沉浸播放层。

#### 浏览层

```text
┌────────────────────────────────────────────────────────────┐
│ 顶部状态条: Logo / 当前用户 / 时间 / 网络状态 / 设置       │
├────────────────────────────────────────────────────────────┤
│ Hero 区: 当前推荐 / 精选内容                               │
├────────────────────────────────────────────────────────────┤
│ Shelf 1: 最近视频                                          │
├────────────────────────────────────────────────────────────┤
│ Shelf 2: 继续观看                                           │
├────────────────────────────────────────────────────────────┤
│ Shelf 3: 收藏 / 星标                                        │
├────────────────────────────────────────────────────────────┤
│ Shelf 4: 音乐                                               │
└────────────────────────────────────────────────────────────┘
```

#### 播放层

```text
┌────────────────────────────────────────────────────────────┐
│ 全屏视频 / 专辑封面 / 背景氛围层                            │
│                                                            │
│   中部: 媒体主视图                                          │
│   底部: 超大控制条                                          │
│   右侧: 播放队列 / 下一项 / 信息抽屉                        │
│   顶部: 返回、标题、时间、码率 / 路由状态                   │
└────────────────────────────────────────────────────────────┘
```

---

## 5. 信息结构

### 5.1 数据来源

大屏页直接复用现有服务端数据：

1. `/api/me`：确认登录状态与当前用户，同时可拿到用户基础信息。
2. `/api/files`：获取已同步文件索引；当前接口已经把 `favorite` 状态合并到文件项里。
3. `/api/clients`：了解文件所在终端与在线状态。
4. 本地 `localStorage`：保存继续观看、最后焦点、最近播放、UI 偏好。

### 5.2 可播放内容筛选

媒体过滤逻辑建议统一成 `toPlayableItem(file)`：

```ts
interface PlayableItem {
  id: string;
  fileId: string;
  clientId: string;
  path: string;
  name: string;
  mimeType: string;
  size: number;
  updatedAt: string;
  kind: "video" | "audio";
  thumbKey: string;
  posterUrl?: string;
  coverUrl?: string;
  canDirectPlay: boolean;
  needTranscodeFallback: boolean;
}
```

规则：

1. 先按 MIME 判断。
2. MIME 不可靠时按扩展名兜底。
3. 默认排除已知缓存目录和系统目录，例如 `.nas-preview-cache`、`.nas-hls-cache`、`thumbs`、`video-covers`。
4. 客户端离线时内容仍可展示，但标记为“当前不可播放”。

### 5.3 货架组织方式

建议先做 4 组内容，避免首页过于空：

1. 最近更新视频：`kind = video`，按 `updatedAt desc`。
2. 继续观看：来自本地播放进度。
3. 收藏内容：复用现有 favorite 数据。
4. 音乐：`kind = audio`，按最近或目录聚合。

第二阶段再加：

1. 按目录聚合的影视库。
2. TV 直播入口。
3. 最近播放历史。

---

## 6. 交互模型

### 6.1 核心原则

大屏页的交互不能依赖 hover。焦点必须是第一公民。

要求：

1. 所有可操作元素都能获得明显焦点态。
2. 焦点移动必须稳定、可预测。
3. 任何时候按返回键都能回到上一级，而不是丢失状态。
4. 鼠标出现时不破坏方向键导航。

### 6.2 输入方式支持

#### 鼠标

- 点击卡片进入播放。
- 移动鼠标显示控制条。
- 滚轮纵向滚动货架区。

#### 键盘 / 遥控器

建议统一成以下按键映射：

| 输入 | 行为 |
|------|------|
| 上/下 | 在货架之间移动焦点 |
| 左/右 | 在当前货架内移动焦点；播放时快退/快进 |
| Enter / OK | 打开卡片 / 播放 / 确认 |
| Back / Escape | 关闭抽屉、退出播放层、返回浏览层 |
| Space | 播放 / 暂停 |
| Menu / M | 打开设置抽屉 |
| I | 打开媒体详情 |

### 6.3 焦点系统

建议采用“区域焦点 + 行内 roving tabindex”的模型，详细实现单独展开在 [LivingRoomFocusModel.md](LivingRoomFocusModel.md)：

```text
TopBar
Hero
ShelfRow[0]
ShelfRow[1]
ShelfRow[2]
PlayerControls
RightDrawer
```

每个区域内部维护一个当前焦点索引，切换区域时记住上次停留位置。

这样可以避免两个常见问题：

1. 一按方向键就跑到浏览器默认焦点链路里。
2. 货架滚动后焦点重置到第一项，用户体验很差。

### 6.4 大屏可用性指标

建议直接按电视标准做：

- 主字体不低于 24px
- 主要标题 36px 到 52px
- 焦点卡片外圈高对比描边 + 阴影
- 可点击目标高度不低于 56px
- 卡片间距不小于 16px
- 控件不要只用颜色区分状态

---

## 7. 播放器架构

### 7.1 视频播放

视频链路建议直接站在现有预览栈上，不再做第二套。

优先级：

1. 浏览器可直接播 -> 直接播。
2. 浏览器不可直放但可 HLS -> 走 HLS。
3. 需要转码 -> 复用现有 storage-client 转码与 HLS 产物。

页面层只关心：

- 当前文件
- 当前播放 URL / HLS manifest
- 播放状态
- 错误信息
- 继续观看进度

### 7.2 音频播放

音频模式不应该只是一个小播放器条，而应当有独立的大屏状态：

- 左侧或背景展示封面 / 缩略图
- 中央展示曲名、目录、终端来源
- 底部是超大播放控制条
- 右侧可展开播放队列

### 7.3 继续观看

建议 v1 就做本地继续观看，但存储需要按用户隔离，避免电视共用账号时串进度：

```ts
living_room_progress_v1:${userId} = {
  [fileId]: {
    currentTime: number,
    duration: number,
    updatedAt: string,
    clientId: string,
    path: string
  }
}
```

用途：

1. 首页生成“继续观看”。
2. 重新播放时从上次位置续播。
3. 卡片上展示进度条。

### 7.4 控制层

建议直接复用 `VideoViewportSurface` 和 `VideoPlayerControls`，但增加一个“大屏模式”变体：

- 按钮更大
- 默认只保留核心操作
- 支持方向键聚焦
- 支持自动隐藏控制层
- 右侧信息抽屉与队列抽屉不进入默认控制条

### 7.5 弹幕与高级功能

视频弹幕在现有预览页已经存在，但不建议第一阶段默认打开。

更稳妥的策略：

1. v1 仅预留接口，不在主流程暴露。
2. v2 再加“弹幕开关”，默认关闭。
3. 若开启，仅在视频播放层显示，不在浏览层显示任何复杂表单。

---

## 8. Web 与 Android TV 复用方案

### 8.1 建议路线

优先把大屏页做成标准 Web 页面，然后 Android TV App 只做一个薄壳。

```text
Browser / TV Browser / Android TV WebView
  -> 加载同一个 living-room.html
  -> 运行同一套 React 组件
```

### 8.2 为什么不先做原生 TV UI

当前项目核心能力都在 Web 侧：

- 鉴权
- API
- P2P
- 预览播放
- HLS
- 缩略图

如果第一步就为 Android TV 重写原生页面，会把同一套媒体逻辑拆成两份。收益很低，维护成本很高。

### 8.3 Android TV App 的职责

Android TV 壳应用建议只承担 5 个职责：

1. 打开指定大屏 URL。
2. 保持横屏和沉浸式全屏。
3. 处理 DPAD / Back / Menu 的兼容性转发。
4. 处理登录配对或 token 注入。
5. 在需要时桥接原生能力，比如保持唤醒、网络状态回传。

### 8.4 页面与 App 的边界

页面本身不依赖 Android 专属 API。

如果后续确实需要桥接，建议分成“Native -> Web 事件”和“Web -> Native 能力”两部分，详细设计见 [LivingRoomAndroidTVShell.md](LivingRoomAndroidTVShell.md)：

```ts
window.NASLivingRoomBridge?.getInjectedToken()
window.NASLivingRoomBridge?.setKeepScreenOn(true)
window.addEventListener("nas-tv-key", (event) => {
  // detail: { key: "back" | "menu" | "playPause" | ... }
})
```

但这类桥接应该是可选增强，不能成为网页正常运行的前提。

### 8.5 登录建议

电视上输入账号密码体验很差，登录策略应分阶段推进：

1. v1（底底）：TV 浏览器或 WebView 内手动登录，登录态保存在该容器自己的 `localStorage` 中。技术上最简单，但遥控器键盘输入体验极差，不建议作为正式上线的主路径。
2. v1.5（近期目标）：二维码 / 设备配对登录。TV 页面显示二维码，手机扫码授权，服务端下发 token。建议将此作为 TV 功能正式上线的前置条件，而非可选 polish。
3. v2+：在 v1.5 基础设施上做 token 自动轮换、多账号切换等进阶能力。

注意：Android TV WebView 与手机浏览器、桌面浏览器的 `localStorage` 彼此隔离，不能假设它们天然共享 `nas_token`。

---

## 9. 建议的文件结构

```text
web/
  living-room.html
  src/
    living-room-main.jsx
    LivingRoomPage.jsx
    styles.css                     // 追加 living room 样式块，或拆分独立 css
    media/
      mediaCapabilities.js
      useMediaSession.js
      usePlayableLibrary.js
    components/
      living-room/
        LivingRoomShell.jsx
        LivingRoomHero.jsx
        LivingRoomShelf.jsx
        LivingRoomCard.jsx
        LivingRoomPlayer.jsx
        LivingRoomTopBar.jsx
        LivingRoomQueue.jsx
        LivingRoomSettingsDrawer.jsx
```

说明：

1. `LivingRoomPage.jsx` 放在 `src/` 根层，和 `App.jsx`、`SharePage.jsx` 同级，符合当前仓库风格。
2. 复杂子组件放到 `components/living-room/` 下。
3. 媒体能力抽到 `media/`，给 `App.jsx`、`SharePage.jsx` 和新大屏页共同使用。

---

## 10. 分阶段实施步骤

### 阶段 0：确认范围与入口

目标：把“做成工作台一个标签页”与“做成独立入口页”彻底分开。

步骤：

1. 明确大屏页采用独立入口：`living-room.html`。
2. 明确 v1 只做视频和音频，不混入聊天、管理与复杂编辑。
3. 明确 Android TV 首期是 WebView 壳，不单独重做 UI。

交付物：

- 本设计文档
- 入口与目录结构决策

### 阶段 1：抽公共媒体层

目标：把散落在 `App.jsx`、`SharePage.jsx`、`PreviewModal.jsx` 的媒体能力抽成可复用模块。

步骤：

1. 提取 `isVideoMime`、`isAudioMime`、`canBrowserPlayVideoMime` 等工具到 `mediaCapabilities.js`。
2. 把“打开媒体预览”的核心流程提取成 `useMediaSession`。
3. 让 `SharePage.jsx` 和主应用先切到这层公共逻辑，确认没有行为回退。
4. 明确视频、音频、HLS、转码的统一状态结构。

完成标准：

1. 不再在新页面里复制 `App.jsx` 的媒体判断逻辑。
2. 预览链路已有一层公共抽象可直接复用。

### 阶段 2：新增独立入口页骨架

目标：先让页面可以单独打开、独立鉴权、独立加载基础数据。

步骤：

1. 新增 `web/living-room.html`。
2. 新增 `web/src/living-room-main.jsx`。
3. 在 `vite.config.js` 中加入 `living-room` 第三个入口。
4. 新增 `LivingRoomPage.jsx`，完成以下初始化：
   - 读取 `localStorage.nas_token`
   - 调用 `/api/me`
   - 创建 `P2PBridgePool`
   - 拉取 `/api/files` 与 `/api/clients`
5. `living-room-main.jsx` 使用独立的深色 Fluent 主题或自定义主题，不复用控制台入口的亮色主题。

完成标准：

1. 输入 URL 能直接进入大屏页。
2. 未登录时给出明确提示，而不是白屏。

### 阶段 3：实现可播放媒体库

目标：把文件索引自动转换为适合电视浏览的媒体库数据。

步骤：

1. 实现 `usePlayableLibrary(files, clients)`。
2. 输出 4 个基础 shelf：继续观看、最近视频、音乐、收藏。
3. 接入缩略图与封面加载。
4. 为离线终端内容增加“不可播但可见”的状态标记。

完成标准：

1. 首页不再出现普通文件项。
2. 页面打开后能稳定展示 1 级媒体入口，而不是文件树。

### 阶段 4：实现浏览层 UI

目标：先把大屏浏览体验做对。

步骤：

1. 完成顶部状态条、Hero 区、Shelf 行、媒体卡片。
2. 实现卡片焦点态、横向滚动与纵向切换。
3. 鼠标和方向键同时可用。
4. 增加空状态、加载骨架和错误态。

完成标准：

1. 在桌面浏览器全屏后，键盘方向键可完整操作首页。
2. 鼠标点击与 Enter 行为一致。

### 阶段 5：接入播放层

目标：真正打通视频 / 音频播放，不只是假列表。

步骤：

1. 用公共 `useMediaSession` 打开视频和音频。
2. 用 `VideoViewportSurface` + `VideoPlayerControls` 做大屏控制层。
3. 音频单独设计 Now Playing 界面。
4. 加入继续观看进度记录。
5. 加入播放失败回退提示。

完成标准：

1. 视频可全屏播放并支持暂停、快进快退、返回浏览层。
2. 音频可展示封面态并切换下一项。

### 阶段 6：实现遥控器友好交互

目标：让“只有遥控板”的场景也能顺手使用。

步骤：

1. 建立区域焦点模型和 roving tabindex，按 [LivingRoomFocusModel.md](LivingRoomFocusModel.md) 的 layer / zone / item 结构实现。
2. 统一处理 Arrow / Enter / Escape / Back / Space / Menu。
3. 增加焦点恢复，返回浏览层后回到原卡片。
4. 处理控制层自动隐藏和显隐切换。

完成标准：

1. 用键盘方向键能完整完成“打开页面 -> 选片 -> 播放 -> 返回”的闭环。
2. 不出现焦点丢失和浏览器原生滚动抢焦点的问题。

### 阶段 7：加入客厅场景增强

目标：把页面从“能用”提升到“适合长期放在电视上”。

步骤：

1. 增加最近播放和继续观看。
2. 增加设置抽屉：字幕、播放速度、控制层自动隐藏时间。
3. 增加网络状态与路由状态展示，例如 direct / relay / HLS。
4. 视需要加入 TV 直播 shelf 或单独入口。

完成标准：

1. 用户不用每次从头找内容。
2. 出现卡顿或回退时能看到清晰反馈。

### 阶段 8：Android TV 壳应用

目标：在不重写页面的前提下，做一个能安装到电视上的版本。

步骤：

1. 新建最小 Android TV 壳应用。
2. 默认打开 `living-room.html` 对应线上地址。
3. 处理沉浸式全屏、横屏、唤醒锁。
4. 视机型兼容性补 DPAD / Back 事件桥接，按 [LivingRoomAndroidTVShell.md](LivingRoomAndroidTVShell.md) 的 Native/Web 边界实现。
5. 后续再加二维码配对登录。

完成标准：

1. 电视 App 与浏览器页面使用同一套 React 页面。
2. 原生层只负责容器与系统桥接。

---

## 11. 风险与注意点

### 11.1 当前 `App.jsx` 过重

这是最大工程风险。大屏页如果直接复制 `App.jsx` 内的播放逻辑，会马上出现第二份巨型媒体状态机。

结论：必须先抽公共媒体层，再做页面。

### 11.2 电视端鉴权体验差

如果没有二维码配对，TV 端初次登录会比较痛苦。

结论：v1 接受手动登录，v2 补二维码配对。

### 11.3 WebView 的媒体兼容性

不同 Android TV WebView 对 HLS、全屏和方向键的支持会有差异。

结论：先在浏览器版把体验做稳，再做 TV 壳兼容层。

### 11.4 WebView 登录态隔离

TV 壳里的 WebView 不会自动继承用户手机或桌面浏览器里的登录态。

结论：v1 允许容器内单独登录，v2 再做设备配对注入。

### 11.5 大媒体库性能

如果一次渲染全部卡片，会让电视端明显变卡。

结论：Shelf 先按需渲染，缩略图懒加载，单行卡片数受控。

---

## 12. 推荐落地顺序

如果按最稳的路径推进，建议实际开发顺序如下：

1. 抽 `mediaCapabilities` 和 `useMediaSession`。
2. 新增 `living-room.html` 入口页。
3. 先做“最近视频 + 打开播放”最小闭环。
4. 再补“音乐”、“继续观看”、“收藏”。
5. 再补遥控器焦点系统。
6. 最后再做 Android TV 壳应用。

这个顺序的好处是每一步都能运行、能验证、能回滚，不会一上来铺很大。

---

## 13. 最小可交付版本定义

满足以下条件即可认为大屏页 v1 可用：

1. 可通过独立 URL 打开。
2. 可以读取现有文件列表并自动筛出视频 / 音频。
3. 可以用鼠标和键盘方向键浏览卡片。
4. 可以稳定播放视频和音频。
5. 可以返回浏览层并保留上次焦点位置。
6. 页面本身不依赖 Android TV 原生逻辑即可运行。

---

## 14. 下一步建议

紧接这份设计文档，建议直接进入工程拆分，不要先写大段视觉样式。第一批最值得做的是：

1. 把媒体判定和媒体会话从 `App.jsx` / `SharePage.jsx` 里抽出来。
2. 建 `living-room.html` + `living-room-main.jsx` + `LivingRoomPage.jsx` 骨架。
3. 先用假数据或最小真实数据把 Hero + 一行 Shelf + 播放层打通。

等这个最小闭环成立，再做剩余的货架、设置、继续观看和 Android TV 壳层。

---

## 15. 本次修订中已纠正的问题

这版文档相较初稿，已经修正了几个容易误导实现的点：

1. 不再假设存在独立的 `GET /api/favorites` 列表接口，而是明确复用 `/api/files` 自带的 `favorite` 字段。
2. 浏览层示意与 v1 shelf 规划已统一，不再同时把“按目录聚合”写成 v1 首页固定模块。
3. 不再暗示直接复用 `PreviewModal.jsx` 整体 UI，而是明确复用底层媒体链路与播放器部件。
4. 继续观看存储改为按用户隔离，避免电视多人共用时串进度。
5. Android TV 壳桥接接口改成更合理的 Native/Web 双向边界，不再用不清晰的 `emitKey("back")` 形式。