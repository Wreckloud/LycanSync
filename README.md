# LycanSync

面向 4–8 名熟人的 Windows 游戏语音、文字聊天和多人屏幕共享项目。

当前为本机开发版，提供后端系统接口、本地数据库迁移，以及支持多人语音、多路屏幕视频和多画面观看的 Vue 界面与 Electron 桌面客户端。尚无 QQ 登录、持久化群组、成员在线状态、文字聊天、游戏音频或桌面安装包。当前配置不适用于公网或生产部署。

## 运行环境

- 后端：JDK 17、Maven。
- 本地数据库：Docker Desktop（Windows 使用 WSL 2），包含 Docker Compose。
- 浏览器客户端：Node.js 22.12+、npm，以及支持屏幕采集的桌面 Chrome / Edge。

## 启动本地数据库

后端需要 PostgreSQL 18.6。

1. 启动 Docker Desktop。
2. 将根目录 `.env.example` 复制为 `.env`，一次性设置随机的 `POSTGRES_PASSWORD`、`LIVEKIT_API_KEY` 和至少 32 个字符的 `LIVEKIT_API_SECRET`。Compose 使用同一个文件管理全部基础服务，即使只启动数据库也会先校验这些配置。已有 `.env` 时不要覆盖。
3. 在仓库根目录执行：

```powershell
docker compose up -d --wait postgres
docker compose ps
```

默认连接地址为 `127.0.0.1:5432`，数据库名为 `lycansync`，用户名为 `postgres`，密码为 `.env` 中的 `POSTGRES_PASSWORD`。如果 Windows 保留了 5432 端口，可在 `.env` 设置 `POSTGRES_PORT=55432`，并让后端使用对应的 `DB_URL`。该管理员账号仅用于本地开发。

## 启动后端

将 `.env` 中的 `POSTGRES_PASSWORD` 作为环境变量 `DB_PASSWORD` 提供给后端，然后在仓库根目录执行：

```powershell
mvn -f services/api/pom.xml spring-boot:run
```

首次启动会自动执行数据库迁移。默认端口为 `18080`，可通过环境变量 `SERVER_PORT` 修改。

- 初始化信息：<http://localhost:18080/api/system/initialization>，返回初始化状态和服务器 UTC 时间。
- 健康检查：<http://localhost:18080/actuator/health>
- 接口文档：<http://localhost:18080/swagger-ui.html>
- OpenAPI JSON：<http://localhost:18080/v3/api-docs>

## 本地 RTC 调试

此模式不验证 QQ 身份，仅限同一台电脑上的开发测试。不要通过反向代理、隧道或公网转发暴露调试接口。

1. 确认根目录 `.env` 已按上文配置。API key 使用字母、数字、下划线或短横线；不要提交真实凭证。
2. 使用同一个 Compose 文件启动 PostgreSQL 和本地 LiveKit 1.13.6：

```powershell
docker compose config --quiet
docker compose up -d --wait
```

3. 为后端设置 `DB_PASSWORD`、`LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET` 环境变量，再启动：

```powershell
mvn -f services/api/pom.xml spring-boot:run "-Dspring-boot.run.profiles=rtc-local"
```

根 `.env` 供 Compose 读取，不会自动注入 Maven 或 IDEA 启动的 Java 进程。IDEA 运行配置中设置同名环境变量，并将 Active profiles 设为 `rtc-local`。

后端只监听 `127.0.0.1`；LiveKit 的 `7880/TCP`（信令/API）、`7881/TCP`（媒体回退）、`7882/UDP`（媒体）也只映射到本机。当前不支持朋友从其他电脑接入。

可从 `http://127.0.0.1:18080/v3/api-docs` 重新导入 Apifox，然后发送：

```http
POST /api/rtc/token
Content-Type: application/json

{"groupId":"pack","displayName":"小狼"}
```

响应包含 `serverUrl`、`roomName`、`participantIdentity`、`token` 和 `expiresAt`。每个群组对应一个 `lycan-sync-dev-{groupId}` 测试房间；每次请求生成独立临时身份。昵称为 1–32 个字符且不能全为空白。凭证允许发布麦克风、屏幕视频、订阅其他人以及更新自己的收听状态，不开放摄像头、屏幕音频、数据发送或房间管理权限。

未加入语音时可查询当前群组的安全摘要：

```http
GET /api/rtc/room-summary?groupId=pack
```

该接口只返回 `participantCount` 和按加入顺序排列的 `participantNames`，不返回麦克风、发言、收听或屏幕共享状态。

凭证用于 10 分钟内首次加入，不代表 10 分钟后强制结束通话。签发成功只证明后端生成了凭证，不保证 LiveKit 在线或媒体连接成功。不启用 `rtc-local` 时，该接口返回 404，也不会出现在 OpenAPI 文档中。

## 启动浏览器客户端

浏览器客户端使用 Vue 3、TypeScript 和 Vite，实时音视频使用 LiveKit JavaScript SDK。

先按上文启动 PostgreSQL、LiveKit 和启用 `rtc-local` 的后端，再打开一个终端，在仓库根目录执行：

```powershell
cd apps/web
npm ci
npm run dev
```

访问 `http://127.0.0.1:4173`，双击群组头像并确认本地昵称即可进入该群组的测试房间。Vite 仅监听本机，可通过 `WEB_PORT` 更换端口；`/api` 代理到 `127.0.0.1:18080`，后端端口改变时需同步修改 `apps/web/vite.config.ts` 的代理目标。前端不需要数据库密码或 LiveKit API secret。

- 明确加入语音后默认请求麦克风权限；屏幕只在点击共享图标后采集。关闭麦克风、停止共享或离开房间会停止对应采集。
- 成员和文字聊天区域仅展示功能未开放提示，不包含模拟用户、在线状态、活动或历史消息；语音区域中的参与者来自实际 RTC 房间。
- 当前仅保留一个明确标注的本地调试房间，供账号与群组接入前验证语音和共享，不代表已创建正式群组。跨群组数据仅存在于自动化测试中。
- 有人共享时，主观看区自动显示第一路；展开底部成员条后，直接点击共享缩略图可同时放大最多 4 路。每个主画面可独立全屏或进入画中画。
- 本地原型不设置语音成员数上限；同一群组界面最多允许 8 路共享，最终服务端并发校验会在正式房间接口中实现。
- 耳机按钮控制是否播放成员语音，不会停止网络订阅；音量按钮只调整本机播放音量。若浏览器阻止自动播放，点击耳机按钮允许播放。
- 屏幕采集目标为 1280×720、15 FPS，主视频编码上限约 1.5 Mbps；实际尺寸和帧率取决于浏览器、所选窗口和运行状态。这不是 60 FPS 游戏直播模式。
- 首版只共享屏幕视频，不传输游戏/系统音频。语音开启浏览器回声消除、降噪和自动增益约束，效果需在真实设备上验证。

可在本机打开多个标签页测试不同临时身份。建议戴耳机，并先只在一个页面开麦，避免同一物理麦克风被多路采集造成重复声音。共享时选择普通应用窗口，避免共享当前页面产生递归镜像。

## Windows 桌面客户端（开发版）

先启动上述 PostgreSQL、LiveKit 和后端，再执行：

```powershell
cd apps/web
npm ci
npm run desktop
```

该命令先构建 Vue 界面，再打开 Electron 窗口，无需启动 Vite。修改界面后需关闭桌面窗口并重新运行此命令。首次运行会下载 Electron；下载需要可访问其官方发行资源的网络。

- 支持拖动标题栏、最小化、最大化／还原和关闭；再次启动会唤起已有窗口。
- 默认窗口为 1280×820 逻辑像素，在当前屏幕工作区居中，小屏自动缩小。内容区独立滚动，不显示默认滚动条；支持滚轮和触控板。
- 关闭最后的应用窗口即退出，不驻留托盘；退出时停止麦克风和屏幕采集。后端与 Docker 容器需要独立停止。
- 共享前在窗口／屏幕列表中选择目标，可取消；当前仅共享视频，不采集摄像头或系统音频。
- 桌面业务请求由主进程转发到 `http://127.0.0.1:18080`，不依赖 Vite 代理。可在启动前设置 `$env:LYCANSYNC_API_URL = "http://127.0.0.1:18080"`；值须为不含路径的服务地址，非本机地址必须使用 HTTPS。
- 此变量只指定业务后端；音视频服务地址仍来自后端签发的凭证。当前匿名测试接口及 LiveKit 仍限本机，修改变量不会自动获得公网部署能力。

目前提供源码开发运行，尚不包含安装程序、自动更新、托盘或游戏内悬浮层。

## 验证

```powershell
mvn -f services/api/pom.xml test
mvn clean verify
```

后端 `test` 无需 Docker。`verify` 需要 Docker，会自动创建隔离的 PostgreSQL 和 LiveKit 测试容器，不使用开发数据库。测试覆盖凭证签名、配置限制、接口校验、数据库迁移和 LiveKit 信令入房。

前端在 `apps/web` 目录执行：

```powershell
npm test
npm run build
```

浏览器集成测试还需要前述本地后端和 LiveKit 正在运行，且 `4173` 端口空闲；测试会自行启动并停止 Vite。在 Windows 上可使用已安装的 Edge：

```powershell
$env:PLAYWRIGHT_CHANNEL = "msedge"
npm run test:e2e
```

或运行 `npx playwright install chromium` 安装测试专用浏览器，不设置 `PLAYWRIGHT_CHANNEL` 时默认使用它。集成测试使用合成麦克风和合成画面，不采集真实桌面；覆盖双人及四人音视频实际接收、成员条和多画面观看、取消与拒绝授权、离房释放采集。它不替代真实游戏、异地网络或 8 人容量测试。测试期间不要混入其他手动入房会话。

`npm run build` 只验证并生成前端静态产物，当前开发代理不随产物部署；正式部署的鉴权、HTTPS/WSS、路由代理和 TURN 尚未配置。

桌面集成测试需本地后端和 LiveKit 正在运行，并先关闭手动打开的 LycanSync 桌面窗口：

```powershell
npm run test:desktop
```

测试覆盖窗口控制、页面隔离、摄像头拒绝、真实入房、取消共享、共享测试窗口、离房与关窗退出。麦克风使用合成设备，共享只选择测试创建的纯色窗口；不会录制真实桌面。桌面测试与浏览器测试分开运行。

## 停止运行

先离开浏览器房间，在前端、后端终端分别按 `Ctrl+C`，然后在仓库根目录执行：

```powershell
docker compose down
```

PostgreSQL 和 LiveKit 已放在同一个 Compose 文件中。只停止 LiveKit、不影响数据库时使用 `docker compose stop livekit`。

不再使用 Docker 时，从系统托盘退出 Docker Desktop。必要时执行 `wsl --shutdown`；此命令会停止所有 WSL 发行版，请先保存其中的工作。

## 数据与密码

- 数据保存在命名卷 `lycan-sync_postgres-data` 中，`docker compose down` 会保留数据；添加 `-v` 会删除数据卷，请勿用于日常停止。
- `.env` 中的密码仅在数据库首次初始化时生效，已有数据库需通过 SQL 修改密码。
- 请勿公开 `.env` 中的真实密码；升级数据库前请另行备份，数据卷不能替代备份。
