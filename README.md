# NAS Bridge（公网 Server + 存储机 Client）

这是一个可运行的 MVP，用于在**无公网 IP 的家庭网络**下搭建 NAS 服务。

- `server`：部署在公网服务器，提供用户系统、后台管理、文件索引、WebRTC 信令。
- `storage-client`：部署在存储机，主动注册到 Server、同步本地文件索引、通过 WebRTC DataChannel 向网页端传输文件。
- `web`：现代化 Fluent 风格前端，支持登录注册、收藏、上传、下载、预览、后台管理。

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
