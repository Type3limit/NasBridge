# TVStream — 电视直播功能设计文档

## 1. 功能概述

在现有 NAS Bridge 单页应用中新增 **TV直播** 模块，提供：

- 管理多个 M3U/M3U8 直播源（集合地址）
- 解析频道列表并按分组展示
- 使用 `hls.js` 播放 HLS 流，保持原始宽高比
- 侧边栏随播放状态自动展开/折叠

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                   Browser (web/)                        │
│                                                         │
│  App.jsx                                                │
│   └─ workspaceTabs  →  新增 { id: "tv", label: "TV直播" }│
│   └─ renderActiveWorkspacePage()  →  <TVStream />        │
│                                                         │
│  TVStream.jsx  (web/src/components/TVStream.jsx)         │
│   ├─ 侧边栏: 直播源管理 + 频道列表 (分组折叠)               │
│   └─ 播放区: <video> + hls.js 实例                       │
└─────────────────────────────────────────────────────────┘
                        │ GET /api/tv/playlist?url=…
                        ▼
┌─────────────────────────────────────────────────────────┐
│                  Server (server/)                       │
│                                                         │
│  server/src/index.js  (新增路由)                         │
│   GET /api/tv/playlist?url=<encoded>                    │
│     → 服务端 fetch M3U 文本 → 原样返回给前端              │
│     作用: 绕过浏览器 CORS 限制                            │
└─────────────────────────────────────────────────────────┘
```

**无需引入新依赖**：`hls.js` 已在 `web/package.json` 中，服务端使用 Node 内置 `fetch`（Node 18+）。

---

## 3. 文件改动清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `web/src/components/TVStream.jsx` | **新建** | 主组件（侧边栏+播放器） |
| `web/src/App.jsx` | **修改** | 导航 tab + 路由分支各增一处 |
| `server/src/index.js` | **修改** | 新增 `/api/tv/playlist` 路由 |

---

## 4. 服务端：`/api/tv/playlist`

### 4.1 路由规格

```
GET /api/tv/playlist?url=<URLEncoded直播源地址>
Authorization: Bearer <token>  (复用现有 requireAuth)
```

- 成功：`200 text/plain`，Body 为原始 M3U 文本
- 参数缺失：`400 { error: "url required" }`
- 目标不可达：`502 { error: "fetch failed", detail: "…" }`

### 4.2 安全约束

- 必须通过 `requireAuth` 中间件（不向匿名用户暴露代理能力）
- 只允许 `http:` / `https:` 协议，拒绝 `file:`、`ftp:` 等，防止 SSRF
- 请求目标 URL 时设置超时（10 秒），防止永久挂起
- 响应体大小上限 8 MB（M3U 文件本身通常 < 1 MB）
- 不缓存（每次请求实时拉取，保证频道时效性）

### 4.3 实现要点（inline in `server/src/index.js`）

```js
app.get("/api/tv/playlist", requireAuth, async (req, res) => {
  const raw = String(req.query.url || "").trim();
  if (!raw) return res.status(400).json({ error: "url required" });

  let parsed;
  try { parsed = new URL(raw); } catch {
    return res.status(400).json({ error: "invalid url" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return res.status(400).json({ error: "unsupported protocol" });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const upstream = await fetch(raw, { signal: controller.signal });
    clearTimeout(timer);
    if (!upstream.ok) return res.status(502).json({ error: "upstream error", status: upstream.status });

    const text = await upstream.text();   // M3U 通常 < 1 MB，直接读全文
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(text);
  } catch (err) {
    clearTimeout(timer);
    return res.status(502).json({ error: "fetch failed", detail: err.message });
  }
});
```

---

## 5. 前端：M3U 解析

### 5.1 M3U 格式说明

```
#EXTM3U
#EXTINF:-1 tvg-name="CCTV1" tvg-logo="https://…/logo.png" group-title="央视",CCTV1综合
http://live.example.com/cctv1.m3u8
#EXTINF:-1 tvg-name="湖南卫视" tvg-logo="" group-title="卫视",湖南卫视
http://live.example.com/hnws.m3u8
```

### 5.2 解析逻辑（纯函数 `parseM3U(text)`）

```
输入: M3U 文本字符串
输出: Channel[]

interface Channel {
  name: string;          // EXTINF 逗号后的显示名
  url: string;           // 下一行 URL
  logo: string;          // tvg-logo 属性，可为空
  group: string;         // group-title 属性，默认 "未分类"
  tvgName: string;       // tvg-name 属性
}
```

算法：
1. 逐行扫描，遇到 `#EXTINF` 行：用正则提取 `tvg-logo`、`group-title`、`tvg-name`，逗号后取显示名
2. 下一行非 `#` 开头的即为流 URL
3. 按 `group` 字段分组，返回 `{ groups: string[], channels: Channel[] }`

### 5.3 直播源持久化

直播源列表（支持多个）存入 `localStorage`：

```
key: "tv_sources_v1"
value: JSON.stringify([
  { id: "uuid", label: "爱游魂", url: "https://www.iyouhun.com/tv/live.m3u", addedAt: 1234567890 }
])
```

---

## 6. 前端组件：`TVStream.jsx`

### 6.1 State 设计

```js
// 直播源管理
const [sources, setSources]           // 从 localStorage 初始化
const [activeSourceId, setActiveSourceId]
const [channels, setChannels]         // Channel[] 解析结果
const [groups, setGroups]             // string[] 分组列表
const [expandedGroups, setExpandedGroups]  // Set<string>

// 频道选择 & 播放
const [selectedChannel, setSelectedChannel]  // Channel | null
const [playState, setPlayState]       // "idle" | "loading" | "playing" | "paused" | "error"

// 侧边栏显示状态
const [sidebarCollapsed, setSidebarCollapsed]  // boolean

// 直播源新增表单
const [addSourceOpen, setAddSourceOpen]
const [sourceDraft, setSourceDraft]   // { label, url }

// 加载状态
const [fetchingPlaylist, setFetchingPlaylist]
const [fetchError, setFetchError]

// DOM refs
const videoRef    // ref to <video> element
const hlsRef      // ref to Hls instance
```

### 6.2 侧边栏折叠逻辑

```
sidebarCollapsed 控制规则（优先级从高到低）：

1. 用户手动点击展开/折叠按钮 → 直接设置，不被其他逻辑覆盖（直到下次播放状态变化）
2. playState 变为 "playing" → sidebarCollapsed = true
3. playState 变为 "paused" 或 "idle" 或 "error" → sidebarCollapsed = false
4. 初始状态（playState === "idle"）→ sidebarCollapsed = false（始终展开）

实现方式: useEffect([playState]) 驱动折叠，手动按钮同步设置同一个 state。
```

注意：手动操作和自动折叠共用同一个 `sidebarCollapsed` state，无需额外"手动覆盖"标志；自动折叠只在播放状态变化时更新，不会覆盖用户的操作——除非播放状态再次变化。

### 6.3 播放器实现

```
流类型检测:
  URL 含 .m3u8 或 Content-Type 为 application/x-mpegurl → HLS (hls.js)
  其他 → 直接设 video.src（HTTP TS 流 / MP4）

HLS 初始化流程:
  1. 若 Hls.isSupported() → new Hls() → hls.loadSource(url) → hls.attachMedia(video)
  2. 否则（Safari 原生 HLS）→ video.src = url 直接播放

生命周期:
  - 切换频道时: hls.destroy() 销毁旧实例, 重新初始化
  - 组件卸载时: hls.destroy()

事件监听 (video element):
  - "playing"  → setPlayState("playing")
  - "pause"    → setPlayState("paused")
  - "waiting"  → setPlayState("loading")
  - "error"    → setPlayState("error")
  - "ended"    → setPlayState("idle")

宽高比保持:
  video { width: 100%; height: 100%; object-fit: contain; background: #000; }
  播放区容器使用 flex 充满剩余空间，不设固定宽高
```

### 6.4 UI 布局结构

```
<div className="tvStreamRoot">         /* display: flex; height: 100%; overflow: hidden */

  /* 侧边栏 */
  <aside className={`tvSidebar${sidebarCollapsed ? " collapsed" : ""}`}>
    
    /* 折叠状态 → 只显示一个展开按钮 */
    <button className="tvSidebarToggle" onClick={toggleSidebar}>
      {sidebarCollapsed ? <ChevronRightRegular /> : <ChevronLeftRegular />}
    </button>

    /* 展开状态内容 */
    {!sidebarCollapsed && (
      <>
        /* 直播源选择器 + 新增按钮 */
        <div className="tvSourceBar"> … </div>

        /* 频道列表（按组折叠） */
        <div className="tvChannelList">
          {groups.map(group => (
            <div key={group} className="tvChannelGroup">
              <button onClick={() => toggleGroup(group)}>
                {group} ({countByGroup[group]})
              </button>
              {expandedGroups.has(group) && channels
                .filter(c => c.group === group)
                .map(channel => (
                  <button
                    key={channel.url}
                    className={`tvChannelItem${selectedChannel?.url === channel.url ? " active" : ""}`}
                    onClick={() => selectChannel(channel)}
                  >
                    {channel.logo && <img src={channel.logo} alt="" className="tvChannelLogo" />}
                    <span>{channel.name}</span>
                  </button>
                ))
              }
            </div>
          ))}
        </div>
      </>
    )}
  </aside>

  /* 播放区 */
  <div className="tvPlayerArea">
    {!selectedChannel && (
      <div className="tvEmptyState">
        请从左侧选择频道开始观看
      </div>
    )}
    {selectedChannel && (
      <>
        <div className="tvPlayerWrapper">
          <video ref={videoRef} controls autoPlay playsInline className="tvVideo" />
        </div>
        /* 播放状态提示：loading/error overlay */
        {playState === "loading" && <div className="tvLoadingOverlay"><Spinner /></div>}
        {playState === "error" && <div className="tvErrorOverlay">加载失败，请尝试其他频道</div>}
      </>
    )}
  </div>
</div>
```

### 6.5 CSS 关键样式规则

```css
.tvStreamRoot {
  display: flex;
  height: 100%;
  overflow: hidden;
  background: #000;
}

/* 侧边栏：展开时宽 280px，折叠时宽 40px */
.tvSidebar {
  width: 280px;
  min-width: 280px;
  transition: width 0.25s ease, min-width 0.25s ease;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  overflow: hidden;
}
.tvSidebar.collapsed {
  width: 40px;
  min-width: 40px;
}

/* 播放区：flex:1，视频 object-fit:contain 保持比例 */
.tvPlayerArea {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  background: #000;
}
.tvPlayerWrapper {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.tvVideo {
  width: 100%;
  height: 100%;
  object-fit: contain;   /* 保持原比例，不裁剪 */
  background: #000;
}
```

---

## 7. App.jsx 修改点

### 7.1 导入

```js
const TVStream = lazy(() => import("./components/TVStream"));
```

（与 `PreviewModal` 同样使用懒加载，避免影响首屏体积）

### 7.2 allowedTabs

```js
// 在 useEffect 中的 allowedTabs Set 添加:
allowedTabs.add("tv");
```

### 7.3 workspaceTabs 数组

```js
// 在 "shares" 条目之后添加:
{ id: "tv", label: "TV直播", icon: <VideoRegular />, meta: "live" },
```

图标：从 `@fluentui/react-icons` 引入 `VideoRegular`（已在包中，无需额外安装）。

### 7.4 renderActiveWorkspacePage

```js
if (activeWorkspaceTab === "tv") {
  return (
    <Suspense fallback={<Spinner />}>
      <TVStream authToken={token} setMessage={setMessage} />
    </Suspense>
  );
}
```

---

## 8. 直播源新增流程（UX）

```
1. 用户点击侧边栏"+"按钮 → 弹出内联表单（不用全局 Modal，减少复杂度）
2. 输入字段: 
     - 名称（选填，默认截取 URL hostname）
     - M3U 地址（必填，URL 校验）
3. 点击"加载"→ 调用 GET /api/tv/playlist?url=… → 解析频道数 → 成功后保存到 localStorage
4. 加载失败 → 提示错误，不保存
5. 已有直播源：下拉列表切换，支持删除
```

---

## 9. 数据流时序图

```
用户选择频道
     │
     ▼
selectChannel(channel)
     │
     ├─ setSelectedChannel(channel)
     ├─ setPlayState("loading")
     ├─ setSidebarCollapsed(false)  ← 不提前折叠，等播放成功
     │
     ▼
useEffect([selectedChannel])
     │
     ├─ hlsRef.current?.destroy()  ← 清理旧实例
     ├─ 判断流类型 (hls.js or native)
     └─ 初始化播放器，开始缓冲
           │
           ├─ video "playing" 事件
           │       │
           │       └─ setPlayState("playing")
           │               │
           │               └─ useEffect([playState])
           │                       └─ setSidebarCollapsed(true) ✓ 自动折叠
           │
           ├─ video "pause" 事件
           │       └─ setPlayState("paused")
           │               └─ setSidebarCollapsed(false) ✓ 自动展开
           │
           └─ video "error" 事件
                   └─ setPlayState("error")
                           └─ setSidebarCollapsed(false) ✓ 自动展开
```

---

## 10. 边界情况与处理

| 情况 | 处理 |
|------|------|
| 直播源 URL 含 CORS 限制 | 通过 `/api/tv/playlist` 服务端代理获取 M3U 文本 |
| 流 URL 本身有 CORS 限制 | 直接在 video 标签播放，浏览器媒体请求不受同源策略限制（HLS segment 请求由 hls.js 发出，实测大多数公开直播流允许跨域） |
| HLS 流在 Safari 中 | 检测 `Hls.isSupported()`，回退到 `video.src` 原生支持 |
| M3U 文件无 `#EXTM3U` 头 | 仍按行解析 `#EXTINF`，宽松兼容 |
| 频道 logo 加载失败 | `<img onError>` 隐藏图片，只显示名称 |
| localStorage 格式损坏 | try-catch，损坏时重置为 `[]` |
| 组件卸载时正在播放 | useEffect cleanup → `hls.destroy()` + `video.src = ""` |

---

## 11. 实现任务分解

### Task 1 — 服务端路由（`server/src/index.js`）
- [ ] 在适当位置（建议 `/api/file-danmaku` 路由之后）新增 `GET /api/tv/playlist` 路由
- [ ] 添加协议白名单校验和超时控制

### Task 2 — M3U 解析工具函数（`TVStream.jsx` 内）
- [ ] 实现 `parseM3U(text)` 纯函数
- [ ] 单元测试（手动验证，输入上述 M3U 样例）

### Task 3 — `TVStream.jsx` 骨架
- [ ] State 声明、localStorage 读写
- [ ] 直播源加载（`loadSource`：调 API → parseM3U → setState）
- [ ] 频道列表 UI（分组折叠、频道按钮）
- [ ] 新增直播源表单（内联表单，无全局 Modal）

### Task 4 — 播放器集成
- [ ] `useEffect([selectedChannel])` → hls.js 实例管理
- [ ] 视频事件监听 → `playState` 状态机
- [ ] `useEffect([playState])` → `sidebarCollapsed` 自动控制
- [ ] 播放区 CSS（`object-fit: contain`，`flex: 1`）

### Task 5 — App.jsx 集成
- [ ] 懒加载 `TVStream`
- [ ] `allowedTabs` 添加 `"tv"`
- [ ] `workspaceTabs` 添加 TV 条目（`VideoRegular` 图标）
- [ ] `renderActiveWorkspacePage` 添加 `"tv"` 分支

### Task 6 — 样式（`styles.css` 或 `TVStream.jsx` inline）
- [ ] `.tvStreamRoot`、`.tvSidebar`、`.tvSidebar.collapsed`
- [ ] `.tvPlayerArea`、`.tvVideo`（`object-fit: contain`）
- [ ] 侧边栏折叠动画过渡

---

## 12. 不在本期范围内

- 流 URL 服务端代理（大多数公开直播流不需要，如有需要后续单独加 `/api/tv/stream-proxy`）
- 收藏频道 / 播放历史持久化到服务端
- EPG 节目单
- 画中画（PiP）模式
- 录制功能
