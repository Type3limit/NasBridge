# AI 星图执行可视化 — 规划文档

> 目标：用科幻风格的「星图」替换 bot-status 卡片中那句呆板的 "AI 正在处理这条消息"，实时显示 LangGraph 各节点的执行状态，正在执行的节点有持续扩散渐隐的涟漪动效。

---

## 1. 现状分析

### 1.1 数据链路（从图节点到 UI）

```
aiChatGraph.js
  createTrackedNode
    → hooks.recordNodeEvent({ node, event: "enter"/"exit", status })  ←── 只写磁盘 trace 文件，UI 看不到
    → hooks.captureState(...)                                          ←── 也是 checkpointer 快照
  handler(state)
    → api.emitProgress({ phase, label, percent, details })             ←── 这条链路才到 UI

runtime.js emitProgress
  → store.save(job)
  → events.emit("job", next)

storage-client/src/index.js publishBotJobStatusMessage(job)
  → buildBotJobCard(job)
    → body = formatBotProgressDetails(job)   ←── 只处理 web-search 类型，其余就是纯文字 label
  → WS broadcast → ChatRoom.jsx

ChatRoom.jsx renderMessageCardBody
  → isAiChatStatusCard → getAiChatStatusBody()   ←── 固定文本 "AI 正在处理这条消息"
```

**核心缺口**：`recordNodeEvent` 只写日志文件，从未反馈到 `emitProgress`，因此 UI 对节点状态一无所知。

### 1.2 现有图节点（12 个）

```
START
  └─ prepareInput ──┬─ command ────────────────────────────── END
                    ├─ delegateResolve → delegateExecute ──── END
                    ├─ recovery ──────────────────────────── END
                    └─ prepareContext ──┬─ visionCollect → visionBuild → visionAnswer ── END
                                       ├─ textPlan ──┬─ textAnswer ── END
                                       │             └─ textTools ──→ textPlan (循环)
                                       └─ textTools (直接进入)
```

路由 `route` 字段决定 prepareInput / prepareContext 之后走哪条分支：
`command` / `delegate` / `recovery` / `vision` / `text` / `textTools`

---

## 2. 目标效果

```
┌─────────────────────────── bot-status 卡片 ───────────────────────────────┐
│  ● [机器人名]                                              已耗时 12s      │
│  ┌──────────────────────── 星图区域 ────────────────────────────────────┐  │
│  │           ○ prepareInput ──●══ prepareContext ──◉ textPlan          │  │
│  │                                                  ╰──────▷ textTools │  │
│  │    [正在执行节点] 外圈有 2-3 个同心圆涟漪动画   ▷ textAnswer         │  │
│  │    已完成节点：实心亮点                                               │  │
│  │    未到达节点：暗点                                                   │  │
│  └───────────────────────────────────────────────────────────────────── ┘  │
│  当前：textPlan · 规划策略 · tool round 2                    [停止生成]     │
└────────────────────────────────────────────────────────────────────────────┘
```

**视觉语言**：
- 背景：深色半透明蒙层（与卡片 backdrop-filter 融合）
- 节点：SVG `<circle>`，三种状态 — 暗点 / 实心亮点 / 活跃涟漪
- 涟漪：CSS `@keyframes` 扩散 + 渐隐，重复，科幻感
- 边：细线，已经过的路径高亮
- 字体：`Caption1`，monospace 或小字号

---

## 3. 已知类似实现

| 产品 / 技术 | 相关性 | 关键技术 |
|:---------|:------|:--------|
| **LangGraph Studio**（Langchain 官方） | 直接同类：可视化 LangGraph 图，节点高亮 active 状态 | React Flow + ELK layout |
| **Temporal.io Workflow UI** | 展示 workflow execution，步骤状态 | SVG + D3 |
| **AWS Step Functions** 控制台 | 状态机可视化，当前执行节点高亮 | SVG + CSS transition |
| **Mastra.ai Agent Playground** | Agent 执行步骤时间线，类似 Thinking 可视化 | React + CSS animation |
| CSS "sonar/radar ping" 动效 | `@keyframes` 扩散+渐隐是成熟 pattern，Tailwind `animate-ping` 就是这个 | 纯 CSS，零依赖 |
| **Framer Motion** `layoutId` 动画 | 节点状态切换时平滑过渡 | framer-motion（可选） |

**结论**：核心动效（涟漪 ping）是零依赖纯 CSS。布局选择**手写固定坐标 SVG**，而非引入 react-flow/D3（避免打包体积），因为图拓扑是静态已知的。

---

## 4. 实现方案

### 4.1 整体分层

```
Layer 1 — 数据后端（storage-client）
  ├─ 在 createTrackedNode 的 recordNodeEvent 回调中额外调用 api.emitProgress
  └─ 在 progress.graphState 中携带 { activeNode, route, nodeHistory }

Layer 2 — 数据转换（index.js buildBotJobCard）
  └─ 把 job.progress.graphState 透传到 card 的新字段 card.graphState

Layer 3 — UI 渲染（ChatRoom.jsx + 新组件 AiStarMapCard）
  ├─ renderMessageCardBody 检测 card.graphState，渲染星图组件
  └─ AiStarMapCard: 纯 SVG + CSS keyframes，零额外依赖
```

### 4.2 数据结构设计

#### `progress.graphState`（随每次 emitProgress 更新）

```js
{
  activeNode: "textPlan",          // 当前正在执行的节点 id
  route: "text",                   // 当前路由分支
  nodeHistory: [                   // 已执行过的节点序列（按时间正序）
    { node: "prepareInput",   status: "completed", at: "2026-04-07T10:00:01Z" },
    { node: "prepareContext", status: "completed", at: "2026-04-07T10:00:03Z" },
    { node: "textPlan",       status: "running",   at: "2026-04-07T10:00:05Z" }
  ],
  toolRound: 2                    // textTools → textPlan 循环次数，用于显示
}
```

#### `card.graphState`（buildBotJobCard 透传）

```js
card: {
  type: "bot-status",
  status: "running",
  title: "AI Chat",
  subtitle: "规划策略",
  graphState: { /* 同上 */ },
  // body 字段保留降级文本（无 graphState 时使用）
  body: "textTools → search_web → ...",
  actions: [...]
}
```

### 4.3 静态图拓扑（前端常量）

```js
// AiStarMapCard.jsx 内部常量
const GRAPH_NODES = [
  { id: "prepareInput",    label: "解析输入",   x: 60,  y: 120 },
  { id: "prepareContext",  label: "准备上下文", x: 180, y: 120 },
  { id: "command",         label: "指令处理",   x: 180, y: 40  },
  { id: "recovery",        label: "会话恢复",   x: 180, y: 200 },
  { id: "delegateResolve", label: "委托解析",   x: 300, y: 60  },
  { id: "delegateExecute", label: "委托执行",   x: 420, y: 60  },
  { id: "visionCollect",   label: "图片采集",   x: 300, y: 160 },
  { id: "visionBuild",     label: "多模态构建", x: 420, y: 160 },
  { id: "visionAnswer",    label: "视觉回答",   x: 540, y: 160 },
  { id: "textPlan",        label: "规划策略",   x: 300, y: 240 },
  { id: "textTools",       label: "工具调用",   x: 420, y: 280 },
  { id: "textAnswer",      label: "生成回复",   x: 540, y: 240 }
];

const GRAPH_EDGES = [
  ["prepareInput", "prepareContext"],
  ["prepareInput", "command"],
  ["prepareInput", "recovery"],
  ["prepareInput", "delegateResolve"],
  ["delegateResolve", "delegateExecute"],
  ["prepareContext", "visionCollect"],
  ["visionCollect", "visionBuild"],
  ["visionBuild", "visionAnswer"],
  ["prepareContext", "textPlan"],
  ["textPlan", "textTools"],
  ["textTools", "textPlan"],   // back-edge，用虚线或弧线表示循环
  ["textPlan", "textAnswer"]
];
```

### 4.4 CSS 动效设计

```css
/* 涟漪 ping —— 活跃节点外圈 */
@keyframes starPing {
  0%   { r: 8px;  opacity: 0.8; }
  80%  { r: 20px; opacity: 0.1; }
  100% { r: 8px;  opacity: 0;   }
}

.starNodePulse {
  animation: starPing 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  fill: none;
  stroke: var(--colorBrandForeground1);
  stroke-width: 1.5px;
}

/* 第二圈，延迟 0.5s，制造多层扩散 */
.starNodePulse2 {
  animation: starPing 1.6s cubic-bezier(0.4, 0, 0.6, 1) 0.5s infinite;
}

/* 已完成节点 */
.starNodeDone {
  fill: var(--colorBrandBackground2);
  filter: drop-shadow(0 0 4px var(--colorBrandForeground1));
}

/* 活跃节点中心点 */
.starNodeActive {
  fill: var(--colorBrandForeground1);
  filter: drop-shadow(0 0 6px var(--colorBrandForeground1));
}

/* 未到达节点 */
.starNodePending {
  fill: var(--colorNeutralForeground4);
  opacity: 0.3;
}

/* 路径边 */
.starEdgeActive {
  stroke: var(--colorBrandForeground1);
  stroke-opacity: 0.6;
}
.starEdgePending {
  stroke: var(--colorNeutralStroke2);
  stroke-opacity: 0.2;
  stroke-dasharray: 3 4;
}

/* 背景 */
.aiStarMapContainer {
  background: radial-gradient(ellipse at 30% 50%, rgba(37, 99, 235, 0.08), transparent 60%),
              rgba(0, 0, 0, 0.15);
  border-radius: 8px;
  padding: 12px 8px;
}
```

### 4.5 组件结构

```jsx
// web/src/components/AiStarMapCard.jsx（新建文件）

function getNodeStatus(nodeId, graphState) {
  if (graphState.activeNode === nodeId) return "active";
  const inHistory = graphState.nodeHistory?.find(h => h.node === nodeId);
  if (inHistory?.status === "completed") return "done";
  if (inHistory?.status === "failed") return "failed";
  return "pending";
}

function isEdgeActive(from, to, graphState) {
  const history = graphState.nodeHistory || [];
  const fromIdx = history.findLastIndex(h => h.node === from);
  const toIdx = history.findLastIndex(h => h.node === to);
  return fromIdx >= 0 && toIdx >= 0 && toIdx > fromIdx;
}

export function AiStarMapCard({ graphState, elapsedText }) {
  // 只渲染与当前 route 相关的节点子集
  const routeNodes = getRouteNodes(graphState.route);

  return (
    <div className="aiStarMapContainer">
      <svg viewBox="0 0 600 320" width="100%" height="auto">
        {/* 边 */}
        {GRAPH_EDGES
          .filter(([f, t]) => routeNodes.has(f) || routeNodes.has(t))
          .map(([from, to]) => <StarEdge key={`${from}-${to}`} from={from} to={to} active={isEdgeActive(from, to, graphState)} />)}

        {/* 节点 */}
        {GRAPH_NODES
          .filter(n => routeNodes.has(n.id))
          .map(node => {
            const status = getNodeStatus(node.id, graphState);
            return <StarNode key={node.id} node={node} status={status} />;
          })}
      </svg>

      {/* 底部状态行 */}
      <div className="starMapStatusRow">
        <Caption1 className="starMapActiveLabel">
          {graphState.activeNode ? getLabelForNode(graphState.activeNode) : ""}
          {graphState.toolRound > 0 ? ` · 工具轮次 ${graphState.toolRound}` : ""}
        </Caption1>
        <Caption1>{elapsedText}</Caption1>
      </div>
    </div>
  );
}
```

---

## 5. 修改清单（按层级）

### Layer 1 — `storage-client/src/bot/langgraph/aiChatGraph.js`

**改动**：在 `createTrackedNode` 内 `hooks.recordNodeEvent(enter)` 调用后，也触发一次 `api.emitProgress`。

```js
// createTrackedNode 内 enter 阶段
await hooks?.recordNodeEvent?.({ node: nodeName, event: "enter", route: state?.route, status: "running" });

// 新增：更新 graphState
if (typeof state?.api?.emitProgress === "function") {
  await state.api.emitProgress({
    phase: state.phase || "running",
    label: String(state?.progress?.label || nodeName),
    percent: state?.progress?.percent,
    graphState: {
      activeNode: nodeName,
      route: state?.route,
      nodeHistory: [...(state?.trace || [])],   // trace 已累积了前面各节点
      toolRound: Number.isInteger(state?.toolRound) ? state.toolRound : 0
    }
  });
}
```

**注意**：`emitProgress` 调用本身是 fire-and-forget（`await` 但不 throw），需要包在 `try/catch` 里。

### Layer 2 — `storage-client/src/index.js`

**改动**：`buildBotJobCard` 在 running/queued 状态时把 `graphState` 转入 card。

```js
// buildBotJobCard 的 running 分支
const graphState = job?.progress?.graphState && typeof job.progress.graphState === "object"
  ? job.progress.graphState
  : null;

return {
  type: "bot-status",
  status: String(job?.status || "running"),
  title: botDisplayName,
  subtitle: String(job?.progress?.label || job?.phase || "处理中").trim(),
  body: formatBotProgressDetails(job),   // 降级文本保留
  graphState,                            // 新字段
  progress: percent,
  actions: [...]
};
```

**`getBotJobStatusSignature` 也要更新**，把 `graphState.activeNode` 纳入签名，避免节点切换时因签名不变而跳过 WS 广播。

### Layer 3 — `web/src/components/AiStarMapCard.jsx`（新建）

新建文件，见 4.5 节组件结构。约 150 行（含 SVG 坐标常量）。

### Layer 4 — `web/src/components/ChatRoom.jsx`

**改动**：在 `renderMessageCardBody` 中，当 `isAiChatStatusCard && message.card.graphState` 时渲染 `AiStarMapCard`：

```jsx
// renderMessageCardBody 内，替换 getAiChatStatusBody 那段
const cardBodyContent = isAiChatStatusCard && message.card.graphState
  ? <AiStarMapCard graphState={message.card.graphState} elapsedText={elapsedText} />
  : <MarkdownBlock className="chatMarkdownBlock chatDynamicMarkdown" text={cardBody} />;
```

### Layer 5 — `web/src/styles.css`

新增 `AiStarMapCard` 相关样式（约 60 行）：`.aiStarMapContainer`、`.starMapStatusRow`、`@keyframes starPing`、`.starNodePulse`、`.starNodeActive`、`.starNodeDone`、`.starNodePending`、`.starEdgeActive`、`.starEdgePending`。

---

## 6. 路由子集过滤

不同 route 下只需显示相关节点，避免星图显示 12 个全量节点导致拥挤：

| route | 显示节点 |
|:------|:--------|
| `text` | prepareInput → prepareContext → textPlan ⇄ textTools → textAnswer |
| `vision` | prepareInput → prepareContext → visionCollect → visionBuild → visionAnswer |
| `command` | prepareInput → command |
| `recovery` | prepareInput → recovery |
| `delegate` | prepareInput → delegateResolve → delegateExecute |

route 未知时显示 text 子集（最常见情形）。

---

## 7. 降级策略

- 若 `card.graphState` 不存在（旧消息、非 ai.chat bot），继续显示原有 Markdown body
- 若节点坐标未匹配（未来新增节点），只渲染已知节点、忽略未知 id，不崩溃
- 星图渲染失败（SVG 不支持等）用 `ErrorBoundary` 包裹，降级到文字显示

---

## 8. 执行阶段规划

```
Phase 1 — 数据管道（后端，约 2h）
  1. aiChatGraph.js createTrackedNode：enter 阶段调用 emitProgress 携带 graphState
  2. index.js buildBotJobCard：透传 graphState；更新 getBotJobStatusSignature 签名
  3. 用 scripts/ai-chat-integration.mjs 验证节点事件确实到达前端（console.log card）

Phase 2 — 组件骨架（前端，约 2h）
  1. 新建 AiStarMapCard.jsx（静态坐标 + 只读 graphState，无动画）
  2. 在 ChatRoom.jsx renderMessageCardBody 中接入
  3. 确认各 route 下节点子集正确过滤

Phase 3 — CSS 动效 + 航行探针（约 2~2.5h）
  1. styles.css 加入 @keyframes starPing（节点涟漪）
  2. 活跃节点 2-3 层同心涟漪，错开 delay
  3. 边的渐亮动效，completed 节点的 drop-shadow glow
  4. 探针 rAF 主循环（useRef 直接操作 SVG DOM，不经 React state，见第 10 节）
  5. @keyframes probeFlow（虚线数据流）+ .starProbeTip glow
  6. @keyframes landBurst + reflow trick 触发着陆波
  7. 可选：pickFreeAngle 初始角度优化

Phase 4 — polish（约 1h）
  1. 工具循环轮次显示（toolRound badge）
  2. 节点标签 tooltip 或 legend
  3. 深色/浅色主题适配（使用 FluentUI token 颜色变量）
  4. 移动端：SVG viewBox 自适应，星图缩小但保留动效
```

---

## 9. 风险与注意事项

| 风险 | 缓解措施 |
|:-----|:--------|
| `emitProgress` 在 enter 阶段频繁调用，增加 WS 广播压力 | `getBotJobStatusSignature` 已有去重，`activeNode` 纳入签名后只有节点跳转才广播 |
| `state.trace` 在 enter 阶段是前一节点完成后的快照，结构已稳定 | 是，无需额外改动 |
| 新增 `graphState` 字段导致旧版前端出现未知字段 | 纯新增字段，旧前端忽略，向前兼容 |
| SVG 手写坐标后续新增节点需要同步更新 | 坐标定义集中在 `AiStarMapCard.jsx` 顶部常量，维护成本低 |
| animation 在低性能设备上消耗 GPU | CSS `will-change: transform` + `contain: strict` 限制 repaint 到 SVG 内部；可选通过 `prefers-reduced-motion` 降级为静态高亮 |
| 探针方向随机游走穿越其他节点 | maxLength=45px 远小于节点间距（≥120px），概率极低；可选 `pickFreeAngle` 在初始化时规避（见 10.5 节）|

---

## 10. 航行探针动效（Warp Probe Line）

> 视觉隐喻：飞船离开上一个星球后，在深空中以随机偏航角巡航——光迹不断延伸但长度有限，方向随惯性缓慢漂移；一旦下一个节点激活，探针迅速收缩，目标节点爆发一圈「着陆波」。

### 10.1 视觉概念分解

```
节点激活后：
  ① 从 activeNode 中心向随机方向伸出发光线段（「探针」）
  ② 线段边生长（0 → maxLength ≈ 45px）边缓慢漂移方向（Brownian drift）
  ③ 达到 maxLength 后探针维持长度，继续漂移，前端加「数据流」虚线动效
  ④ 同时所有已完成的节点、已激活的连线保持完整可见

下一节点激活时：
  ⑤ 探针迅速向原点收缩（~150ms，length → 0）
  ⑥ 目标节点处爆发一个「着陆波」扩散圆（r: 8→28, opacity: 0.9→0，一次性 keyframe）
  ⑦ 目标节点同时触发常规涟漪动效成为新的 active 节点
```

### 10.2 参数设计

| 参数 | 值 | 说明 |
|:----|:--|:----|
| `MAX_PROBE_LENGTH` | 45px | 在 600×320 viewBox 中约占宽度 7.5%，不干扰其他节点 |
| 生长速度 | 2px/frame | ≈ 0.37s 从 0 到满长（@60fps） |
| 收缩速度 | 5px/frame | ≈ 0.15s 着陆收缩 |
| 角速度极限 | ±0.05 rad/frame | ≈ ±3°/frame，弧度平滑 |
| 角加速度噪声 | ±0.008 rad/frame² | Brownian 扰动强度 |
| 虚线规格 | `4 3` stroke-dasharray | 配合 dashoffset 动画产生"流动"感 |
| 探针线宽 | 1.5px | 细而精准 |
| 尖端光点半径 | 2px | 带 glow drop-shadow |
| 着陆波半径范围 | r: 8 → 28px | 0.5s 内扩散淡出 |

### 10.3 技术实现路线

**核心原则：rAF loop 完全绕过 React reconciliation**

每帧只操作 SVG DOM attribute（`setAttribute`），不调用 `setState`，不触发 re-render。React 只负责挂载 SVG 骨架，以及响应 `activeNode` prop 变化时重置探针初始状态。

```jsx
// AiStarMapCard.jsx 内部

const probeLineRef   = useRef(null);  // <line> 探针主线
const probeTipRef    = useRef(null);  // <circle> 探针尖端光点
const probeLandRef   = useRef(null);  // <circle> 着陆波（一次性）
const probeGradRef   = useRef(null);  // <linearGradient> x1/y1/x2/y2 需每帧更新
const probeAnimState = useRef(null);  // 动画状态，不经过 state/re-render

const MAX_PROBE_LENGTH = 45;

// activeNode 变化时重置探针（着陆 → 收缩 → 新探针出发）
useEffect(() => {
  const node = GRAPH_NODES.find(n => n.id === activeNode);
  if (!node) return;

  const prev = probeAnimState.current;
  // 若前一探针尚有长度，触发着陆收缩
  if (prev && prev.length > 0) {
    prev.landing = true;
    prev.landTarget = { x: node.x, y: node.y };
  }

  // 新探针状态（切换后立即开始，在 rAF tick 中生效）
  probeAnimState.current = {
    originX: node.x,
    originY: node.y,
    angle: Math.random() * Math.PI * 2,
    angularVelocity: (Math.random() - 0.5) * 0.04,
    length: 0,
    landing: false
  };
}, [activeNode]);

// rAF 主循环（只挂载一次，组件卸载时取消）
useEffect(() => {
  let rafId;

  function tick() {
    const s = probeAnimState.current;
    if (!s) { rafId = requestAnimationFrame(tick); return; }

    // ── 角度漂移（带惯性的 Brownian motion）──────────────────
    s.angularVelocity += (Math.random() - 0.5) * 0.008;
    s.angularVelocity = Math.max(-0.05, Math.min(0.05, s.angularVelocity));
    s.angle += s.angularVelocity;

    // ── 长度更新 ──────────────────────────────────────────────
    if (s.landing) {
      s.length = Math.max(0, s.length - 5);        // 着陆：快速收缩
    } else if (s.length < MAX_PROBE_LENGTH) {
      s.length = Math.min(MAX_PROBE_LENGTH, s.length + 2);  // 生长
    }

    // ── 计算尖端坐标 ──────────────────────────────────────────
    const tipX = s.originX + Math.cos(s.angle) * s.length;
    const tipY = s.originY + Math.sin(s.angle) * s.length;

    // ── 直接操作 SVG DOM（无 React re-render）────────────────
    if (probeLineRef.current) {
      probeLineRef.current.setAttribute('x1', s.originX);
      probeLineRef.current.setAttribute('y1', s.originY);
      probeLineRef.current.setAttribute('x2', tipX);
      probeLineRef.current.setAttribute('y2', tipY);
      probeLineRef.current.setAttribute('opacity', s.length > 1 ? 1 : 0);
    }
    if (probeTipRef.current) {
      probeTipRef.current.setAttribute('cx', tipX);
      probeTipRef.current.setAttribute('cy', tipY);
      probeTipRef.current.setAttribute('opacity', s.length > 4 ? 1 : 0);
    }
    // 渐变端点随探针方向同步（gradientUnits="userSpaceOnUse"）
    if (probeGradRef.current) {
      probeGradRef.current.setAttribute('x1', s.originX);
      probeGradRef.current.setAttribute('y1', s.originY);
      probeGradRef.current.setAttribute('x2', tipX);
      probeGradRef.current.setAttribute('y2', tipY);
    }

    // ── 着陆波触发 ────────────────────────────────────────────
    if (s.landing && s.length === 0 && probeLandRef.current) {
      probeLandRef.current.setAttribute('cx', s.landTarget.x);
      probeLandRef.current.setAttribute('cy', s.landTarget.y);
      probeLandRef.current.classList.remove('starLandBurst');
      void probeLandRef.current.offsetWidth;  // reflow trick：强制重启 animation
      probeLandRef.current.classList.add('starLandBurst');
      s.landing = false;
    }

    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(rafId);
}, []); // 空依赖：只挂载一次，状态全走 ref
```

**SVG 骨架（插入到 `<svg>` 内，其他节点和连线之上）：**

```jsx
<defs>
  {/* 探针渐变：起点亮 → 尖端透明，方向每帧动态更新 */}
  <linearGradient
    ref={probeGradRef}
    id="probeGrad"
    gradientUnits="userSpaceOnUse"
  >
    <stop offset="0%"   stopColor="#60a5fa" stopOpacity="0.9" />
    <stop offset="60%"  stopColor="#60a5fa" stopOpacity="0.5" />
    <stop offset="100%" stopColor="#60a5fa" stopOpacity="0"   />
  </linearGradient>
</defs>

{/* 探针主线（初始隐藏，rAF 驱动） */}
<line
  ref={probeLineRef}
  x1="0" y1="0" x2="0" y2="0"
  stroke="url(#probeGrad)"
  strokeWidth="1.5"
  strokeDasharray="4 3"
  className="starProbeFlow"
  opacity="0"
/>

{/* 探针尖端光点 */}
<circle
  ref={probeTipRef}
  cx="0" cy="0" r="2"
  className="starProbeTip"
  opacity="0"
/>

{/* 着陆波（一次性 CSS animation，由 JS 切换 class 触发） */}
<circle
  ref={probeLandRef}
  cx="0" cy="0" r="8"
  className="starLandCircle"
  fill="none"
/>
```

### 10.4 CSS 新增样式

```css
/* 探针虚线流动（dashoffset 持续偏移，产生"数据流"感） */
@keyframes probeFlow {
  from { stroke-dashoffset: 14; }
  to   { stroke-dashoffset: 0;  }
}
.starProbeFlow {
  animation: probeFlow 0.3s linear infinite;
  stroke-linecap: round;
}

/* 探针尖端：持续 glow */
.starProbeTip {
  fill: #93c5fd;
  filter: drop-shadow(0 0 5px #60a5fa) drop-shadow(0 0 2px #fff);
}

/* 着陆波：class 切换触发一次性扩散 */
@keyframes landBurst {
  0%   { r: 8;  opacity: 0.9; stroke-width: 2;   }
  60%  { r: 20; opacity: 0.4; stroke-width: 1;   }
  100% { r: 28; opacity: 0;   stroke-width: 0.5; }
}
.starLandCircle {
  stroke: #93c5fd;
  opacity: 0;
}
.starLandCircle.starLandBurst {
  animation: landBurst 0.5s cubic-bezier(0.2, 0.8, 0.4, 1) forwards;
}
```

### 10.5 节点遮挡防护（可选）

探针最大长度 45px 远小于节点间最短距离（≈120px），穿越其他节点概率极低。若追求完美，可在角度初始化时选取远离已渲染节点的方向：

```js
function pickFreeAngle(originX, originY, occupiedNodes) {
  const candidates = Array.from({ length: 8 }, (_, i) => (Math.PI * 2 / 8) * i);
  return candidates.reduce((best, angle) => {
    const tx = originX + Math.cos(angle) * MAX_PROBE_LENGTH;
    const ty = originY + Math.sin(angle) * MAX_PROBE_LENGTH;
    const minDist = Math.min(...occupiedNodes.map(n =>
      Math.hypot(n.x - tx, n.y - ty)
    ));
    return minDist > best.minDist ? { angle, minDist } : best;
  }, { angle: Math.random() * Math.PI * 2, minDist: 0 }).angle;
}
```

### 10.6 复杂度评估

| 子任务 | 代码量 | 技术风险 |
|:------|:------|:-------|
| rAF 主循环骨架 + 清理 | ~30 行 | 低（标准 pattern）|
| 角度漂移算法（Brownian in angle space） | ~8 行 | 低 |
| SVG `gradientUnits="userSpaceOnUse"` 动态追踪 | ~10 行 | **中**（坐标系 + `id` 唯一性需注意）|
| CSS 虚线流动 `probeFlow` keyframe | ~6 行 | 低 |
| 着陆收缩 + `landBurst` CSS 触发 | ~15 行 | 低（reflow trick 固定写法）|
| `pickFreeAngle` 节点遮挡检测（可选）| ~12 行 | 低 |
| SVG 骨架声明 | ~20 行 | 低 |
| **合计** | **~80 行 JS + 25 行 CSS** | **关键点：渐变追踪 + reflow trick** |

**预计额外工作量：1~1.5h（建议纳入 Phase 3 一并完成）。**
