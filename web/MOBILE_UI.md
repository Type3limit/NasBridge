# NAS Console — 移动端 UI 规划文档

> 版本：1.2 | 日期：2026-03-26  
> 目标设备：≤ 760px 宽度，主要机型 iPhone 14/15（390px）、Android（360–412px）

---

## 1. 设计决策

### 1.1 架构方案：条件渲染，共享逻辑

在 `App.jsx` 最顶层检测移动端，依据 `isMobile` 分叉：

```
isMobile === true  → renderMobileLayout()   // 全新移动布局
isMobile === false → renderDesktopLayout()  // 现有桌面布局不变
```

- **共享**：所有状态（token, user, clients, files, transfers…）、所有数据获取逻辑
- **替换**：仅 Layout 层（顶栏 + 导航 + 内容容器）和少数页面内 UI 细节
- **判断方式**：`window.innerWidth <= 760` + `resize` 监听（已有 `isMobileViewport`）

**⚙️ 具体实施步骤：**

1. **复用已有判断逻辑**：`App.jsx` 已有 `isMobileViewport` state（`useState(() => window.innerWidth <= 760)` + resize useEffect）。将其提取到 `useIsMobile.js` hook，App.jsx 改为 `const isMobile = useIsMobile()`，删除原来内联的 state + useEffect，避免重复。

2. **新增 3 个 App.jsx 本地 state**：
   ```js
   const [activeMobileTab, setActiveMobileTab] = useState('explorer');
   const [moreSheetOpen, setMoreSheetOpen] = useState(false);
   const [moreNavigatedTab, setMoreNavigatedTab] = useState(null); // 'transfers'|'shares'|...
   ```

3. **共享 `activeWorkspaceTab`**：移动端和桌面端用**同一个** `activeWorkspaceTab` state（不新建 `activeMobileTab`）。这样在窗口 resize 切换布局时，不会丢失当前标签。`activeMobileTab` 改名为 `activeWorkspaceTab` 在移动端路由中使用即可。

4. **提取 `renderDesktopLayout()`**：把现有 `return` 里 `isLoggedIn` 分支的 header + workspaceLayout JSX 整体包进 `renderDesktopLayout()` 函数。确认所有对话框（previewOpen 等）提到 `return` 的顶层，不在 Desktop/Mobile 布局内部。

5. **插入分叉**：
   ```jsx
   return (
     <div className="page">
       {isLoggedIn
         ? isMobile
           ? renderMobileLayout()
           : renderDesktopLayout()
         : renderAuthPage()
       }
       {/* 对话框区域 —— 不区分移动/桌面，始终渲染 */}
       {uploadOpen && ( ... )}
       {previewOpen && <Suspense ...><PreviewModal .../></Suspense>}
       {profileOpen && <ProfileDialog ... />}
       ...
     </div>
   );
   ```

   > ⚠️ 对话框必须在 `<div className="page">` 直属子节点处渲染，不要包裹在 MobileLayout 里面，否则会被 `.mobileApp { overflow: hidden }` 裁剪。

---

## 2. 总体视觉结构

```
┌──────────────────────────────────┐  ← 100dvh
│  MobileTopbar           ~48px    │  position: sticky / flex-shrink: 0
├──────────────────────────────────┤
│                                  │
│  MobilePageContent               │  flex: 1 1 auto, overflow-y: auto
│  (当前激活 Tab 内容)              │  -webkit-overflow-scrolling: touch
│                                  │
├──────────────────────────────────┤
│  MiniMusicBar (可选, ~48px)      │  flex-shrink: 0, 仅有曲目时显示
├──────────────────────────────────┤
│  MobileBottomTabBar     ~56px    │  position: sticky bottom / safe area
│  + iOS safe-area-inset-bottom    │
└──────────────────────────────────┘
```

全局 wrapper：
```css
.mobileApp {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;          /* 滚动发生在 .mobilePageContent 内 */
  background: var(--page-bg);
}
```

**⚙️ 实施细节：**

- **`100dvh` 问题**：`dvh`（dynamic viewport height）在 iOS Safari 16+ 和 Chrome 108+ 支持，会随地址栏展开/收起动态更新高度。若需兼容旧机型，可用 `min-height: 100svh; height: 100dvh`（svh = smallest，避免内容被裁剪）。当前项目已经使用 `100dvh`，保持一致即可。

- **Android 虚拟键盘**：键盘弹出时 Android WebView/Chrome 默认会 resize viewport，导致 `100dvh` 缩小。需在 `<meta name="viewport">` 中添加 `interactive-widget=resizes-content`（或 `.page` 保持 `height: 100%`，不用 dvh）。iOS 键盘浮动不 resize 不受此影响。

- **`overflow: hidden`**：`.mobileApp` 的 `overflow: hidden` 是关键约束，确保子元素不能溢出触发页面级滚动，所有滚动必须在 `.mobilePageContent` 内进行。**不要**给 `.mobileApp` 添加 `-webkit-backdrop-filter: blur()`，否则会破坏 `MobileMoreSheet` 等 `position: fixed` 子元素的定位。

- **挂载方式**：`<div className="mobileApp">` 替换（或平级挂载）现有 `.appShell` + `.workspaceLayout`，在 `renderMobileLayout()` 函数中返回，不影响桌面布局的 DOM 结构。

---

## 3. MobileTopbar

### 3.1 布局

```
[ 品牌名 "NAS Console" ]    [ 头像 ][ ↑ ][ ⇌ ]
```

| 元素 | 说明 |
|------|------|
| 品牌文字 | `<Title3>NAS Console</Title3>`，flex: 1 |
| 头像按钮 | `<AvatarFace />` 32px，点击打开 ProfileDialog |
| 上传 | `<ArrowDownloadRegular />` 旋转180°，36px 点击区 |
| 同步 | `<ArrowSwapRegular />` 或 `<Spinner size="tiny">` |
| **不显示** | 退出登录按钮（移到 ProfileDialog 内底部）、音乐播放器 inline 显示 |

### 3.2 CSS 要求

```css
.mobileTopbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  height: 48px;
  flex-shrink: 0;
  /* 复用 .appTopbar 渐变背景 */
  background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(247,250,252,0.94));
  border-bottom: 1px solid var(--stroke);
  position: sticky;
  top: 0;
  z-index: 30;
}

.mobileTopbarBrand {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 700;
  white-space: nowrap;
}

.mobileTopbarActions {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-shrink: 0;
}
```

**⚙️ JSX 参考结构：**

```jsx
// renderMobileLayout() 内直接写，无需单独组件文件
<header className="mobileTopbar">
  <div className="mobileTopbarBrand">
    <Title3>NAS Console</Title3>
  </div>
  <div className="mobileTopbarActions">
    <button
      type="button"
      className="iconActionButton"
      title="用户档案"
      aria-label="用户档案"
      onClick={() => setProfileOpen(true)}
    >
      <AvatarFace
        displayName={user.displayName}
        avatarUrl={user.avatarUrl}
        avatarClientId={user.avatarClientId}
        avatarPath={user.avatarPath}
        avatarFileId={user.avatarFileId}
        p2p={p2p}
        style={{ width: 30, height: 30 }}
      />
    </button>
    <button
      type="button"
      className="iconActionButton"
      title="上传文件"
      aria-label="上传文件"
      onClick={() => setUploadOpen(true)}
    >
      <ArrowDownloadRegular />
    </button>
    <button
      type="button"
      className="iconActionButton"
      title="同步索引"
      aria-label="同步索引"
      onClick={() => refreshAll()}
    >
      {loading ? <Spinner size="tiny" /> : <ArrowSwapRegular />}
    </button>
  </div>
</header>
```

**⚠️ 注意事项：**

- `AvatarFace` 接收 `p2p` prop 用于从 P2P 网络加载头像图，必须传入，否则头像不显示。
- `loading` 状态控制同步按钮图标/Spinner 切换，读取 App.jsx 现有的 `loading` state。
- MobileTopbar 不包裹在 `.surfaceCard` 内（桌面 `.appTopbar` 用了 `.surfaceCard`），否则会拿到 `-webkit-backdrop-filter: blur(18px)`，导致 `.mobileMoreSheet` 定位异常（见第 14.2 节）。背景渐变直接写在 `.mobileTopbar` 上。
- 退出登录按钮**不在**顶栏 — 移到 `MobileMoreSheet` 的"退出登录"行（或 ProfileDialog 内，两处均可）。
- z-index 30（低于 MobileMoreSheet 的 49/50，低于对话框的 60+）。

---

## 4. MobileBottomTabBar

### 4.1 Tab 分组策略

移动端底栏最多 5 个 Tab；低频功能收进"更多"抽屉。

| 位置 | Tab ID | 图标 | 标签 |
|------|--------|------|------|
| 1 | `explorer` | FolderRegular | 文件 |
| 2 | `chat` | ChatRegular | 聊天 |
| 3 | `overview` | AppsListRegular | 概览 |
| 4 | `tv` | StreamRegular | 直播 |
| 5 | `more` | MoreHorizontalRegular | 更多 |

"**更多**" Tab 点击弹出 `MobileMoreSheet`（从底部滑入），包含：
- 传输队列 (`transfers`)
- 分享管理 (`shares`)
- 终端状态 (`terminals`)
- 用户管理 (`admin-users`，仅 admin)
- 终端管理 (`admin-clients`，仅 admin)

**⚙️ Tab 切换逻辑细节：**

```jsx
// MobileBottomTabBar 的 onTabChange 处理
function handleMobileTabChange(id) {
  if (id === 'more') {
    setMoreSheetOpen(true);   // 打开 Sheet，不切换内容区
    return;
  }
  setMoreSheetOpen(false);
  setMoreNavigatedTab(null);  // 清除子页面路由
  setActiveWorkspaceTab(id);
}
```

**"更多" Tab 的 active 状态**：
- `moreSheetOpen === true` → active
- `activeWorkspaceTab === 'more'`（即正在查看某子页面）→ active
- 其他情况 → inactive

```jsx
// MobileBottomTabBar 内部
const isMoreActive = (activeTab === 'more') || moreSheetOpen;
```

**徽章（badge）计算**：

| Tab | 徽章值 | 说明 |
|-----|--------|------|
| 文件 | `filteredOnlineFiles.length` | 文件总数，或当筛选激活时显示 |
| 聊天 | 未读消息数 | ChatRoom 组件内部维护，需通过 prop 透传 |
| 更多 | `visibleUploadJobs.length + downloadingCount` | 活跃传输任务数 |
| 直播、概览 | 不显示徽章 | — |

> 聊天未读数：ChatRoom 内有 `unreadCount` 状态，需新增 `onUnreadChange` prop 透传给 App.jsx。若暂时不实现，可不显示聊天徽章。

### 4.2 布局

```
┌────┬────┬────┬────┬────┐
│ 📁 │ 💬 │ 📊 │ 📺 │ ⋯  │
│文件│聊天│概览│直播│更多│
└────┴────┴────┴────┴────┘
```

### 4.3 CSS 要求

```css
.mobileBottomTabBar {
  display: flex;
  flex-shrink: 0;
  border-top: 1px solid var(--stroke);
  background: rgba(255,255,255,0.96);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  /* iOS home indicator safe area */
  padding-bottom: env(safe-area-inset-bottom, 0px);
  height: calc(56px + env(safe-area-inset-bottom, 0px));
}

.mobileTabItem {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 8px 4px;
  border: none;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  position: relative;
  min-height: 56px;
  -webkit-tap-highlight-color: transparent;
  transition: color 0.15s;
}

.mobileTabItem.active {
  color: var(--accent);
}

.mobileTabItem.active::before {
  content: "";
  position: absolute;
  top: 0;
  left: 25%;
  right: 25%;
  height: 2px;
  border-radius: 0 0 2px 2px;
  background: var(--accent);
}

.mobileTabIcon {
  width: 22px;
  height: 22px;
}

.mobileTabLabel {
  font-size: 11px;
  font-weight: 500;
}

.mobileTabBadge {
  position: absolute;
  top: 6px;
  right: calc(50% - 18px);
  min-width: 16px;
  height: 16px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}
```

**⚠️ 注意事项：**

- `<button type="button">` 用于每个 Tab，**不用** `<a>` 或路由组件，因为这是 SPA 内部导航。
- `min-height: 56px` 同时在 `.mobileTabItem` 和 `.mobileBottomTabBar` 高度中保障 — `height: calc(56px + ...)` 是容器高度，56px 是内容区高度，safe area 只加 padding-bottom，不影响 Tab 内容布局。
- `-webkit-tap-highlight-color: transparent` 去掉 iOS/Android 点击高亮蓝框，视觉必要。
- `backdrop-filter` 在 Tab Bar 上为自身背景效果，**不影响**其兄弟元素定位 — 安全使用。

---

## 5. MobilePageContent

### 5.1 容器规则

```css
.mobilePageContent {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-y: contain;
}
```

**⚙️ 页面内卡片样式覆盖：**

现有 `renderXxxPage()` 函数输出的结构为：
```
.workspacePage > .workspacePageCard(.surfaceCard.panelCard)
```
这些卡片有 `background`, `border-radius`, `box-shadow` 等桌面样式，在移动端全屏撑满时视觉多余。在 `styles.css` 底部加移动端全局覆盖：

```css
@media (max-width: 760px) {
  /* 去掉页面内卡片的外壳感，贴合全屏滚动区 */
  .mobilePageContent .workspacePage {
    padding: 0;
  }
  .mobilePageContent .workspacePageCard {
    border-radius: 0;
    box-shadow: none;
    border: none;
    background: transparent;
  }
  /* 页面头部和内容区保留内边距 */
  .mobilePageContent .workspacePageHeader,
  .mobilePageContent .workspaceList,
  .mobilePageContent .adminList {
    padding: 12px 14px;
  }
}
```

> ⚠️ 以上选择器使用了 `.mobilePageContent` 作为作用域前缀，确保只影响移动端布局内的卡片，不污染桌面样式。对话框中的卡片（`.dialogModal`）不受影响。

### 5.2 每个页面的移动端适配

---

#### 5.2.1 资源浏览器 (explorer)

```
┌──────────────────────────────────────┐
│ [📂路径面包屑] [筛选🔽] [⊞⊟]       │  工具栏，sticky top
├──────────────────────────────────────┤
│ ┌──────────────────────────────────┐ │
│ │ [筛选面板 BottomSheet]           │ │ 仅筛选展开时出现
│ └──────────────────────────────────┘ │
│ 📄 文件名.mp4              64.1 MB  │
│    ↩ 路径 · 终端名         [→][✎][🗑]│
│ ─────────────────────────────────── │
│ 📁 文件夹名/                         │
│    3 个文件    [→][🗑]              │
│ ─────────────────────────────────── │
│ ...                                 │
└──────────────────────────────────────┘
│ [批量选择工具栏 Sticky Bottom]       │  批量选中时显示
```

**变化说明：**
- 网格模式（.fileGrid）在手机固定为 `grid-template-columns: 1fr 1fr`（两列）
- 详情模式（.fileRow）每行操作按钮 [→][✎][🗑] 横排，不折叠
- 筛选面板改为 `MobileFilterSheet`（底部滑入），不再内嵌在内容区上方
- 面包屑超长时只显示最后两级，前面显示"…"
- 批量工具栏：`position: sticky; bottom: 0;`
- 上传：点击顶栏"↑"触发，不在页面内
- 文件夹名按钮：`min-height: 52px`，拇指友好

**⚙️ 具体实施细节：**

**① 禁用虚拟滚动（已有代码）：**
`isMobileViewport` 已在 `renderExplorerPage()` 中控制 `detailSlice` 全量渲染，不再 slice。移动端不改这个逻辑。但注意：`.fileList` 当前可能有自己的 `overflow-y: auto` + `height: calc(...)` 样式，这会在 `.mobilePageContent` 内形成双层滚动容器（用户滑动时不直觉）。需加覆盖：
```css
@media (max-width: 760px) {
  .mobilePageContent .fileList,
  .mobilePageContent .fileGridScroller {
    overflow: visible;
    height: auto;
    max-height: none;
  }
}
```

**② 筛选 Toggle 按钮改为打开 Sheet：**
`renderExplorerPage()` 中的 `filterToggleButton` 现在调用 `setFiltersExpanded(prev => !prev)`。移动端需要改为打开 `MobileFilterSheet`。添加条件判断：
```jsx
// filterToggleButton 的 onClick
onClick={() => {
  if (isMobile) {
    setFilterSheetOpen(true);   // 新增 state
  } else {
    setFiltersExpanded(prev => !prev);
  }
}}
```
同时，`.filterPanelShell` 在移动端隐藏：
```css
@media (max-width: 760px) {
  .mobilePageContent .filterPanelShell { display: none; }
}
```

**③ 面包屑截断：**
现有 `explorerBreadcrumbs` 是数组（`[{path, label}, ...]`）。移动端只显示最后 2 项，前面用 `…` 代替：
```jsx
const visibleCrumbs = isMobile && explorerBreadcrumbs.length > 2
  ? [{ path: '...', label: '…' }, ...explorerBreadcrumbs.slice(-2)]
  : explorerBreadcrumbs;
// 渲染时跳过 path==='...' 的点击
```

**④ 批量工具栏 sticky bottom：**
`.bulkToolbar` 用 `position: sticky; bottom: 0; z-index: 5` 即可，因为在 `.mobilePageContent`（overflow-y: auto）内部 sticky 天然不超出容器，不会遮挡底栏。

**⑤ 网格模式强制双列：**
```css
@media (max-width: 760px) {
  .mobilePageContent .fileGrid {
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    padding: 8px;
  }
}
```

**⑥ 行操作按钮触摸区域：**
`.iconActionButton` 确保 `min-width: 44px; min-height: 44px`（iOS HIG 推荐最小触控面积），视觉图标可以小于此值但 padding 要补足。

---

#### 5.2.2 聊天室 (chat)

聊天室是最复杂的页面，`mainCanvas` 不能 `overflow-y: auto`，要给 chatRoomShell 单独算高度。

```
mobilePageContent 高度 = 100dvh - 48px(topbar) - 48px(musicBar) - 56px(bottomTab)
                       ≈ calc(100dvh - 152px)  （无音乐时 - 104px）
chatRoomShell height = 100%（填充 mobilePageContent）
```

```
┌──────────────────────────────────────┐
│ [机器人选择/在线人数徽章]            │  chatRoomShell header
├──────────────────────────────────────┤
│                                      │
│   消息气泡列表（overflow-y: auto）   │  flex: 1 1 auto
│                                      │
├──────────────────────────────────────┤
│ [📎][表情😊][👤@]  [输入框]  [发送▶]│  输入栏，fixed/sticky bottom
└──────────────────────────────────────┘
```

**变化说明：**
- `chatRoomShell` 高度由 mobilePageContent 高度驱动（不硬写 calc dvh）
- 输入框 `max-height: 20vh; resize: none`
- 表情面板作为 BottomSheet（`position: fixed; bottom: 0`）
- 附件上传直接触发文件选择器，不显示 DropZone
- 侧边 bot 菜单改为顶部 Sheet 或下拉

**⚙️ 具体实施细节：**

**① ChatRoom 高度驱动方案：**
ChatRoom 渲染在 `.mobilePageContent` 内，`.mobilePageContent` 是 `flex: 1 1 auto; overflow-y: auto`。ChatRoom 内部需要自己管理滚动（消息列表 overflow-y: auto），因此 `.mobilePageContent` 对 chat tab 必须**不滚动**：

```css
/* 仅在聊天 tab 时生效，通过 class 切换 */
.mobilePageContent.chatMode {
  overflow-y: hidden;   /* 禁止外层滚动，chat 内部自管理 */
}
```

```jsx
// mobilePageContent 的 className
<div className={`mobilePageContent${activeWorkspaceTab === 'chat' ? ' chatMode' : ''}`}>
```

**② 高度计算 CSS 变量：**
使用第 16 节定义的 `--mobile-content-height` 给 chatRoomShell：
```css
@media (max-width: 760px) {
  .mobilePageContent.chatMode .chatRoomShell {
    height: var(--mobile-content-height);   /* 动态高度变量 */
    min-height: 0;
  }
}
```
`--mobile-content-height` 的值在 MusicBar 显示/隐藏时改变，当 MusicBar 出现时 chatRoomShell 会缩短 48px。通过 JS 动态更新 CSS 变量（见第 16 节）或用 CSS 嵌套 calc。

**③ 输入框与键盘：**
- iOS：系统键盘弹出时 WebKit 会自动将焦点元素滚动进入视野，一般不需额外处理。
- Android：键盘弹出后 viewport 缩小，`--mobile-content-height` 会更新（因为 `100dvh` 减小），chatRoomShell 高度随之减小正确响应。
- 输入框 `textarea` 需设 `resize: none` 防止用户缩放破坏布局。

**④ ChatRoom 组件侵入性最小方案：**
ChatRoom 是外部组件，避免修改其内部逻辑。只在 App.jsx 中通过 CSS class + CSS 变量控制容器高度，ChatRoom 自身 `height: 100%` 即为正确。

**⑤ MiniMusicBar 出现引起高度变化：**
MiniMusicBar 属于 flex column 中的 `flex-shrink: 0` 元素，出现时 `.mobilePageContent` 会自动缩小（因为 `flex: 1 1 auto; min-height: 0`）。如果 chatRoomShell 用 `height: 100%` 写法，它会跟随 mobilePageContent 高度正确缩小。若用 `height: calc(...)` 硬编码则需监听 MusicBar 显示状态。**推荐用 `height: 100%`**。

---

#### 5.2.3 系统概览 (overview)

```
┌──────────────────────────────────────┐
│ 系统概览 [同步][诊断]                │  页面标题
├──────────────────────────────────────┤
│ ┌──────┐ ┌──────┐ ┌──────┐          │  指标卡片 2列或1列
│ │信令  │ │在线  │ │分享  │          │  grid: repeat(2, 1fr)
│ │状态  │ │终端  │ │链接  │          │
│ └──────┘ └──────┘ └──────┘          │
│ ┌──────┐ ┌──────┐ ┌──────┐          │
│ │上传  │ │下载  │ │刷新  │          │
│ │队列  │ │队列  │ │时间  │          │
│ └──────┘ └──────┘ └──────┘          │
└──────────────────────────────────────┘
```

**变化说明：**
- `overviewMetricsGrid` 改为 `grid-template-columns: repeat(2, 1fr)`（桌面为4列）
- 操作按钮移到页面标题右侧（同步+诊断），其他收在"…"菜单

**⚙️ 具体实施细节：**

**① 指标网格：**
```css
@media (max-width: 760px) {
  .mobilePageContent .overviewMetricsGrid {
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }
}
```
8 个 `railMetric` 卡片两列排列 → 4 行，视觉紧凑。

**② 操作按钮处理：**
`renderOverviewPage()` 中 `workspacePageActions` 区域有 4 个按钮：`发起上传`、`打开诊断`、`同步索引`、`切到详情/卡片`。
- 移动端顶栏已有**上传**和**同步**按钮，这两个在 overview 页面内可以隐藏。
- **打开诊断**保留，右对齐在标题旁。
- **切到详情/卡片**视图切换在移动端意义不大（overview 无文件列表），可隐藏。

```css
@media (max-width: 760px) {
  /* 在 overview 页隐藏冗余操作 */
  .mobilePageContent .workspacePageActions .overviewUploadButton,
  .mobilePageContent .workspacePageActions .overviewSyncButton,
  .mobilePageContent .workspacePageActions .overviewViewToggle {
    display: none;
  }
}
```

> 如果 `workspacePageActions` 内的按钮没有单独 className，可以用 `nth-child` 或在 JSX 里加 `isMobile` 条件，后者更清晰。

---

#### 5.2.4 TV 直播 (tv)

```
┌──────────────────────────────────────┐
│ [频道列表区，可横滑]                 │  水平滚动 chip
├──────────────────────────────────────┤
│                                      │
│   播放器区域（16:9 aspect-ratio）    │
│     旋转 → 全屏，纵向保持宽高比     │
│                                      │
├──────────────────────────────────────┤
│ 播放控制：[⏮][⏯][⏭] [音量○]       │
└──────────────────────────────────────┘
```

**变化说明：**
- `aspect-ratio: 16/9; width: 100%;`，高度自适应
- 横屏时自动请求 `requestFullscreen()`
- 频道列表纵向改为水平滚动 chips

**⚙️ 具体实施细节：**

**① TVStream 是 lazy 组件：**
```jsx
const TVStream = lazy(() => import('./TVStream.jsx'));
// 移动端渲染时同样需要 Suspense 包裹
case 'tv':
  return (
    <Suspense fallback={<div className="mobileLoadingCenter"><Spinner /></div>}>
      <TVStream ... />
    </Suspense>
  );
```

**② 播放器宽高比：**
`TVStream` 内部已有播放器容器，加 CSS 覆盖：
```css
@media (max-width: 760px) {
  .mobilePageContent .tvPlayerContainer,
  .mobilePageContent video {
    width: 100%;
    aspect-ratio: 16 / 9;
    max-height: 56vw;    /* 防止竖屏时视频过高 */
  }
}
```

**③ 横屏全屏：**
`requestFullscreen()` 必须由**用户手势**触发，`orientationchange` 事件不算用户手势。iOS Safari 更严格：不支持 `requestFullscreen()`（用 `webkitEnterFullscreen()` 替代，且只能用于 `<video>` 元素）。

正确方案：**在播放器上方显示"横屏查看"提示按钮**，用户手动点击后触发：
```jsx
<button onClick={() => videoRef.current?.requestFullscreen?.() 
                        ?? videoRef.current?.webkitEnterFullscreen?.()}>
  全屏
</button>
```
不要用 `screen.orientation.addEventListener('change')` 自动触发全屏，会被浏览器拦截。

**④ 频道列表改为水平滚动：**
```css
@media (max-width: 760px) {
  .tvChannelList {
    display: flex;
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
    gap: 8px;
    padding: 8px 14px;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
  }
  .tvChannelItem {
    flex-shrink: 0;
    scroll-snap-align: start;
  }
}
```

---

#### 5.2.5 传输队列 (transfers)

```
┌──────────────────────────────────────┐
│ ← 传输队列        [上传 2] [下载 1] │  页面标题 + 徽章
├──────────────────────────────────────┤
│ ↓ 文件名.mp4                        │
│   下载中 · 64.1MB/s · 终端名        │
│   [████████░░░░░░] 62%   [✕]        │
│ ─────────────────────────────────── │
│ ↑ 照片.jpg                          │
│   上传中 · 1.2MB → 终端名           │
│   [███████████░░░] 80%   [✕]        │
│ ─────────────────────────────────── │
└──────────────────────────────────────┘
```

**变化说明：**
- 每行：文件名（粗体）+ 状态文本 + 进度条 + 取消按钮，垂直堆叠
- 进度条宽度 `width: 100%`（桌面行式布局在移动端太窄）
- 无任务时显示空状态提示
- 顶部返回按钮 `←` 通过 `moreNavigatedTab` 状态路由回主入口

**⚙️ 具体实施细节：**

桌面 `renderTransferQueueRow()` 行结构是水平布局。在移动端加 CSS 改为垂直：
```css
@media (max-width: 760px) {
  .mobilePageContent .fileRow.uploadRow,
  .mobilePageContent .transferRow {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 10px 14px;
  }
  .mobilePageContent .uploadProgressBar {
    width: 100%;
    margin: 4px 0;
  }
  /* 取消按钮独立一行靠右 */
  .mobilePageContent .uploadInlineCancel {
    align-self: flex-end;
  }
}
```

---

#### 5.2.6 分享管理 (shares)

```
┌──────────────────────────────────────┐
│ ← 分享管理              [共 5]      │  页面标题
├──────────────────────────────────────┤
│ ● 文件名.mp4 (有效)                  │
│   路径/子路径                        │
│   创建于 2h · 访问 3次 · 长期有效   │  灰色 caption
│                     [📋][✕][🗑]    │  操作按钮右对齐
│ ─────────────────────────────────── │
│ ○ 另一文件.pdf (无效)                │
│   ...                               │
└──────────────────────────────────────┘
```

**变化说明：**
- 状态圆点 `●/○` 直接跟文件名，不单独占一列
- 三个操作图标（复制、撤销、删除）靠右，`min-width: 44px` 单个
- 操作按钮区域 `display: flex; gap: 4px; flex-shrink: 0`

**⚙️ 具体实施细节：**

桌面 `.shareMiniRow` 使用 flexbox 水平布局，主信息区和操作区左右排列。移动端操作按钮需要补足触控尺寸：
```css
@media (max-width: 760px) {
  .mobilePageContent .shareMiniRow {
    flex-wrap: wrap;
    gap: 4px;
  }
  .mobilePageContent .shareMiniMain {
    flex: 1 1 100%;   /* 信息区占满一行 */
  }
  .mobilePageContent .shareMiniActions {
    margin-left: auto;  /* 操作靠右 */
  }
  .mobilePageContent .shareManagerIconButton {
    min-width: 44px;
    min-height: 44px;
    /* 使图标居中但点击区足够大 */
    display: flex;
    align-items: center;
    justify-content: center;
  }
}
```

"撤销"按钮有 `disabled={share.status !== 'active'}` 条件，移动端同样生效，不需额外处理。

---

#### 5.2.7 终端状态 (terminals)

```
┌──────────────────────────────────────┐
│ ← 终端状态    [在线 3] [中继 1]     │  页面标题 + 徽章
├──────────────────────────────────────┤
│ 存储终端 A           [online] [直连]│
│   ID: abc123                         │
│   心跳 2분钟前 · download/upload P2P │
│ ─────────────────────────────────── │
│ 存储终端 B           [offline][—]   │
│   ID: def456                         │
│   无心跳                             │
└──────────────────────────────────────┘
```

**变化说明：**
- 两个徽章（status + route）横排靠右
- 角色摘要（formatPeerRoleSummary）改为独占一行 caption
- 无额外操作按钮（终端状态只读，操作在 admin-clients 页）

**⚙️ 具体实施细节：**

桌面 `.terminalRow` 中 `.miniListBadges` 和 `.miniListMain` 是水平布局，移动端基本可直接复用：
```css
@media (max-width: 760px) {
  .mobilePageContent .workspaceTerminalRow {
    padding: 10px 14px;
    align-items: flex-start;
  }
  .mobilePageContent .workspaceTerminalRow .miniListBadges {
    display: flex;
    flex-direction: row;   /* 两个徽章横排 */
    flex-wrap: nowrap;
    gap: 4px;
    flex-shrink: 0;
  }
}
```
终端名称可能很长，`.miniListTitle` 加 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px`。

---

#### 5.2.8 用户管理 (admin-users)

```
┌──────────────────────────────────────┐
│ ← 用户管理             [共 4]       │  页面标题（管理员专属）
├──────────────────────────────────────┤
│ 张三 · admin                         │
│ zhang@example.com                    │
│ ─────────────────────────────────── │
│ 李四 · member                        │
│ li@example.com                       │
└──────────────────────────────────────┘
```

**变化说明：**
- 只读列表，无操作按钮，垂直两行（姓名角色 + 邮箱）
- 桌面版相同，移动端直接复用 `.simpleRow` 行即可

**⚙️ 具体实施细节：**

`.simpleRow` 已是垂直两行布局（`.fileName` + `.fileSub`），移动端无需 CSS 改动。只需确保 `padding: 10px 14px` 和行间分隔线。该页面是管理员专属，非 admin 用户的底栏"更多" Sheet 不显示此入口（`user.role === 'admin'` 条件在 MobileMoreSheet 组件内部判断）。

---

#### 5.2.9 终端管理 (admin-clients)

```
┌──────────────────────────────────────┐
│ ← 终端管理             [共 2]       │  页面标题（管理员专属）
├──────────────────────────────────────┤
│ 存储终端 A          [online] [直连] │
│   ID: abc123                         │
│   状态: online · 心跳 2分钟前        │
│   [全部重连]  [启用]  [禁用]         │  独占一行，wrap
│ ─────────────────────────────────── │
└──────────────────────────────────────┘
```

**变化说明：**
- 操作按钮 `[全部重连] [启用] [禁用]` 独立一行，`flex-wrap: wrap; gap: 6px`
- 每个按钮 `size="small"`，保证 `min-height: 32px`
- `withActions` 行 `flex-direction: column; align-items: flex-start`

**⚙️ 具体实施细节：**

桌面 `.simpleRow.withActions` 是水平布局，文字信息和按钮组左右排列。移动端改为垂直：
```css
@media (max-width: 760px) {
  .mobilePageContent .simpleRow.withActions {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 10px 14px;
  }
  .mobilePageContent .simpleRow.withActions .row {
    flex-wrap: wrap;
    gap: 6px;
  }
}
```

`Promise.all(["download","upload","preview","control"].map(role => p2p?.connectToPeer(item.id, role)))` 即"全部重连"逻辑，在移动端点击时同样执行，无需修改。

**参数注意**：`changeClientStatus` 函数在 App.jsx 中定义，通过 `renderAdminClientsPage()` 闭包访问，移动端调用同一渲染函数时天然共享，无需额外传参。

---

触发方式：底栏"更多" Tab → `MobileMoreSheet` 列出入口 → 点击进入对应页面

进入后页面顶部显示返回按钮（← 返回更多），页面在 mobilePageContent 中全屏展示。

```jsx
// moreNavigatedTab 状态管理（App.jsx 内）
const [moreNavigatedTab, setMoreNavigatedTab] = useState(null);

// MobileMoreSheet 的 onNavigate 回调
function handleMoreNavigate(tabId) {
  setMoreSheetOpen(false);
  setMoreNavigatedTab(tabId); // 'transfers' | 'shares' | 'terminals' | 'admin-users' | 'admin-clients'
  setActiveMobileTab('more'); // 底栏 Tab 保持选中"更多"
}

// renderMobileActivePage 内增加路由
case 'more':
  if (moreNavigatedTab) {
    return renderMoreSubPage(moreNavigatedTab); // 含返回按钮
  }
  return null; // 无子页面时 MoreSheet 已在上层显示
```

```jsx
function renderMoreSubPage(tabId) {
  return (
    <div className="mobileSubPage">
      <div className="mobileSubPageHeader">
        <button className="mobileBackButton" onClick={() => { setMoreNavigatedTab(null); setMoreSheetOpen(true); }}>
          ← 更多
        </button>
      </div>
      {tabId === 'transfers'    && renderTransfersPage()}
      {tabId === 'shares'       && renderSharesPage()}
      {tabId === 'terminals'    && renderTerminalsPage()}
      {tabId === 'admin-users'  && renderAdminUsersPage()}
      {tabId === 'admin-clients' && renderAdminClientsPage()}
    </div>
  );
}
```

**⚙️ mobileSubPage CSS：**
```css
.mobileSubPage {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}
.mobileSubPageHeader {
  display: flex;
  align-items: center;
  padding: 8px 14px;
  border-bottom: 1px solid var(--stroke);
  flex-shrink: 0;
  position: sticky;
  top: 0;
  background: var(--page-bg);
  z-index: 5;
}
.mobileBackButton {
  background: none;
  border: none;
  color: var(--accent);
  font-size: 15px;
  font-weight: 500;
  padding: 8px 0;
  cursor: pointer;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 6px;
}
```

**⚠️ Android 硬件返回键：**
Android 用户点击系统返回键时，默认行为是 `history.back()`（可能退出 SPA）。在 `moreNavigatedTab` 非空时，应拦截返回键返回 MoreSheet，而不是退出页面：
```js
// App.jsx useEffect
useEffect(() => {
  if (!moreNavigatedTab) return;
  // 压入一个假历史条目
  window.history.pushState({ moreNav: true }, '');
  const onPop = () => {
    setMoreNavigatedTab(null);
    setMoreSheetOpen(true);
  };
  window.addEventListener('popstate', onPop);
  return () => window.removeEventListener('popstate', onPop);
}, [moreNavigatedTab]);
```

---

## 6. MiniMusicBar（可选）

仅当有正在播放的音乐时，在内容区与底栏之间显示。

```
┌─────────────────────────────────────────┐
│ 💿 [专辑图 36px]  歌曲名 · 歌手  [⏯][⏭]│
└─────────────────────────────────────────┘
```

```css
.mobileMinimusicBar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 48px;
  padding: 0 14px;
  flex-shrink: 0;
  background: rgba(248,250,252,0.96);
  border-top: 1px solid var(--stroke);
  border-bottom: 1px solid var(--stroke);
  cursor: pointer;   /* 点击展开完整播放器 sheet */
}
```

点击 MiniMusicBar → 展开 `MusicPlayerSheet`（从底部全屏覆盖）

**⚙️ 具体实施细节：**

**① GlobalMusicPlayer Context 消费（推荐 P2 实施方案）：**

GlobalMusicPlayer 当前是自包含组件，不对外暴露播放状态。MiniMusicBar 需要知道 `currentTrack`、`isPlaying`、`togglePlay`、`nextTrack`。

**最小侵入方案**（CSS 隐藏 + 保留组件）：
```css
/* GlobalMusicPlayer 在移动端隐藏悬浮 shell，但组件保持挂载（保留状态/音频实例） */
@media (max-width: 760px) {
  .globalMusicShell {
    display: none !important;
  }
}
```
然后 MiniMusicBar 通过 **添加到 GlobalMusicPlayer 的 Context** 消费状态。在 GlobalMusicPlayer 组件内部新增：
```jsx
// GlobalMusicPlayer.jsx 新增
export const MusicPlayerContext = createContext(null);
// 在组件 return 最外层包裹
<MusicPlayerContext.Provider value={{ currentTrack, isPlaying, togglePlay, nextTrack, seek }}>
  <div className="globalMusicShell"> ... </div>
</MusicPlayerContext.Provider>
```
MiniMusicBar 使用：
```jsx
const { currentTrack, isPlaying, togglePlay, nextTrack } = useContext(MusicPlayerContext);
```

**② 全局 Context 放置**：GlobalMusicPlayer 在移动端需要仍然渲染（保留音频实例），但放在 MobileLayout **外**（在 App.jsx 顶层），并通过 Context 访问：
```jsx
// renderMobileLayout() 中
<>
  <GlobalMusicPlayer p2p={p2p} clients={clients} user={user} onToast={setMessage} />
  <div className="mobileApp">
    ...
    {hasMusicTrack && <MiniMusicBar />}   {/* 通过 Context 读取 hasMusicTrack */}
  </div>
</>
```

> ⚠️ `.globalMusicShell` 类名需在实际代码中确认——通过搜索 `GlobalMusicPlayer.jsx` 查找最外层容器 className。

**③ MusicPlayerSheet**（P2 选做）：点击 MiniMusicBar 弹出的全屏播放器，使用 Portal 渲染到 body，z-index 55，含专辑图大图、进度条、歌词（如有）。不在当前规划中详细设计，待 P2 阶段实施。

---

## 7. MobileMoreSheet（"更多" 底部面板）

```
┌──────────────────────────────────────┐
│ ▬ (drag handle)                      │
│                                      │
│  📥 传输队列           [进行中 2]   │
│  🔗 分享管理           [共 5]       │
│  🖥 终端状态           [在线 3]     │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  👤 用户管理  (admin only)           │
│  🖥 终端管理  (admin only)           │
│                                      │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  [ 退出登录 ]                        │← 从顶栏移过来
└──────────────────────────────────────┘
```

```css
.mobileMoreSheet {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  border-radius: 16px 16px 0 0;
  background: #fff;
  z-index: 50;
  padding: 12px 0 calc(16px + env(safe-area-inset-bottom));
  box-shadow: 0 -8px 40px rgba(15,23,42,0.12);
  transform: translateY(100%);
  transition: transform 0.25s cubic-bezier(0.32,0.72,0,1);
}

.mobileMoreSheet.open {
  transform: translateY(0);
}

.mobileMoreSheetBackdrop {
  position: fixed;
  inset: 0;
  background: rgba(15,23,42,0.32);
  z-index: 49;
}
```

**⚙️ 具体实施细节：**

**① 使用 React Portal 防止 backdrop-filter 干扰（重要）：**
```jsx
// MobileMoreSheet.jsx
import { createPortal } from 'react-dom';

export function MobileMoreSheet({ open, onClose, ... }) {
  return createPortal(
    <>
      {open && <div className="mobileMoreSheetBackdrop" onClick={onClose} />}
      <div className={`mobileMoreSheet${open ? ' open' : ''}`} role="dialog" aria-modal="true">
        ...
      </div>
    </>,
    document.body
  );
}
```
Portal 到 `document.body`，让 Sheet 脱离 MobileLayout DOM 树，彻底避免任何祖先的 `transform`/`backdrop-filter` 干扰 `position: fixed`。

**② GPU 加速动画：**
```css
.mobileMoreSheet {
  will-change: transform;  /* GPU 合成层 */
  /* 注意：will-change 只在开启动画时有效，Sheet 关闭后不要保持 */
}
```

**③ 打开时锁定 body 滚动：**
Sheet 开启时应防止背景页面滚动（尤其 iOS）：
```js
useEffect(() => {
  if (open) {
    document.body.style.overflow = 'hidden';
  } else {
    document.body.style.overflow = '';
  }
  return () => { document.body.style.overflow = ''; };
}, [open]);
```

**④ Escape 键关闭：**
```js
useEffect(() => {
  if (!open) return;
  const onKey = (e) => { if (e.key === 'Escape') onClose(); };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}, [open, onClose]);
```

**⑤ 可访问性：**
- Sheet `<div>` 加 `role="dialog" aria-modal="true" aria-label="更多选项"`
- 打开时将焦点移到 Sheet 第一个可交互元素
- 关闭时将焦点还给触发按钮（保存 `ref` 到"更多"Tab 按钮）

**⑥ 退出登录按钮位置：**
MobileMoreSheet 和 ProfileDialog 都可以触发 `logout()`。两者并存，不冲突。在 Sheet 内的"退出登录"行使用红色文字+图标，与列表项视觉区分（`color: var(--danger, #dc2626)`）。

---

## 8. MobileFilterSheet（筛选面板 BottomSheet）

替代现有 `.filterPanelShell` 内嵌展开，改为从底部弹出的 Sheet。

```
┌──────────────────────────────────────┐
│ ▬   筛选 & 排序              [重置] │
├──────────────────────────────────────┤
│ 关键词  [________________________]  │
│ 类型    [▼ 全部                  ]  │
│ 格式    [▼ 全部                  ]  │
│ 排序    [▼ 上传时间 ↓            ]  │
├──────────────────────────────────────┤
│         [ 应用筛选 ]                 │
└──────────────────────────────────────┘
```

**⚙️ 具体实施细节：**

**① 连接到 App.jsx 现有筛选状态：**

App.jsx 目前有 4 个分散的筛选 state：`keyword`、`columnFilter`、`typeFilter`、`sortBy`。MobileFilterSheet 需要接收它们并在"应用"时回调：

```jsx
// App.jsx 中新增
const [filterSheetOpen, setFilterSheetOpen] = useState(false);

// renderMobileLayout() 中
<MobileFilterSheet
  open={filterSheetOpen}
  onClose={() => setFilterSheetOpen(false)}
  keyword={keyword}
  columnFilter={columnFilter}
  typeFilter={typeFilter}
  sortBy={sortBy}
  columns={columns}
  onApply={({ keyword, columnFilter, typeFilter, sortBy }) => {
    setKeyword(keyword);
    setColumnFilter(columnFilter);
    setTypeFilter(typeFilter);
    setSortBy(sortBy);
    setFilterSheetOpen(false);
  }}
  onReset={() => {
    setKeyword('');
    setColumnFilter('all');
    setTypeFilter('all');
    setSortBy('createdAt');
    setFilterSheetOpen(false);
  }}
/>
```

**② 本地草稿模式：**
Sheet 内部维护一份本地 draft state，只有点击"应用筛选"才 commit 到 App.jsx，点击"重置"或关闭时丢弃 draft（**不**实时更新，避免打字时文件列表不断过滤闪烁）。
```jsx
// MobileFilterSheet.jsx 内部
const [draft, setDraft] = useState({ keyword, columnFilter, typeFilter, sortBy });
// 打开时同步外部值
useEffect(() => {
  if (open) setDraft({ keyword, columnFilter, typeFilter, sortBy });
}, [open]);
```

**③ Dropdown 在 Sheet 内的层叠：**
Fluent UI v9 `<Dropdown>` 的选项列表（`Listbox`）会 Portal 到 body，z-index 默认很高（~9999），不需担心被 Sheet 遮挡。

**④ 同样使用 Portal：** 
MobileFilterSheet 也应通过 `createPortal` 挂到 `document.body`，与 MobileMoreSheet 保持一致，避免定位问题。

**⑤ activeFilterCount 徽章：**
筛选按钮上的 `.filterToggleBadge` 在移动端照常显示，数值来自 `activeFilterCount`。Sheet 关闭后，外部 state 已更新，徽章立即反映。

---

## 9. 组件接口设计（Props API）

### 9.1 `MobileLayout`（新建）

```jsx
// web/src/components/mobile/MobileLayout.jsx
<MobileLayout
  user={user}
  loading={loading}
  activeTab={activeWorkspaceTab}     // 共享 desktop 的同一 state
  moreSheetOpen={moreSheetOpen}      // 控制"更多" Tab active 状态
  onTabChange={handleMobileTabChange}
  onUpload={() => setUploadOpen(true)}
  onSync={refreshAll}
  onProfileOpen={() => setProfileOpen(true)}
  musicBar={hasMusicTrack ? <MiniMusicBar /> : null}
>
  {renderMobileActivePage()}
</MobileLayout>
```

> `MobileLayout` 内部结构：`header.mobileTopbar` + `div.mobilePageContent` + `{musicBar}` + `MobileBottomTabBar`。不含对话框，对话框在 App.jsx 顶层。

### 9.2 `MobileBottomTabBar`（新建）

```jsx
// web/src/components/mobile/MobileBottomTabBar.jsx
<MobileBottomTabBar
  tabs={[
    { id: 'explorer', icon: <FolderRegular />, label: '文件', badge: null },
    { id: 'chat',     icon: <ChatRegular />,   label: '聊天', badge: onlineCount },
    { id: 'overview', icon: <AppsListRegular />, label: '概览', badge: null },
    { id: 'tv',       icon: <StreamRegular />, label: '直播', badge: null },
    { id: 'more',     icon: <MoreHorizontalRegular />, label: '更多', badge: moreBadge },
  ]}
  activeTab={activeTab}
  onTabChange={onTabChange}
/>
```

### 9.3 `MobileMoreSheet`（新建）

```jsx
// web/src/components/mobile/MobileMoreSheet.jsx
<MobileMoreSheet
  open={moreSheetOpen}
  onClose={() => setMoreSheetOpen(false)}
  onNavigate={handleMoreNavigate}  // (tabId) => { setMoreSheetOpen(false); setMoreNavigatedTab(tabId); }
  user={user}                       // 用于 admin 入口判断 (user.role === 'admin')
  transferCount={visibleUploadJobs.length + downloadingCount}
  shareCount={shares.length}
  onlineClientCount={onlineCount}
  onLogout={logout}
/>
```

### 9.4 `MiniMusicBar`（新建）

```jsx
// web/src/components/mobile/MiniMusicBar.jsx
<MiniMusicBar
  track={currentTrack}           // { title, artist, coverArtUrl } | null
  playing={isPlaying}
  onTogglePlay={togglePlay}
  onNext={nextTrack}
  onExpand={() => setMusicSheetOpen(true)}
/>
```

### 9.5 `MobileFilterSheet`（新建）

```jsx
// web/src/components/mobile/MobileFilterSheet.jsx
<MobileFilterSheet
  open={filterSheetOpen}
  onClose={() => setFilterSheetOpen(false)}
  filters={filters}              // { keyword, type, sort }
  onChange={setFilters}
  onApply={applyFilters}
  onReset={resetFilters}
/>
```

---

## 10. 文件结构规划

```
web/src/
├── components/
│   ├── mobile/                   ← 新建目录
│   │   ├── MobileLayout.jsx      ← 移动端根布局
│   │   ├── MobileBottomTabBar.jsx
│   │   ├── MobileMoreSheet.jsx
│   │   ├── MiniMusicBar.jsx
│   │   ├── MobileFilterSheet.jsx
│   │   └── MobilePageWrapper.jsx ← 通用页面滚动容器
│   └── (existing components)
├── App.jsx                       ← 添加 isMobile 分叉
└── styles.css                    ← 添加 mobile-*.css 对应 class
```

---

## 11. App.jsx 修改接口

```jsx
// App.jsx
const isMobile = useIsMobile();   // ← 新 hook，监听 resize

return (
  <div className="page">
    {isLoggedIn
      ? isMobile
        ? renderMobileLayout()   // ← 新增
        : renderDesktopLayout()  // ← 现有逻辑提取成函数
      : renderAuthPage()
    }
    {/* Dialogs 不区分移动/桌面 */}
    {previewOpen && <PreviewModal ... />}
    {profileOpen && <ProfileDialog ... />}
    {uploadOpen && <UploadDialog ... />}
  </div>
);

function renderMobileLayout() {
  return (
    <MobileLayout
      user={user} loading={loading}
      activeTab={activeMobileTab}
      onTabChange={(id) => {
        if (id === 'more') { setMoreSheetOpen(true); return; }
        setActiveMobileTab(id);
      }}
      onUpload={() => setUploadOpen(true)}
      onSync={refreshAll}
      onProfileOpen={() => setProfileOpen(true)}
    >
      {renderMobileActivePage()}
    </MobileLayout>
  );
}

function renderMobileActivePage() {
  switch (activeMobileTab) {
    case 'chat':     return <ChatRoom ... />;
    case 'overview': return renderOverviewPage();
    case 'tv':       return <TVStream ... />;
    case 'explorer': default: return renderExplorerPage();
    // more 系列通过 moreNavigated 状态路由
  }
}
```

**⚙️ 实施细节：**

**① 需要新增的 state：**
```js
const [moreSheetOpen, setMoreSheetOpen] = useState(false);
const [moreNavigatedTab, setMoreNavigatedTab] = useState(null);
const [filterSheetOpen, setFilterSheetOpen] = useState(false);
// activeMobileTab 直接复用 activeWorkspaceTab（不新增）
```

**② `renderMobileActivePage` 中的 more 路由：**
```js
function renderMobileActivePage() {
  const tab = activeWorkspaceTab;
  if (tab === 'more') {
    return moreNavigatedTab ? renderMoreSubPage(moreNavigatedTab) : null;
  }
  // 对应 switch ... case
}
```
"更多" Sheet 在 App.jsx 顶层通过 Portal 渲染，不在 `renderMobileActivePage` 内。

**③ `renderDesktopLayout()` 提取：**
提取时注意：现有 return 中有 `<header className="appTopbar">` + `<div className="workspaceLayout">` + 所有对话框。提取时**只包裹 header + layout**，对话框留在外面。建议先只做"把现有代码包进一个函数"，不改任何逻辑，再测试桌面版无变化。

**④ `isMobileViewport` 迁移：**
App.jsx 现有：
```js
const [isMobileViewport, setIsMobileViewport] = useState(() => window.innerWidth <= 760);
useEffect(() => {
  const onResize = () => setIsMobileViewport(window.innerWidth <= 760);
  window.addEventListener('resize', onResize);
  return () => window.removeEventListener('resize', onResize);
}, []);
```
改为：
```js
const isMobile = useIsMobile();  // = useIsMobile hook
const isMobileViewport = isMobile;  // 别名保持下游用法不变（explorerPage 里用了 isMobileViewport）
```

**⑤ ChatRoom props 保留：**
```jsx
case 'chat': return (
  <ChatRoom
    authToken={token}
    currentUser={user}
    clients={clients}
    p2p={p2p}
    setMessage={setMessage}
    getClientDisplayName={getClientDisplayName}
    openMediaPreview={preview}
    saveChatAttachmentToLibrary={saveChatAttachmentToLibrary}
  />
);
```
所有 props 与桌面版相同，无需修改。

### `useIsMobile` hook

```jsx
// web/src/hooks/useIsMobile.js（新建）
import { useState, useEffect } from 'react';

export function useIsMobile(breakpoint = 760) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= breakpoint);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [breakpoint]);
  return isMobile;
}
```

---

## 12. 对话框 / Modal 移动端适配

所有对话框在 `App.jsx` 的 `return` 顶层渲染（`previewOpen`、`uploadOpen` 等），**不在** MobileLayout 内部，因此不受 backdrop-filter 祖先元素影响，`position: fixed` 可正常工作。

---

### 12.1 PreviewModal（文件预览）

PreviewModal 已有响应式适配（之前已修复 ≤1200px 和 ≤760px 断点）。移动端无需额外改动，直接保留。

> ⚠️ PreviewModal 使用 `.overlay` (position: fixed; inset: 0; z-index: 60+) 渲染，挂在 `.page` 最外层，不受 `.mobileApp` 的 `overflow: hidden` 影响。确认 `.page` 本身没有 `overflow: hidden` 样式即可。

---

### 12.2 ProfileDialog（用户档案）

桌面设计不变。移动端：
- 在 3.1 MobileTopbar 中已指定头像按钮触发 `setProfileOpen(true)`
- **退出登录**按钮：ProfileDialog 内已有，不需要额外在 MobileMoreSheet 里重复添加（MobileMoreSheet 的退出登录条目调用同一 `logout()`，与 ProfileDialog 内的退出并存，任选其一）

**⚙️ 确认 ProfileDialog 当前尺寸：**
如果 ProfileDialog 是居中模态（非 drawerSheet），在手机小屏上可能左右被裁剪。读取 `ProfileDialog.jsx` 确认其容器 className，若非 drawerSheet，补：
```css
@media (max-width: 520px) {
  .profileDialog {         /* 实际 classname 待确认 */
    width: calc(100vw - 32px);
    max-height: 90dvh;
    overflow-y: auto;
  }
}
```

---

### 12.3 上传工作台（uploadOpen）

上传工作台是最复杂的对话框，桌面版步骤 1 + 步骤 2 两栏布局在手机上会宽度不足：

**步骤 1（选择目标终端）**：单字段 + 按钮，已适合手机，无需改动。

**步骤 2（文件选择 + 目录）**：`.uploadWorkbenchGrid` 为两列布局，需响应式覆盖：

```css
@media (max-width: 760px) {
  .uploadWorkbenchGrid.uploadWorkbenchStep2 {
    grid-template-columns: 1fr;   /* 单列堆叠 */
  }

  /* 目录浏览树折叠为折叠按钮（默认收起），节省空间 */
  .uploadFolderBrowser {
    display: none;         /* 默认收起 */
  }
  .uploadFolderBrowser.expanded {
    display: block;        /* 展开时显示 */
  }

  /* 文件列表在目录选择器下方 */
  .uploadSelectionPanel {
    order: -1;             /* 文件列表放在顶部，更重要 */
  }
}
```

**交互调整**：
- 步骤 2 顶部：先显示"待上传文件"列表（`uploadSelectionPanel`），下方折叠目录选择（"选择目录 ▼"按钮展开）
- 这样用户最常用的"选文件"操作不被目录树遮挡

**⚙️ 具体细节：**

- `.uploadFolderBrowser` 显隐需要一个 state 控制：`const [folderBrowserOpen, setFolderBrowserOpen] = useState(false)`，或通过 `isMobile && uploadAdvancedOpen` 复用现有高级设置开关。

- 上传对话框是 `position: fixed`，不受 `.mobileApp overflow: hidden` 影响（对话框在 `.page` 顶层）。

- 键盘弹出时对话框内容可能被遮挡：给对话框 `.uploadModal` 加 `overflow-y: auto` 并指定 `max-height`：
  ```css
  @media (max-width: 760px) {
    .uploadModal {
      max-height: 95dvh;
      overflow-y: auto;
    }
  }
  ```

---

### 12.4 分享链接对话框（shareDialogOpen）

对话框已使用 `.drawerSheet` 类（`position: fixed; bottom: 0`），移动端天然适配。

**唯一需注意**：历史记录展开（`shareHistoryOpen`）时内容过长，`.shareModal` 需限高并内部滚动：

```css
@media (max-width: 760px) {
  .shareModal {
    max-height: 90dvh;
    overflow-y: auto;
  }
}
```

**另注**：`.drawerSheet` 使用了 `position: fixed`，需确认其祖先链上无 `transform`/`backdrop-filter`。因为对话框挂在 `.page` 直接子层（不在 `.mobileApp` 内），祖先只有 `.page`（无 backdrop-filter），安全。

---

### 12.5 编辑文件 / 文件夹 / 新建文件夹对话框

这三个对话框相对简单（Input 字段 + 按钮），使用 `.dialogModal` 居中模态，在手机上表现正常。建议仅做两项 CSS 补充：

```css
@media (max-width: 520px) {
  .editFileModal,
  .createFolderDialog {
    width: calc(100vw - 32px);   /* 距屏幕边缘 16px */
    max-height: 90dvh;
    overflow-y: auto;
  }
}
```

**另注**：`editFileAdvancedOpen` 展开"高级设置"时会有多个 Dropdown，Dropdown 的弹出 Listbox 会 Portal 到 body，不影响对话框高度。

---

### 12.6 连接诊断抽屉（diagnosticsOpen）

已使用 `.drawerSheet diagnosticsDrawer`，`position: fixed; bottom: 0`，移动端天然适配。

`.diagList` 内 `.diagItem` 每条内容较多，移动端仅展示关键字段（status + route），详细角色信息可折叠。

```css
@media (max-width: 760px) {
  .diagnosticsDrawer {
    max-height: 90dvh;
    overflow-y: auto;
  }
  /* 角色连接详情默认折叠 */
  .diagRoleCards {
    display: none;
  }
  .diagItem.expanded .diagRoleCards {
    display: block;
  }
}
```

> 若不想改 diagnosticsDrawer 内部逻辑，只加 `max-height + overflow-y: auto` 即可，用户可滚动查看所有终端。

---

## 13. 架构说明：GlobalMusicPlayer 与 MiniMusicBar 的关系

**现状**：`GlobalMusicPlayer` 渲染在桌面顶栏的 `.brandIdentity` 内，采用 `position: fixed; z-index: 60` 悬浮显示，有三态：mini 按钮 → 悬浮卡片 → 展开播放器。

**移动端问题**：MobileLayout 的 MobileTopbar 完全替换了桌面顶栏，`GlobalMusicPlayer` 不再出现在 DOM 中，导致音乐功能丢失。

**方案**：

```jsx
// App.jsx renderMobileLayout()
function renderMobileLayout() {
  return (
    <MobileLayout
      musicBar={currentTrack ? <MiniMusicBar ... /> : null}
      ...
    >
      {renderMobileActivePage()}
      {/* GlobalMusicPlayer 仍需挂载，但隐藏其默认 UI */}
      <GlobalMusicPlayer
        p2p={p2p} clients={clients} user={user} onToast={setMessage}
        hiddenUI   // ← 新增 prop：跳过自身 fixed shell 渲染，仅保持状态逻辑
      />
    </MobileLayout>
  );
}
```

或更简单地，提取 GlobalMusicPlayer 的播放状态到单独 Context，MiniMusicBar 直接消费该 Context，不需要 `hiddenUI` prop 改造。

**推荐方案（最小侵入）**：
1. GlobalMusicPlayer 继续在移动端渲染，但通过 CSS 在移动端隐藏其 fixed shell：
   ```css
   @media (max-width: 760px) {
     .globalMusicShell { display: none; }   /* 隐藏悬浮 shell */
   }
   ```
2. MiniMusicBar 通过已有的 `useMusicPlayer()` Context 消费 `currentTrack`、`isPlaying`、`togglePlay`、`nextTrack`
3. 如果 GlobalMusicPlayer 尚未暴露 Context，在实施 P2 阶段同步添加

---

## 14. 边界情况与注意事项

### 14.1 批量工具栏与底栏的层叠

资源浏览器批量选中时显示 `.bulkToolbar`（`position: sticky; bottom: 0`），会与 MiniMusicBar 和 BottomTabBar 层叠：

```
[内容区域滚动]  ← mobilePageContent overflow-y: auto
[bulkToolbar]  ← sticky bottom inside mobilePageContent（不会盖住 BottomTabBar）
[MiniMusicBar] ← flex-shrink: 0 in mobileApp 列
[BottomTabBar] ← flex-shrink: 0 in mobileApp 列
```

因为 sticky 发生在 `mobilePageContent` 的滚动容器内部，不会超出容器边界，栈顺序天然正确。

> ⚠️ 若 `.bulkToolbar` 原先有 `position: fixed`，则必须改为 `sticky`，否则会覆盖底栏。确认现有 CSS 中 `.bulkToolbar` 的 position 值，若是 fixed，在移动端媒体查询中覆盖为 sticky。

---

### 14.2 MobileMoreSheet 的 backdrop-filter 问题

MobileMoreSheet 使用 `position: fixed`，若其祖先有 `backdrop-filter`，fixed 会相对于该祖先偏移。

`.mobileApp` 不应有 `backdrop-filter`，但需确认 MobileLayout 的根元素不包含 `-webkit-backdrop-filter`。MobileBottomTabBar 自身的 `backdrop-filter: blur(12px)` 不影响其兄弟元素，只影响自身背景，无问题。

如果 MobileMoreSheet 是 MobileLayout 的子元素，需注意检查整条祖先链。最安全方案：**通过 React Portal 将 MobileMoreSheet 和 MusicPlayerSheet 渲染到 `document.body`**（见第 7 节实施细节）。

---

### 14.3 删除确认对话框

批量删除 (`requestBatchDelete`) 和单文件删除会弹出确认对话框 (`.overlay .modalWindow`)。这类对话框在大多数情况下是简单的 Alert 样式，移动端无需特殊处理，只确保覆盖全屏、touch 可点击即可。

**⚠️ 确认按钮的触控区域**：删除确认的"确认删除"按钮必须有足够大的点击区域，避免用户误操作或无法点击。`min-height: 44px` 保证基本要求。

---

### 14.4 ChatRoom 附件上传

ChatRoom 组件内的附件文件选择在移动端直接触发 `<input type="file" accept="*">` 即可，iOS/Android 均支持。DropZone 拖放在移动端可静默禁用（不影响点击上传）。

**⚙️ 细节**：移动端的 `<input type="file">` 在 iOS 会弹出"拍照/相册/文件"三选一，这是系统行为，无法绕过也无需处理。

---

### 14.5 Tab 切换时的滚动位置

切换 Tab 时 `mobilePageContent` 内的滚动位置会重置（React 重新挂载组件）。资源浏览器已有 `listScrollTop` 状态，切换回来后可通过 `scrollTop` 恢复。其他页面滚动位置不需要保留。

**⚙️ 恢复滚动的实现方式**：
```jsx
// mobilePageContent ref
const pageContentRef = useRef(null);

// activeWorkspaceTab 切换回 explorer 时恢复
useEffect(() => {
  if (activeWorkspaceTab === 'explorer' && pageContentRef.current) {
    pageContentRef.current.scrollTop = listScrollTop;
  }
}, [activeWorkspaceTab]);
```

---

### 14.6 `prefers-reduced-motion` 动效

Sheet 动画（`transform: translateY`）对部分用户（前庭系统敏感）不友好：
```css
@media (prefers-reduced-motion: reduce) {
  .mobileMoreSheet,
  .mobileFilterSheet {
    transition: none;
  }
}
```

---

### 14.7 Android 硬件返回键

已在 5.2.5 节的 `moreNavigatedTab` 路由部分给出了 `pushState`/`popstate` 方案。

同理，当 `moreSheetOpen === true` 时，也应拦截返回键关闭 Sheet（而不是退出 SPA）：
```js
useEffect(() => {
  if (!moreSheetOpen) return;
  window.history.pushState({ moreSheet: true }, '');
  const onPop = () => setMoreSheetOpen(false);
  window.addEventListener('popstate', onPop);
  return () => window.removeEventListener('popstate', onPop);
}, [moreSheetOpen]);
```

`filterSheetOpen` 同理。多个 Sheet 同时 push history 时，`popstate` 会按 LIFO 顺序消费，行为正确。

---

## 15. 实施顺序（优先级）

| 阶段 | 任务 | 说明 |
|------|------|------|
| P0 | `useIsMobile` hook + App.jsx 分叉 | 基础架构，不改现有桌面逻辑 |
| P0 | `MobileLayout` + `MobileBottomTabBar` | 框架容器，先空内容 |
| P1 | `MobileMoreSheet` + `moreNavigatedTab` 路由 | 替代导航，让所有 Tab 可达 |
| P1 | 资源浏览器移动适配 | 最常用功能，优先保障 |
| P1 | 聊天室高度修复 | chatRoomShell height 问题 |
| P1 | 上传工作台 CSS 单列覆盖 | 步骤 2 双栏在手机上变单列 |
| P2 | `MiniMusicBar` + GlobalMusicPlayer CSS 隐藏方案 | 音乐播放移动端体验（见第 13 节） |
| P2 | `MobileFilterSheet` | 筛选面板 |
| P2 | 对话框移动端 CSS 补丁（shareModal 限高等） | 见第 12 节 |
| P3 | 概览、传输、分享、终端、TV 细节适配 | 次要页面 |
| P3 | 横屏 TV 全屏 + 手势 | 用户体验加分项 |
| P3 | MobileMoreSheet Portal 渲染 | 防 backdrop-filter 问题（见 14.2） |

---

## 16. 关键 CSS 变量 / 设计 Token

```css
/* 移动端专用，建议加到 :root 下 */
--mobile-topbar-height: 48px;
--mobile-bottombar-height: 56px;
--mobile-musicbar-height: 48px;
--mobile-safe-bottom: env(safe-area-inset-bottom, 0px);
--mobile-content-height: calc(
  100dvh
  - var(--mobile-topbar-height)
  - var(--mobile-bottombar-height)
  - var(--mobile-safe-bottom)
);
/* chatRoomShell 高度参考此变量 */
```

**⚙️ MiniMusicBar 出现时动态更新：**

当 MiniMusicBar 显示时，`--mobile-content-height` 需要额外减去 48px。推荐用 JS 动态更新根变量，而不是多个 calc 嵌套：

```js
// 在 App.jsx useEffect 中（或 MobileLayout 内部）
useEffect(() => {
  const root = document.documentElement;
  const musicBarH = hasMusicTrack ? 48 : 0;
  root.style.setProperty(
    '--mobile-content-height',
    `calc(100dvh - 48px - 56px - ${musicBarH}px - env(safe-area-inset-bottom, 0px))`
  );
}, [hasMusicTrack]);
```

这样 `chatRoomShell` 使用 `height: var(--mobile-content-height)` 后，MiniMusicBar 出现/消失时聊天容器高度自动响应。

**⚠️ 避免 `transition` 闪烁**：当 MiniMusicBar 渐入/渐出时，`--mobile-content-height` 突变会导致 chatRoomShell 跳动。可给 chatRoomShell 加 `transition: height 0.25s ease`，或让 MiniMusicBar 和聊天高度变化同步动画时长。

---

*文档完（v1.2 — 全面补充每项实施细节、注意事项与边界处理）。实施时每个阶段建议单独 commit，以便回滚。*
