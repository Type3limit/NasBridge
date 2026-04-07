# SharePage 性能审计报告

> 上次审计：已完成   更新时间：最新

## 已修复问题汇总

| # | 问题 | 修复方式 |
|:--|:-----|:---------|
| ~~P1~~ | 页面加载并发 P2P 风暴 | 合并 thumbnail + preview 两个 `useEffect` 为一个串行 effect：先 thumbnail（轻量）再 preview（重量级） |
| ~~P2~~ | `/api/share/:shareId` 单请求 5× `readDb()` | 新增 `resolveShareAccess(shareId)` 函数，单次 `readDb()` + 单次 `writeDb()` |
| ~~P3~~ | P2PBridgePool 创建 4 个 Bridge，分享页只用 2 个 | `P2PBridgePool` 构造函数新增 `options.roles` 参数；分享页传 `["preview", "download"]` |
| ~~P4~~ | `canBrowserPlayVideoMime` 每次创建 DOM | 添加 `_canPlayCache` Map 缓存 |
| ~~P5~~ | `getHlsPlaybackSupport` 无缓存 | 添加 `_hlsSupportCache` 模块级变量 |
| ~~P6~~ | Blob URL 下载后 60s 才释放 | 超时从 `60_000` → `5_000` |
| ~~P7~~ | PreviewModal 4 个 inline 回调每次 re-render | `useCallback` 包裹 `handleFirstFrame`、`handleDownload`、`handleOpenInLivingRoom`、`getClientDisplayName` |
| ~~P9~~ | `emptyPreviewDebug()` 每次创建新对象 | 替换为 `EMPTY_PREVIEW_DEBUG = Object.freeze({...})` 模块级常量 |
| ~~P10~~ | CSS 多层渐变 + backdrop-filter paint 开销 | `will-change: background` + `.surfaceCard { contain: layout paint }` |

---

## 遗留问题（降级/重新评估）

### P8 — `clearPreview()` 多个 setState（已降级为非问题）

**原描述**：`clearPreview()` 调用 10 个 `setState`，怀疑触发多轮 re-render。

**重新评估**：React 18 的 **Automatic Batching** 机制已覆盖所有上下文（同步、`Promise.then`、`setTimeout`、原生事件处理器），即使在 `await` 之后调用 `clearPreview()`，React 也只会触发一次 re-render。因此该问题不构成实际性能瓶颈，无需 `useReducer` 重构。

**状态**：🟢 无需修改

---

## 新发现问题

| # | 问题 | 影响层 | 严重度 | 涉及文件 |
|:--|:-----|:-------|:-------|:---------|
| N1 | "大屏播放"按钮 inline onClick 与 `handleOpenInLivingRoom` 逻辑重复 | 代码冗余 / 每次 render 新函数 | 🟢 低 | `SharePage.jsx` L686-695 |
| N2 | `switchPreviewHlsProfile` 传给 PreviewModal 未 `useCallback` | 子树 re-render | 🟢 低 | `SharePage.jsx` L451-460, L812 |
| N3 | `stopActivePreviewSession` 传给 PreviewModal 未 `useCallback` | 子树 re-render | 🟢 低 | `SharePage.jsx` L292-299, L818 |

---

### N1 — "大屏播放" inline onClick 重复逻辑

**现状**

```jsx
<Button onClick={() => {
  try {
    sessionStorage.setItem("lr_share_launch", JSON.stringify({ ... }));
  } catch { }
  window.location.assign("/living-room.html");
}}>
  大屏播放
</Button>
```

该 inline handler 与已有的 `handleOpenInLivingRoom`（已用 `useCallback` 包裹）逻辑完全相同。

**建议**

直接复用 `handleOpenInLivingRoom`：

```jsx
<Button onClick={handleOpenInLivingRoom}>大屏播放</Button>
```

**影响**：消除冗余代码 + 避免每次 render 创建新函数引用。

---

### N2 — `switchPreviewHlsProfile` 未 useCallback

**现状**

```jsx
async function switchPreviewHlsProfile(profileId) { ... }
// 作为 onSelectHlsProfile 传给 PreviewModal
```

每次 SharePage re-render 都创建新函数引用，导致 PreviewModal 接收到的 `onSelectHlsProfile` prop 变化。

**建议**

```jsx
const switchPreviewHlsProfile = useCallback(async (profileId) => {
  if (!file || !isVideoMime(file.mimeType) || !profileId) return;
  if (previewHlsSource?.profile === profileId) return;
  await previewShared(file, { hlsProfile: profileId });
}, [file, previewHlsSource?.profile]);
```

注意：该函数内部调用了 `previewShared`（闭包捕获），需确认依赖完整性。严重度低，因为 HLS 切换操作不频繁。

---

### N3 — `stopActivePreviewSession` 未 useCallback

**现状**

```jsx
function stopActivePreviewSession() {
  previewSessionIdRef.current += 1;
  if (p2p && previewClientId) {
    p2p.cancelClientChannel(previewClientId, "preview");
  }
  clearPreview();
  setPreviewOpen(false);
}
// 作为 onClose 传给 PreviewModal
```

该函数读取 `p2p` 和 `previewClientId` 状态，每次 re-render 创建新引用。

**建议**

可使用 `useCallback` + ref 模式避免频繁依赖变化：

```jsx
const previewClientIdRef = useRef("");
// 在 setPreviewClientId 时同步更新 ref
const stopActivePreviewSession = useCallback(() => {
  previewSessionIdRef.current += 1;
  // 通过 ref 读取最新值
  ...
}, [p2p]);
```

严重度低，因为 `onClose` 通常只在用户手动关闭时调用一次。

---

## 修改涉及文件清单

| 文件 | 已修改内容 |
|:-----|:-----------|
| `web/src/SharePage.jsx` | P1 串行 effect、P3 roles 参数、P4 canPlay 缓存、P5 HLS 缓存、P6 Blob 超时、P7 useCallback、P9 冻结常量 |
| `web/src/webrtc.js` | P3 `P2PBridgePool` 构造函数 `options.roles` 支持 |
| `web/src/styles.css` | P10 `will-change` + `contain` |
| `server/src/db.js` | P2 新增 `resolveShareAccess()` |
| `server/src/index.js` | P2 `/api/share/:shareId` handler 重写 |
