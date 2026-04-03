# Living Room Focus Model — 遥控器焦点模型细化设计

> 版本：0.1  
> 日期：2026-04-02  
> 适用范围：NAS Bridge 大屏纯享页的浏览层、播放层、抽屉层和弹窗层。

---

## 1. 设计目标

这份文档只解决一件事：让大屏页在“没有触摸屏、只有遥控器或方向键”的条件下仍然稳定可用。

目标如下：

1. 焦点永远可见，用户始终知道当前能操作哪里。
2. 方向键移动规则稳定，不出现“跳错位”“焦点消失”“滚动错乱”。
3. 鼠标和遥控器共存，二者互不破坏。
4. 返回键语义统一，优先关闭当前层，而不是直接退出页面。
5. 数据刷新、列表重排、播放层切换后，焦点尽量恢复到用户刚才停留的位置。

---

## 2. 为什么不能靠浏览器默认焦点

浏览器默认 Tab 焦点链路不适合 10-foot UI，原因很直接：

1. 默认焦点顺序由 DOM 顺序决定，不理解“货架”“播放层”“抽屉”等空间结构。
2. 方向键不会天然做空间导航，尤其在非表单场景里并不稳定。
3. Shelf 横向滚动后，浏览器不会帮你恢复之前的卡片位置。
4. 弹出抽屉和播放层后，默认焦点容易落回背景元素。

结论：大屏页必须维护一套应用级焦点状态，而不是把焦点控制寄托给浏览器。

---

## 3. 焦点模型总览

建议使用三层模型：

```text
Layer  ->  Zone  ->  Item
```

### 3.1 Layer

Layer 表示当前最上层可交互界面。任意时刻只允许最上层 Layer 响应方向键。

建议至少有 4 类 Layer：

1. `browse`：浏览层。
2. `player`：播放层。
3. `drawer`：右侧队列 / 设置 / 详情抽屉。
4. `modal`：确认弹窗、错误弹窗、登录提示。

Layer 用栈管理：

```text
[browse]
[browse, player]
[browse, player, drawer]
[browse, modal]
```

最顶层处理输入，底层冻结但保留状态。

### 3.2 Zone

Zone 是一个可被方向键整体导航的区域，例如：

- `topbar`
- `hero`
- `shelf:recent-video`
- `shelf:resume`
- `player:transport`
- `player:right-drawer`

Zone 之间主要处理上下切换，Zone 内部主要处理左右切换。

### 3.3 Item

Item 是最终可聚焦元素，例如某张媒体卡片、某个播放按钮、某个设置开关。

每个 Zone 内部维护自己的活动索引和活动项 ID。

---

## 4. 建议的数据结构

```ts
type FocusLayerId = "browse" | "player" | "drawer" | "modal";

interface FocusItemMeta {
  id: string;
  index: number;
  disabled?: boolean;
  domId?: string;
}

interface FocusZoneState {
  id: string;
  orientation: "horizontal" | "vertical" | "grid" | "free";
  itemIds: string[];
  activeIndex: number;
  lastActiveItemId: string;
  rememberColumnRatio?: number;
  trapFocus?: boolean;
}

interface FocusLayerState {
  id: FocusLayerId;
  activeZoneId: string;
  zones: Record<string, FocusZoneState>;
  opener?: {
    layerId: FocusLayerId;
    zoneId: string;
    itemId: string;
  };
}

interface FocusStore {
  stack: FocusLayerState[];
  inputMode: "remote" | "mouse";
  lastGlobalFocusId: string;
}
```

重点：

1. `lastActiveItemId` 用于数据刷新后优先按 ID 恢复。
2. `activeIndex` 用于 ID 丢失后的索引兜底。
3. `rememberColumnRatio` 用于上下切换时保留横向位置感。
4. `opener` 用于关闭上层后返回原打开点。

---

## 5. 输入归一化

不同设备给出来的按键字符串不完全一样，第一步应该先统一成应用内部命令。

### 5.1 建议的内部命令集

```ts
type RemoteCommand =
  | "left"
  | "right"
  | "up"
  | "down"
  | "select"
  | "back"
  | "menu"
  | "playPause"
  | "seekForward"
  | "seekBackward"
  | "info";
```

### 5.2 浏览器键值映射

| 原始 key / code | 归一化命令 |
|-----------------|------------|
| `ArrowLeft` | `left` |
| `ArrowRight` | `right` |
| `ArrowUp` | `up` |
| `ArrowDown` | `down` |
| `Enter` / `NumpadEnter` | `select` |
| `Escape` / `Backspace` / `GoBack` | `back` |
| `ContextMenu` / `KeyM` | `menu` |
| `Space` / `MediaPlayPause` | `playPause` |
| `MediaTrackNext` / `KeyL` | `seekForward` |
| `MediaTrackPrevious` / `KeyJ` | `seekBackward` |
| `KeyI` | `info` |

说明：

1. `Backspace` 在部分 TV 浏览器和遥控环境下会被当成返回键。**例外**：若当前焦点所在元素是 `input`、`textarea` 或 `contenteditable`，则不将 `Backspace` 归并为 `back`，保留浏览器退格行为。
2. `GoBack`、`MediaPlayPause` 等值在不同 WebView / 浏览器上不稳定，必须作为兼容分支。
3. 所有被消费的方向键都应 `preventDefault()`，避免浏览器原生滚动抢行为。

---

## 6. 浏览层焦点规则

### 6.1 推荐 Zone 划分

```text
browse
  ├─ topbar              ← 辅助区，非默认入口
  ├─ hero-actions        ← 默认入口 Zone
  ├─ shelf:recent-video
  ├─ shelf:resume
  ├─ shelf:favorites
  └─ shelf:music
```

**浏览层默认入口**：页面加载完成后，初始焦点落在 `hero-actions` 的主 CTA；若 Hero 没有 CTA，则落在 `shelf:recent-video` 的第一张卡片。`topbar` 不参与默认焦点链，只有用户从 Hero 或顶部 Shelf 执行 `up` 操作时才激活。

### 6.2 Zone 内行为

#### 横向 Shelf

- `left` / `right`：在当前行移动到前后卡片。
- 超出边界：不换行，保留在行内边界项。
- 若需要循环：只在设置中可选，不建议默认开启。

#### TopBar（辅助区，非默认焦点链）

- `left` / `right`：在顶栏按钮间移动。
- `down`：进入 Hero 或第一个 Shelf。
- 默认不参与焦点链：仅当用户从 Hero 向上按 `up` 时激活；建议只暴露一个入口（设置或用户头像），减少遥控器遍历成本。

#### Hero

- 若 Hero 只有 1 个主 CTA，`left/right` 可以无操作。
- `down`：进入第一行 Shelf。

### 6.3 Zone 间垂直移动

上下切换不能简单取“下一行同索引”，应保留用户的横向意图。

建议使用列锚点策略：

```ts
columnRatio = activeIndex / max(1, itemCount - 1)
targetIndex = round(columnRatio * max(1, nextZoneItemCount - 1))
```

例子：

1. 用户在 10 张卡片的第 7 张，`columnRatio ≈ 0.67`。
2. 向下移动到只有 4 张卡片的 Shelf。
3. 目标索引取 `round(0.67 * 3) = 2`。

这样比“直接去同索引”更稳，因为不同行长度通常不同。

### 6.4 焦点与滚动同步

当某个卡片获得焦点时，使用**阈值触发式滚动**，而非强制居中：

1. 先不调用 `scrollIntoView`，通过计算卡片与容器可视区边缘的距离来决定是否滚动。
2. 若卡片左侧距容器可视区左边缘不足容器宽度的 20%，则容器向左滚动一个卡片宽度加间距；右侧同理。
3. 卡片完全在可视区内时，**不触发任何滚动**。
4. 只滚动当前 Shelf 容器，不滚整个页面。
5. 若浏览层本身是纵向滚动容器，确保 Zone 切换时只做最小滚动。

参考实现：

```ts
function scrollShelfIfNeeded(container: Element, card: Element, gap = 16) {
  const cRect = container.getBoundingClientRect();
  const kRect = card.getBoundingClientRect();
  const threshold = cRect.width * 0.20;
  if (kRect.left - cRect.left < threshold) {
    container.scrollLeft -= kRect.width + gap;
  } else if (cRect.right - kRect.right < threshold) {
    container.scrollLeft += kRect.width + gap;
  }
}
```

原则：焦点驱动滚动，滚动要克制；每次焦点移动都强制居中会让大屏界面持续跳动，体验极差。

---

## 7. 播放层焦点规则

### 7.1 播放层推荐 Zone 划分

```text
player
  ├─ top-actions
  ├─ transport
  ├─ timeline
  ├─ secondary-actions
  └─ info-rail
```

### 7.2 初始焦点

进入播放层时，初始焦点建议落在 `transport` 的播放/暂停按钮，而不是时间轴。

原因：

1. 播放/暂停是最高频操作。
2. 方向键落在时间轴上时，用户容易误触大量 seek。

### 7.3 控制层自动隐藏

播放层需要“视觉隐藏”和“焦点层隐藏”同时成立。

建议规则：

1. `inputMode === mouse` 时，跟随鼠标移动显示控制层。
2. `inputMode === remote` 时，只要有方向键操作就显示控制层。
3. 若 4 到 6 秒无操作、当前不在抽屉或设置层、**且播放状态为 `playing`**（非 `paused`、`buffering`、`ended`、`error`），则隐藏控制层。暂停、缓冲与错误状态下控制层应保持显示，方便用户读取进度或重试。
4. 控制层隐藏后，保留逻辑焦点在 `transport`，但 DOM 上避免留在不可见按钮上。

可行实现：

- 控制层隐藏时把 `tabIndex` 全部设为 `-1`
- 逻辑状态保留 `lastActiveItemId`
- 用户再按任意方向键时先显示控制层，再恢复上次焦点

### 7.4 时间轴策略

时间轴是最容易被方向键误伤的控件，建议单独处理：

1. `left/right` 在 `transport` 区**移动焦点**（在播放/暂停、上一曲、下一曲、字幕等控件之间切换），**不触发 seek**。
2. 只有当焦点显式进入 `timeline` 后，`left/right` 才改成精细 seek（默认 ±5s，可配置）。
3. 长按 `left/right`，或按遥控器专用媒体键（`seekForward` / `seekBackward`），可在任意焦点位置快速跳转。
4. `up/down` 用于在 `timeline` 和 `transport` / `secondary-actions` 之间切换。

---

## 8. 抽屉与弹窗焦点规则

### 8.1 Drawer

典型 Drawer 包括：

- 播放队列
- 设置
- 媒体详情

规则：

1. 打开 Drawer 时，压栈一个新的 `drawer` Layer。
2. 焦点进入 Drawer 首个可操作项。
3. 背景 `player` Layer 停止处理方向键。
4. 关闭 Drawer 后返回打开它的那个按钮。

### 8.2 Modal

确认框、错误框、登录提示都归入 `modal` Layer。

规则：

1. Modal 是强焦点陷阱层。
2. 未关闭前，`browse`、`player`、`drawer` 一律不接收输入。
3. `back` 等价于取消；没有取消语义时等价于关闭。

---

## 9. 鼠标与遥控器共存

### 9.1 输入模式切换

建议维护 `inputMode`：

- 最近一次来自 `mousemove` -> `mouse`
- 最近一次来自方向键 / 遥控键 -> `remote`

### 9.2 切换规则

1. 切到 `mouse`：显示 hover 态，但不要清空逻辑焦点。
2. 切到 `remote`：恢复上次逻辑焦点，并显示明显 focus ring。
3. 鼠标点击某卡片时，同时更新逻辑焦点到该卡片。

这样可以避免：用户点了一次鼠标后，遥控器再按方向键却从旧位置跳出来。

---

## 10. 焦点恢复策略

### 10.1 数据刷新后恢复

刷新列表时优先按 `itemId` 恢复：

1. 先找 `lastActiveItemId` 是否还存在。
2. 不存在则回退到原 `activeIndex`。
3. 还不合法则夹到边界值。

### 10.2 层切换恢复

规则非常简单：

1. 从 `browse` 打开 `player`：记录 opener。
2. 从 `player` 打开 `drawer`：记录 opener。
3. 关闭上层时，优先回到 opener。
4. opener 消失时，回退到所属 Zone 的最近可用项。

### 10.3 路由或页面重进恢复

如果大屏页采用单页状态而非 URL 路由，也建议把最后浏览位置记到本地：

```ts
living_room_focus_v1:${userId} = {
  layerId: "browse",
  zoneId: "shelf:recent-video",
  itemId: "file:abc123",
  updatedAt: "2026-04-02T12:00:00.000Z"
}
```

这样用户从播放层退出或页面刷新后，能回到更熟悉的位置。

---

## 11. 推荐实现拆分

建议不要把全部焦点逻辑揉在 `LivingRoomPage.jsx` 里，而是拆成几个小层：

```text
web/src/components/living-room/
  focus/
    LivingRoomFocusProvider.jsx
    useInputMode.js
    useFocusLayerStack.js
    useFocusZone.js
    useSpatialNavigation.js
    focusDom.js
```

职责建议：

1. `useInputMode.js`：跟踪最近输入来自鼠标还是遥控器。
2. `useFocusLayerStack.js`：维护 Layer 压栈、出栈和 opener。
3. `useFocusZone.js`：单个 Zone 的 roving tabindex 和活动项管理。
4. `useSpatialNavigation.js`：上下左右命令解析与 Zone 间切换。
5. `focusDom.js`：安全聚焦、滚动同步、不可见项检查。

---

## 12. 事件处理建议

根节点应有统一的输入分发器，不要把方向键逻辑散到每个卡片上。

建议同时接两类输入源：

1. 浏览器原生 `keydown`
2. Android TV 壳注入的 `nas-tv-key` 自定义事件

伪代码：

```ts
function dispatchRemoteCommand(command: RemoteCommand) {
  const activeLayer = focusStore.getTopLayer();
  return dispatchCommandToLayer(activeLayer, command);
}

function handleKeyDown(event: KeyboardEvent) {
  const command = normalizeRemoteCommand(event);
  if (!command) {
    return;
  }

  const consumed = dispatchRemoteCommand(command);
  if (consumed) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function handleTvKeyEvent(event: CustomEvent<{ key: string }>) {
  const command = normalizeInjectedTvCommand(event.detail?.key);
  if (command) {
    dispatchRemoteCommand(command);
  }
}
```

这样做的好处：

1. 行为一致。
2. 容易打日志。
3. 容易做 Android TV 壳层按键桥接。

---

## 13. Back 键语义

Back 键必须全局统一，否则最容易把页面做乱。

建议优先级：

1. 先关 `modal`
2. 再关 `drawer`
3. 再退出 `player`
4. 再关闭 `browse` 中的设置面板或搜索面板
5. 最后才允许页面级返回或退出壳应用

不要在任何子组件里私自“吞掉 Back 却不改状态”，那会让用户觉得遥控器失灵。

---

## 14. 可访问性要求

虽然大屏页不是传统桌面表单，但仍应保持基本语义：

1. 聚焦元素使用真实 `button` 或带 `role="button"` 的元素。
2. 当前焦点态除了视觉边框，也要同步 `aria-selected` 或 `aria-current`。
3. 抽屉和弹窗要有明确 `aria-label`。
4. 隐藏控制层时，不应让不可见按钮继续停留在可访问树主链路里。

---

## 15. 测试矩阵

至少要覆盖以下场景：

### 15.1 浏览层

1. 从 TopBar 进入 Hero，再进入各 Shelf。
2. 每个 Shelf 头尾边界行为正确。
3. 数据刷新后焦点恢复到原卡片。
4. 删除或下线当前聚焦项后，焦点有合理回退。

### 15.2 播放层

1. 打开视频后初始焦点正确。
2. 控制层隐藏后再按方向键可恢复。
3. 打开队列 / 设置抽屉时，背景不抢焦点。
4. `back` 能逐层退出，不会直接跳出整个页面。

### 15.3 鼠标与遥控切换

1. 鼠标点击某卡片后，方向键继续从该卡片出发。
2. 控制层 hover 显示与方向键显示互不冲突。

### 15.4 Android TV 兼容

1. DPAD 方向键、OK、Back、Menu 键均被正确归一化。
2. WebView 注入的 `nas-tv-key` 事件与浏览器原生 `keydown` 行为一致。

---

## 16. 推荐落地顺序

最稳的实现顺序如下：

1. 先做浏览层 Shelf 的 roving tabindex。
2. 再做 Zone 间垂直导航。
3. 再做 Layer 栈和 opener 恢复。
4. 最后接入播放层控制条和 Android TV 键桥接。

先把浏览层做稳，再扩到播放层，风险最低。