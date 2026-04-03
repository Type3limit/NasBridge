# Living Room Android TV Shell — 薄壳方案细化设计

> 版本：0.1  
> 日期：2026-04-02  
> 目标：为大屏纯享页提供一个最小 Android TV 原生容器，尽量不复制 Web 业务逻辑。

---

## 1. 目标与边界

这份方案的目标不是做“原生电视媒体中心”，而是做一个能稳定承载大屏网页的 Android TV 壳。

壳层职责只保留以下内容：

1. 启动并展示大屏网页。
2. 处理 TV 设备级体验，例如横屏、沉浸式全屏、Back 键、DPAD、保活。
3. 在必要时做最小 Native/Web 桥接。
4. 为后续二维码配对登录预留入口。

不做的事情：

1. 不在原生侧重写媒体列表 UI。
2. 不在原生侧重写播放器业务逻辑。
3. 不在原生侧直接接管 WebRTC、HLS、收藏、继续观看等业务状态。

---

## 2. 技术决策

### 2.1 首选方案

首选一个单 Activity 的 Kotlin Android TV 壳应用，核心容器为 `WebView`。

原因：

1. 当前仓库的核心能力已经在 Web 层完成。
2. 薄壳 WebView 的开发和维护成本最低。
3. 后续如果网页逻辑迭代，大多数变更无需重新发版 TV App。

### 2.2 不建议的首期方案

以下方案都不适合作为第一步：

1. 原生重写电视端 UI。
2. React Native 再包一层。
3. Flutter 重做列表和播放器。

这些路线都会把媒体能力、P2P、鉴权和播放状态机拆成两份。

---

## 3. 总体架构

```text
Android TV App
  └─ MainActivity
      └─ WebView
          └─ https://your-domain/living-room.html
                ├─ /api/me
                ├─ /api/files
                ├─ /api/clients
                ├─ /ws
                └─ WebRTC / HLS / media playback
```

可选桥接：

```text
Native -> Web
  - DPAD / Back / Menu 事件
  - 生命周期事件（resume / pause）
  - 设备信息

Web -> Native
  - 读取注入 token
  - 请求保持亮屏
  - 打开系统设置或退出确认
```

---

## 4. 推荐工程结构

```text
android-tv/
  app/
    src/main/
      AndroidManifest.xml
      java/.../
        MainActivity.kt
        LivingRoomWebChromeClient.kt
        LivingRoomWebViewClient.kt
        LivingRoomJsBridge.kt
        TvKeyDispatcher.kt
      res/
        layout/activity_main.xml
        values/strings.xml
```

如果暂时不单独开仓，可以在 NAS 仓库下新建 `android-tv/` 目录做薄壳工程。

---

## 5. Android Manifest 建议

### 5.1 最小能力

至少包含：

1. `INTERNET`
2. TV Launcher 入口
3. 横屏与 TV 设备声明

建议方向：

```xml
<uses-feature android:name="android.software.leanback" android:required="true" />
<uses-feature android:name="android.hardware.touchscreen" android:required="false" />
<uses-permission android:name="android.permission.INTERNET" />
```

Activity 需要包含 TV Launcher 类别：

```xml
<category android:name="android.intent.category.LEANBACK_LAUNCHER" />
```

### 5.2 可选权限

只有在确实需要时再加：

1. `WAKE_LOCK`：需要保持屏幕不休眠时。
2. `ACCESS_NETWORK_STATE`：需要展示设备级网络状态时。

---

## 6. WebView 配置基线

### 6.1 必须开启的设置

```kotlin
webView.settings.javaScriptEnabled = true
webView.settings.domStorageEnabled = true
webView.settings.mediaPlaybackRequiresUserGesture = false
webView.settings.allowFileAccess = false
webView.settings.allowContentAccess = false
webView.settings.setSupportMultipleWindows(false)
```

原因：

1. 页面本身是 React SPA，必须启用 JavaScript。
2. 登录态和继续观看依赖 DOM Storage。
3. 电视端播放要尽量避免“必须先点一下才能播”的额外门槛。
4. 薄壳不需要本地文件访问，默认关掉更安全。

### 6.2 混合内容策略

默认应保持严格，不建议为了省事把混合内容完全放开。

建议顺序：

1. 线上优先要求页面和 API 都走 HTTPS。
2. 对必须代理的 HTTP 直播流，由服务端同源转发。
3. 只有在确实不可避免时，才评估 `MIXED_CONTENT_COMPATIBILITY_MODE`。

### 6.3 调试开关

开发版建议开启：

```kotlin
WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
```

这样能直接用 Chrome DevTools 调试 TV WebView 页面。

---

## 7. 全屏与沉浸式体验

### 7.1 Activity 层

进入页面后应立即设置：

1. 横屏
2. 沉浸式全屏
3. 防止系统栏频繁抢焦点

### 7.2 视频全屏

虽然网页可以自行调用 `requestFullscreen()`，壳层仍建议提供 `WebChromeClient` 支持，处理 HTML5 视频或浏览器级全屏请求。

最小职责：

1. 接管 `onShowCustomView`
2. 接管 `onHideCustomView`
3. 与 Activity 的系统栏显示状态联动

### 7.3 保持亮屏

播放期间建议允许网页请求开启保持亮屏：

```kotlin
window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
```

但应由网页显式请求，例如进入播放态时开启，退出播放态时关闭，而不是 Activity 启动后永久常亮。

---

## 8. Native / Web 桥接设计

### 8.1 设计原则

桥接一定要克制，只做“容器能力”，不做业务状态。

页面应该在没有桥接时也能工作；桥接只是增强项。

### 8.2 Web -> Native

建议通过 `JavascriptInterface` 提供少量能力：

```kotlin
class LivingRoomJsBridge {
  @JavascriptInterface
  fun getInjectedToken(): String?

  @JavascriptInterface
  fun setKeepScreenOn(enabled: Boolean)

  @JavascriptInterface
  fun log(message: String)
}
```

建议不要暴露：

1. 任意网络请求能力
2. 文件系统能力
3. 任意 Intent 打开能力

### 8.3 Native -> Web

Native 往 Web 传输入事件时，不建议伪造一堆 DOM 节点点击，而应显式分发自定义事件：

```js
window.dispatchEvent(new CustomEvent("nas-tv-key", {
  detail: { key: "back" }
}))
```

可选事件：

1. `nas-tv-key`
2. `nas-tv-lifecycle`
3. `nas-tv-device`

### 8.4 为什么不用旧式 `emitKey("back")`

旧式思路的问题是方向错了。Back、DPAD 事件首先发生在 Native 层，不应要求网页自己调用一个 `emitKey()` 再“模拟来自电视的按键”。

正确边界应该是：

1. Native 收到系统按键。
2. Native 转成 `nas-tv-key` 事件分发给网页。
3. 网页按自己的焦点模型消费该事件。

---

## 9. Back 键处理策略

Back 是 TV 端最关键的系统键，必须定义清楚优先级。

建议策略：

1. Native 先调用页面的统一 Back 处理入口。
2. 页面返回“已消费”时，Native 不再退出 Activity。
3. 页面未消费时，Native 再决定是 WebView 回退还是 Activity 退出。

推荐实现：

```kotlin
webView.evaluateJavascript(
  "Boolean(window.__NAS_LIVING_ROOM_BACK__ && window.__NAS_LIVING_ROOM_BACK__())"
) { result ->
  val consumed = result == "true"
  if (!consumed) {
    if (webView.canGoBack()) {
      webView.goBack()
    } else {
      finish()
    }
  }
}
```

这样比直接 `dispatchEvent` 后立刻退出更稳，因为 Native 能知道网页到底有没有处理掉这次返回。

实现时还应增加一个 `backDispatchInFlight` 防抖，避免用户连续按 Back 触发多次并发 `evaluateJavascript()`。

---

## 10. DPAD 与按键分发

### 10.1 推荐分发原则

1. DPAD 上下左右、OK、Back、Menu 由 Native 优先截获。
2. 对方向键和 OK，Native 直接 fire-and-forget 传给网页，不依赖每次同步回执。
3. 对 Back，Native 需要等待网页返回“是否已消费”。
4. 只有网页未消费 Back 时，才考虑交给 WebView 默认行为或退出 Activity。

### 10.2 命令映射

| Android KeyEvent | Web 事件 detail.key |
|------------------|----------------------|
| `KEYCODE_DPAD_LEFT` | `left` |
| `KEYCODE_DPAD_RIGHT` | `right` |
| `KEYCODE_DPAD_UP` | `up` |
| `KEYCODE_DPAD_DOWN` | `down` |
| `KEYCODE_DPAD_CENTER` / `KEYCODE_ENTER` | `select` |
| `KEYCODE_BACK` | `back` |
| `KEYCODE_MENU` | `menu` |
| `KEYCODE_MEDIA_PLAY_PAUSE` | `playPause` |

### 10.3 为什么要 Native 优先截获

原因有两个：

1. 不同 TV WebView 对方向键默认行为不一致。
2. 如果不先归一化，网页同时监听浏览器 `keydown` 和 TV 注入事件，容易出现重复处理。

结论：TV 壳里应以 Native 注入事件为主，浏览器 `keydown` 监听作为兼容兜底。
**重要**：Native 向网页注入 DPAD / OK 事件后，必须在 `dispatchKeyEvent` 或 `onKeyDown` 中返回 `true`（消费该 `KeyEvent`），不能再让 WebView 的默认键盘处理管道二次处理同一个按键，否则会出现一次物理按键触发两次行为的问题。Back 键因为有异步回执等待，由独立的 `dispatchBack()` 逻辑负责，不适用此规则。
---

## 11. 登录与 token 注入策略

### 11.1 v1：壳内手动登录（底底方案）

最简单的首版实现，仅作为底底：

1. 壳应用直接打开登录页或大屏页。
2. 用户用遥控器完成账号密码输入。
3. 登录态保存在 WebView 自己的 `localStorage` 里。

优点：

- 简单、稳定、无额外服务端改造。

缺点：

- 遥控器输入账号密码体验极差，不适合作为主要登录路径。推荐尽快被 v1.5 二维码配对取代。

### 11.2 v1.5：Native 注入已有 token

若壳应用有安全获取 token 的能力，推荐通过 bridge 让网页在启动阶段主动拉取，而不是依赖 Native 生硬改写页面脚本：

```ts
const injectedToken = window.NASLivingRoomBridge?.getInjectedToken?.();
if (!localStorage.getItem("nas_token") && injectedToken) {
  localStorage.setItem("nas_token", injectedToken);
}
```

注意：

1. 只能注入到 TV 壳自己的 WebView 存储空间。
2. 不等于与手机浏览器共享登录态。
3. 如果必须由 Native 直接写入 `localStorage`，也应在目标 origin 首次加载完成后执行，再刷新一次页面，而不是假设可以在任意时刻“预写入”。

### 11.3 v1.5：二维码配对登录（近期目标）

这是电视场景最合理的登录体验，建议在 v1 基础能力跑通后尽快跟进，而不是拖到 v2 甚至更晚：

1. TV 壳启动时，若未登录，页面显示设备码 + 二维码。
2. 用户用手机扫码，跳到 NAS Web 端（已登录）完成授权确认。
3. 服务端向该 TV 设备会话下发 token。
4. 壳层通过 `LivingRoomJsBridge.getInjectedToken()` 注入 token 并刷新页面。

**为什么要提前做**：v1 的手动键盘登录在遥控器下体验极差，实际使用中会成为首次上手的最大障碍。建议将二维码配对定为 TV 功能正式上线的前置条件，而非可选 polish。

---

## 12. 生命周期与网络恢复

### 12.1 Activity 生命周期

在 `onResume` / `onPause` / `onStop` 时，壳层可以向网页发简化生命周期事件：

```js
window.dispatchEvent(new CustomEvent("nas-tv-lifecycle", {
  detail: { type: "resume" }
}))
```

网页可据此做：

1. 恢复焦点
2. 刷新在线终端状态
3. 重试 P2P 或 WebSocket 连接

### 12.2 网络断线处理

壳层只负责把系统级网络变化暴露给网页；是否重连、如何重连仍由网页自己决定。

不要把重连逻辑拆一半在 Native、一半在 Web。

---

## 13. 安全边界

### 13.1 网页来源

推荐只允许加载固定域名的大屏页，例如：

```text
https://nas.example.com/living-room.html
```

不建议做成可任意输入 URL 的通用浏览器容器。

### 13.2 Bridge 安全

所有 `JavascriptInterface` 都应最小化，避免暴露高风险能力。

建议：

1. 不暴露任意执行 shell / intent 的接口。
2. 不暴露本地文件写入接口。
3. 不允许网页要求壳层打开任意三方 URL。

### 13.3 调试与日志

开发期日志可以通过 bridge 回传，但发布版应默认关闭详细调试日志。

---

## 14. 性能与兼容性基线

建议兼容性基线如下：

1. Android TV / Google TV，API 26+。
2. 系统 WebView / Chromium 版本尽量保持较新。
3. 以 1080p UI 设计为主，4K 做高分缩放适配。

网页端还应遵循：

1. Shelf 惰性渲染。
2. 缩略图懒加载。
3. 不在首页一次性创建大量视频 DOM。

---

## 15. 测试清单

### 15.1 启动

1. 冷启动直接进入大屏页。
2. 无网、服务端不可达、token 失效时都有明确提示。

### 15.2 输入

1. DPAD 上下左右、OK、Back、Menu 行为正确。
2. Back 不会误退出正在打开的抽屉或播放层。

### 15.3 播放

1. 视频可播放、暂停、恢复。
2. 全屏切换后不会丢失系统栏控制。
3. 播放中屏幕不会过早休眠。

### 15.4 生命周期

1. 切到后台再回来，页面和焦点能恢复。
2. 网络断开再恢复，页面能重新建立必要连接。

---

## 16. 推荐落地顺序

建议按这个顺序推进：

1. 先完成浏览器版大屏页。
2. 再做最小 WebView 壳，先不加 bridge。
3. 然后补沉浸式全屏和保持亮屏。
4. 再补 DPAD / Back / Menu 事件桥接。
5. 最后才做 token 注入和二维码配对登录。

这个顺序可以保证每一步都小而可测，不会把 Web 页和原生壳耦死。