# NAS Bridge（公网 Server + 存储机 Client）

这是一个可运行的 MVP，用于在**无公网 IP 的家庭网络**下搭建 NAS 服务。

- `server`：部署在公网服务器，提供用户系统、后台管理、文件索引、WebRTC 信令。
- `storage-client`：部署在存储机，主动注册到 Server、同步本地文件索引、通过 WebRTC DataChannel 向网页端传输文件。
- `web`：工业风双主题前端，支持登录注册、收藏、上传、下载、预览、后台管理。

> 关键目标：大流量文件传输走 P2P，Server 只做控制面，适配 2M 带宽公网机。

## 1. 架构说明

1. 网页用户登录后，从 Server 读取文件索引（文件实际在 Client 存储机）。
2. 用户点击下载/预览/上传时，网页与目标 Client 通过 Server 转发 WebRTC SDP/ICE 信令建立 P2P。
3. 文件数据通过 WebRTC DataChannel 直接传输（不经过 Server 中转）。

## 2. 快速启动

### 2.1 安装依赖

```bash
npm install
```

### 2.2 配置环境变量

- 复制并填写：
  - `server/.env.example` -> `server/.env`
  - `web/.env.example` -> `web/.env`
  - `storage-client/.env.example` -> `storage-client/.env`
- 若本机开发时出现 `ECONNREFUSED ::1:9000`，请在 `web/.env` 设置：
  - `VITE_DEV_PROXY_TARGET=http://127.0.0.1:9000`
- `server` 与 `storage-client` 的注册密钥要一致：
  - `server`: `CLIENT_REGISTRATION_KEY`
  - `storage-client`: `REGISTRATION_KEY`
- `server` 与 `storage-client` 的 `JWT_SECRET` 也必须一致：
  - `server`: 用它签发用户 / client / share token
  - `storage-client`: 用它校验公开分享页的只读访问 token

### 2.3 本地联调

先启动 server：

```bash
npm run dev -w server
```

再启动 web：

```bash
npm run dev -w web
```

最后启动 storage client：

```bash
npm run dev -w storage-client
```

访问：`http://localhost:5173`

### 2.4 一键部署并启动（Windows PowerShell）

在项目根目录执行：

```powershell
./scripts/deploy-and-start.ps1
```

或通过 npm：

```bash
npm run deploy:start
```

启用 TURN 并一起启动：

```powershell
./scripts/deploy-and-start.ps1 -EnableTurn
```

### 2.5 一键部署并启动（Linux Bash）

给脚本执行权限（首次）：

```bash
chmod +x ./scripts/deploy-and-start.sh
```

一键启动：

```bash
./scripts/deploy-and-start.sh
```

启用 TURN 并一起启动：

```bash
./scripts/deploy-and-start.sh --enable-turn
```

也可以用 npm：

```bash
npm run deploy:start:linux
```

停止服务：

```bash
./scripts/stop-services.sh
```

连 TURN 一起停止：

```bash
./scripts/stop-services.sh --with-turn
```

或使用 npm：

```bash
npm run deploy:stop:linux
```

## 3. 生产部署建议

### 公网服务器（Server + Web）

1. 在服务器拉取代码并安装依赖。
2. 执行前端构建：
   ```bash
   npm run build -w web
   ```
3. 启动 `server`（会托管 `web/dist` 静态文件）：
   ```bash
   npm run start -w server
   ```
4. 使用 Nginx/Caddy 做 HTTPS 反代（WebRTC 建议 HTTPS/WSS）。

#### 首屏加载与低带宽部署

- Nginx 的 `gzip on` 默认不足以压缩 JS/CSS。可在本站 HTTPS `server` 块中引入 `deploy/nginx/frontend-assets.conf` 的规则（上游端口按实际配置调整），然后执行 `sudo nginx -t && sudo systemctl reload nginx`。已有同类规则时请合并，避免重复 location。Nginx 1.24 可用 `listen 443 ssl http2;` 开启 HTTP/2。
- 带内容哈希的 `/assets/` 文件缓存一年；HTML 保持重新验证，发布时先上传新资源再替换 HTML，并保留旧哈希资源供已打开的页面使用。
- 前端保留 Rollup 自动分包，避免把全部第三方库塞进一个 `vendor` 包。聊天、预览、播放器和 3D 引擎按需加载；全局背景使用工业场景与轻量 CSS 动效，减少动画偏好会关闭动效。字体使用本机回退，不依赖 Google Fonts。
- 直接由 Node 托管时，`server/src/frontend.js` 也提供静态资源 gzip 和缓存策略，位于 API 路由之后。验证：`node scripts/test-frontend-serving.mjs`。
- 2026-10-14 线上性能优化使用线上最新源码构建；本机其他功能改动未整体覆盖到线上。服务器备份位于 `/home/ubuntu/NasBridge/.deploy-backups/performance-20261014-final/`，含前端归档和此前 Nginx 配置。

### 存储机（Storage Client）

1. 配置 `storage-client/.env`：
   - `SERVER_BASE_URL=https://你的域名`
  - `JWT_SECRET=与 server/.env 完全相同的值`
   - `STORAGE_ROOT=你的存储目录`
    - （可选）AI Bot 可接 OpenAI 兼容代理，包括 `ericc-ch/copilot-api`
      - 启动代理：`npx copilot-api@latest start --port 4141`
      - 在 `storage-client/.env` 里设置：
        - `AI_PROVIDER=copilot`
        - `COPILOT_API_BASE_URL=http://127.0.0.1:4141/v1`
        - `COPILOT_MODEL=你在 /v1/models 里看到的模型 id`
        - `COPILOT_API_KEY=dummy`（如代理未要求真实 token，可直接用默认值）
      - 如果所选模型支持看图，再额外设置 `COPILOT_MULTIMODAL_MODEL`
      - 也支持直接接 OpenAI 兼容的讯飞 Maas：
        - `AI_PROVIDER=xunfei`
        - `XUNFEI_BASE_URL=https://maas-coding-api.cn-huabei-1.xf-yun.com/v2`
        - `XUNFEI_MODEL=astron-code-latest`
        - `XUNFEI_API_KEY=你的讯飞 Maas 密钥`
      - 讯飞 provider 会优先尝试 `/models`；如果接口未提供模型目录，会回退到内置候选模型并显示为 `讯飞Maas`
      - Playwright 现在改为通用配置，bilibili 下载和 AI 联网搜索共用一组变量
        - `PLAYWRIGHT_EXECUTABLE_PATH=`：可选，指定系统 Chrome / Edge 路径
        - `PLAYWRIGHT_HEADLESS=1`：默认无头模式；排查页面时可设为 `0`
        - `PLAYWRIGHT_PROXY=`：可选，给所有 Playwright 场景统一走代理
      - AI 联网搜索默认会优先走结构化 Search API；未配置时会先走 `fetch`，必要时自动回退到 `playwright`
        - 可选配置：
          - `BOT_WEB_SEARCH_PROVIDER=auto`：默认；`builtin` 继续走内置网页搜索，`metaso` 通过 Playwright 模拟秘塔网页搜索
          - `BOT_WEB_SEARCH_BACKEND=auto`：默认；若已配置 Search API，则优先 API，否则先 `fetch`，失败再 `playwright`
          - `BOT_WEB_SEARCH_BACKEND=api`：强制只走结构化搜索 API
          - `BOT_WEB_SEARCH_BACKEND=playwright`：强制浏览器抓取，更兼容搜索引擎页面
          - `BOT_WEB_SEARCH_API_BACKEND=brave`：启用 Brave Search API，返回结构化 JSON 结果，更稳，不依赖搜索结果页面 DOM
          - `BOT_WEB_SEARCH_API_KEY=`：对应 Search API 的密钥
          - `BOT_WEB_SEARCH_API_BASE_URL=`：可选，自定义 API 地址，默认 `https://api.search.brave.com`
          - `BOT_WEB_SEARCH_ENDPOINTS=`：可自定义搜索端点，默认依次尝试 DuckDuckGo HTML 和 Bing
          - 选择 `metaso` 后，搜索阶段会直接打开秘塔首页输入问题，抓取结果页里的 AI 答案摘要；若秘塔触发滑块/拼图验证，则当前查询会失败
      - bilibili 下载相关配置：
        - `BOT_BILIBILI_DOWNLOAD_BACKEND=playwright`
        - `BOT_BILIBILI_IMPORT_DIR=downloads/bilibili`
        - `BOT_BILIBILI_COOKIE_FILE=`：可选，用于会员或受限内容
        - 浏览器优先方案现在会针对 Bing 和 DuckDuckGo 分别使用专门的 DOM 选择器，不再只依赖一套通用抓取规则
  - （可选，建议）启用转码预览：
    - `ENABLE_TRANSCODE=1`
    - `FFMPEG_PATH=ffmpeg`（或 ffmpeg 可执行文件完整路径）
    - `FFPROBE_PATH=ffprobe`（如果 `FFMPEG_PATH` 指向自定义目录，建议显式填写，避免探测时长/视频流失败）
  - `TRANSCODE_VIDEO_CODEC=auto`（默认自动优先尝试 GPU：`h264_nvenc`/`h264_qsv`/`h264_amf`，失败自动回退 `libx264`）
  - `TRANSCODE_PREFER_GPU=1`（设为 `0` 可强制仅 CPU 编码）
  - `ALLOW_GPU_HLS_ENCODING=1`（允许 HLS 链路优先尝试 GPU）
  - `HLS_VIDEO_CODEC=auto`（可单独为 HLS 指定 `h264_nvenc` / `h264_qsv` / `h264_amf` / `libx264`）
  - `HLS_NVENC_PRESET=p2`（NVIDIA HLS 预设，`p1` 更快，`p2` 更稳）
    - `HLS_NVENC_USE_CUDA_PIPELINE=0`（默认关闭，优先兼容的 NVENC 编码路径；设为 `1` 才启用 `cuda decode + scale_cuda` 全 GPU 管线）
  - `DISABLED_ENCODER_COOLDOWN_MS=900000`（GPU 编码器失败后的冷却时间，默认 15 分钟，之后会自动重试）
2. 启动：
   ```bash
   npm run start -w storage-client
   ```
3. 建议使用 PM2 / systemd 保活。

### Storage Client GPU 推荐模板

#### NVIDIA 机器

适合 GeForce / RTX / Quadro，目标是让 HLS 尽量固定走 NVENC：

```env
ENABLE_TRANSCODE=1
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
ALLOW_GPU_HLS_ENCODING=1
HLS_VIDEO_CODEC=h264_nvenc
HLS_NVENC_PRESET=p1
HLS_NVENC_USE_CUDA_PIPELINE=0
TRANSCODE_VIDEO_CODEC=h264_nvenc
TRANSCODE_PREFER_GPU=1
DISABLED_ENCODER_COOLDOWN_MS=300000
```

建议：
- `p1` 最高速，适合 CPU 弱、希望 HLS 更快起播。
- 如果画质或稳定性不理想，改为 `HLS_NVENC_PRESET=p2`。
- 如果确认显卡驱动与 ffmpeg 的 CUDA 解码链路稳定，再尝试 `HLS_NVENC_USE_CUDA_PIPELINE=1`；默认 `0` 更兼容。

#### Intel 核显 / Quick Sync 机器

适合带 QSV 的 Intel iGPU：

```env
ENABLE_TRANSCODE=1
FFMPEG_PATH=ffmpeg
ALLOW_GPU_HLS_ENCODING=1
HLS_VIDEO_CODEC=h264_qsv
TRANSCODE_VIDEO_CODEC=h264_qsv
TRANSCODE_PREFER_GPU=1
DISABLED_ENCODER_COOLDOWN_MS=300000
```

建议：
- 如果 ffmpeg 日志里出现 `MFX_ERR_UNSUPPORTED` 或设备初始化失败，先确认驱动和 ffmpeg 是否带 QSV 支持。

#### AMD 机器

适合带 AMF 的 Windows 主机：

```env
ENABLE_TRANSCODE=1
FFMPEG_PATH=ffmpeg
ALLOW_GPU_HLS_ENCODING=1
HLS_VIDEO_CODEC=h264_amf
TRANSCODE_VIDEO_CODEC=h264_amf
TRANSCODE_PREFER_GPU=1
DISABLED_ENCODER_COOLDOWN_MS=300000
```

建议：
- AMF 在不同驱动版本上的稳定性波动更大，若频繁失败，可先保留 `HLS_VIDEO_CODEC=h264_amf`，但把 `TRANSCODE_VIDEO_CODEC=auto` 交给预览链路自行回退。

### HLS 日志怎么看

storage-client 现在会打印三类更直接的 HLS 日志：

- `[hls-plan]`：开始生成前的计划，包含候选 codec、是否命中 GPU 冷却、当前输入视频信息。
- `[hls-result]`：单次 HLS 最终结果，包含最终选中的 codec、是否走 copy/cache/transcode、总耗时。
- `[hls-build-summary]`：缓存写入完成后的汇总，便于和 `hls-cache`、浏览器请求串起来看。

## 4. 已实现功能对照

- 用户机制：注册、登录、身份令牌、个人收藏。
- 文件能力：浏览、收藏、P2P 下载、P2P 预览、P2P 上传。
- 后台管理：用户列表、存储终端列表、终端启用/禁用。
- Client 管理：主动注册、心跳、文件索引同步。
- 低带宽优化：文件数据不经过 Server，Server 仅承担 API + 信令。

## 5. 重要注意事项（P2P）

- 当前默认使用 STUN（`stun.l.google.com:19302`）。
- 已内置 TURN 配置项：
  - `web/.env`：`VITE_TURN_URL`、`VITE_TURN_USERNAME`、`VITE_TURN_CREDENTIAL`
  - `storage-client/.env`：`TURN_URL`、`TURN_USERNAME`、`TURN_CREDENTIAL`
- 项目已提供 coturn compose 文件：`deploy/turn/docker-compose.yml`
- 首次启用 TURN：
  1. 复制 `deploy/turn/.env.example` 为 `deploy/turn/.env`
  2. 设置 `TURN_EXTERNAL_IP=你的公网服务器IP`
  3. 执行 `./scripts/deploy-and-start.ps1 -EnableTurn`
- Web 与 Client 的 TURN 用户名密码需要与 `deploy/turn/.env` 中一致。
- 若浏览器不支持某些视频编码（常见 `.MOV` / `video/quicktime`），可由 `storage-client` 使用 ffmpeg 动态转码为 `mp4` 后预览。
- 转码依赖 ffmpeg，请先在存储机安装并确保命令可执行。
- 对于超大文件，可继续扩展为分片断点续传、并行 DataChannel、多连接限速等能力。

## 5.1 TV 直播与番剧源（自动更新）

- TV 默认显示「社区精选（自动更新）」：Server 每 6 小时拉取 vbskycn/iptv、Guovin/iptv-api、fanmingming/live、iptv-org 的公开直播源，逐条检测可用性，把同名频道合并成多条线路后缓存到 `server/data/tv-feeds.json`。播放失败会自动换下一条线路。
  - `TV_FEED_URLS=名称|https://a.m3u,名称2|https://b.txt`：用自己的订阅替换默认列表
  - `TV_FEED_REFRESH_HOURS=6`：重新检测间隔
  - 管理员可 `POST /api/tv/builtin/refresh` 立即刷新；`GET /api/tv/builtin/status` 查看各订阅状态
- 番剧站点来自 animeko 社区订阅（`https://sub.creamycake.org/v1/css1.json`），每小时刷新，最后一次成功的结果存于 `server/data/anime-subscription.json`。`ANIME_SUBSCRIPTION_URLS` 可追加或替换订阅（逗号分隔，animeko 导出格式）。
- 搜索结果会逐条检测线路：失效线路在选择器里显示删除线；支持跨域的线路由浏览器直连 CDN，不占公网 Server 带宽，其余经 Server 中转（附带 Referer）。播放失败自动切换到下一条可用线路，HLS 中插入的广告片段会被过滤。
- `http://` 直播线路在 HTTPS 页面里只能经 Server 中转，会占用公网带宽。

## 6. 目录结构

```text
server/
  src/
web/
  src/
storage-client/
  src/
```

## 7. 默认管理员

`server` 启动时会根据环境变量自动初始化管理员：

- `ADMIN_INIT_EMAIL`
- `ADMIN_INIT_PASSWORD`

请在生产环境务必修改默认密码。

## 8. 前端主题与美术资源

三个入口共用 `web/src/ui/ThemeProvider.jsx`，主题保存在 `nas_ui_theme`，支持跨标签页同步。新界面使用 `industrial.css` 的语义颜色；旧样式处于 `legacy` 层。视频播放画面保持深色，文字与按钮需要在两种主题下分别检查。

九类原创美术通过内置 image_gen 生成，已压缩为 `web/src/assets/*.webp`；完整提示词与媒体设备背景编辑的结果说明位于 `web/src/assets/imagegen-prompts.json`。场景与设备分别用于登录、概览、终端、传输、归档、分享、协作及媒体模块。真实文件缩略图优先于装饰图，状态文字来自业务数据。动效遵循 `prefers-reduced-motion`。

`node scripts/capture-ui.mjs` 使用模拟 API 检查深浅主题、桌面及手机页面和弹窗，同时检查横向溢出、脚本错误与通知遮挡。`node scripts/verify-ui-live.mjs` 检查线上登录加载速度、资源缓存、主题持久化和动效偏好。这些页面检查不替代真实文件传输与媒体播放验收。 本地复查先运行 `npm run build`，再在单独终端启动 `node scripts/ui-preview.mjs`。Windows 默认使用 Edge；其他平台先运行 `npx playwright install chromium`。诊断截图和发布归档写入已忽略的 `local/`，不提交运行数据或环境文件。发布时以线上最新源码为基线，并核对源码校验和，保留并行开发功能及旧哈希资源。

## 网页同步组与文件副本

管理员在「终端管理 → 同步组」关联 2–8 个已升级终端及各自子目录，即自动双向同步新增、修改和删除；可以立即触发、移除成员或解散同步组。协调端需要在线，默认每 60 秒检查一次。取消关联保留文件；在线通知撤销，断线授权最多 30 秒后失效。

所有参与端配置 `CONTENT_HASH_ENABLED=1`、`SYNC_MODE=web-groups`；Windows 旧安装可使用 `scripts/windows-sync-upgrade/Check.cmd` 与 `Update.cmd`，无需 Git，更新前停止客户端。新安装直接使用当前源码和示例配置。

首次关联或改变组成员/目录后合并现有内容，不追溯断开期间删除。文件 SHA256 校验、并发修改检查和冲突副本保护内容；历史版本与删除回收位于存储根目录 `.nas-bot/peer-sync-v2/{versions,trash}`，JSON 中记录原路径。每个目录最多 10000 文件，当前不复制空目录、不提供块级差分或断点续传。禁止重叠同步范围与符号链接。WebRTC 支持直连及已配置的 TURN；主文件列表按内容哈希合并同目录副本，预览/下载使用节点测速选择。

验证（Node.js 24）：
```sh
node --test --test-force-exit storage-client/test/bidirectionalSync.test.js storage-client/test/syncGroups.test.js storage-client/test/peerSync.test.js storage-client/test/contentHash.test.js server/test/syncGroups.test.js web/test/replicas.test.js
node --test test/windows-sync-upgrade.test.cjs
npm run build -w web
```
Windows 原生 wrtc 在自然退出阶段可能崩溃，测试用 `--test-force-exit` 在断言完成后退出。更新器测试使用 Git 中的原始安装快照，需保留完整仓库历史。
