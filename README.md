# LycanSync

面向 4–8 名熟人的 Windows 游戏语音和多人屏幕共享项目。

当前为本机开发版，提供持久化群组、注册账号自动加入所有群组、群组语音和屏幕共享，以及 Vue 界面与 Electron 桌面客户端。已接入开放注册的本地账号、首位管理员、自定义资料及桌面自动登录。文字消息发送、成员在线状态、游戏音频、账号恢复和桌面安装包尚未实现。当前配置不适用于公网或生产部署。

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

后端从仓库根目录或 `services/api` 启动时读取根 `.env`，默认使用其中的 PostgreSQL 端口和密码；同名环境变量优先。在仓库根目录执行：

```powershell
mvn -f services/api/pom.xml spring-boot:run
```

首次启动会自动执行数据库迁移。默认端口为 `18080`，可通过环境变量 `SERVER_PORT` 修改。

- 初始化信息：<http://localhost:18080/api/system/initialization>，返回初始化状态和服务器 UTC 时间。
- 健康检查：<http://localhost:18080/actuator/health>
- 接口文档：<http://localhost:18080/swagger-ui.html>
- OpenAPI JSON：<http://localhost:18080/v3/api-docs>


## 本地账号与首位管理员

登录功能不需要额外的环境变量：

1. 空数据库中第一个成功注册的账号自动成为管理员。
2. 初始化完成后仍允许创建普通账号，登录页可以在登录和注册之间切换。
3. 用户名使用 3–32 位字母、数字或下划线，不区分大小写；密码为 6–64 个字符且使用 BCrypt 保存。注册后的昵称初始为用户名，可在个人设置中修改并上传 PNG/JPEG 头像（256×256、96 KiB 以内）。旧头像不会自动转换，需要时可在个人设置中重新上传。
4. 桌面会话使用系统加密保存；同一账号新登录会替换旧会话，旧设备在下次请求时退出。30 天未使用后需重新登录；浏览器开发页面不持久化会话。

当前模式面向知道服务器地址的可信使用者。任何成功注册的账号都能看到全部群组、成员资料并加入其语音；开放注册不等同于成员审核。安装包可以被再次转发，因此不能作为可靠的访问凭据；若将服务暴露到公网，应先限制注册或引入可信登录方式。未实现修改密码、账号封禁、管理员转让及账号恢复工具，请妥善备份数据库。

当前只实现本地账号，不包含未启用的第三方登录开关。用户资料和会话保持通用，本地密码单独保存在 `auth_local_credential`；以后接入其他登录方式时增加独立身份表和对应 Service 即可，不需要改动现有业务用户与会话结构。

## 群组

登录后可以创建群组。单击群组头像预览成员；双击头像或点击耳机图标加入该群语音。创建者标记为群主，所有当前及后来注册的账号都自动成为每个群组的成员，无需邀请。朋友刷新群组列表后即可看到新群组。每个群组有独立的实时房间；预览其他群组不会切换正在进行的语音。

群组列表、创建和详情对应 `GET /api/groups`、`POST /api/groups`、`GET /api/groups/{groupId}`。成员列表来自已注册账号，人数随注册自动变化；不再提供逐个添加成员的接口。目前不支持文字消息发送。

## 本地 RTC 调试

此模式需要已认证的账号和现存群组，媒体地址仍仅适用于本机。请勿直接暴露本地 LiveKit 端口。

1. 确认根目录 `.env` 已按上文配置。API key 使用字母、数字、下划线或短横线；不要提交真实凭证。
2. 使用同一个 Compose 文件启动 PostgreSQL 和本地 LiveKit 1.13.6：

```powershell
docker compose config --quiet
docker compose up -d --wait
```

3. 填写 `.env` 中的数据库和 LiveKit 配置，再启动：

```powershell
mvn -f services/api/pom.xml spring-boot:run "-Dspring-boot.run.profiles=rtc-local"
```

IDEA 工作目录设为仓库根目录或 `services/api`，Active profiles 设为 `rtc-local`；也可以显式提供环境变量覆盖文件配置。其他工作目录请通过 `spring.config.additional-location` 指定配置位置。

后端只监听 `127.0.0.1`；LiveKit 默认使用 `7990/TCP`（信令/API）、`7991/TCP`（媒体回退）、`7992/UDP`（媒体），并且只映射到本机。端口可在 `.env` 修改；当前不支持朋友从其他电脑接入。

可从 `http://127.0.0.1:18080/v3/api-docs` 重新导入 Apifox，然后发送：

```http
POST /api/rtc/token
Content-Type: application/json
Authorization: Bearer <当前会话>

{"groupId":"<现存群组的 UUID>"}
```

响应包含 `serverUrl`、`roomName`、`participantIdentity`、`token` 和 `expiresAt`。房间名由群组 UUID 确定，身份与昵称取自已登录账号；任何已注册账号均可申请现存群组的凭证。同账号在另一台设备加入时，LiveKit 会断开旧连接。凭证允许发布麦克风、屏幕视频、订阅其他人以及更新自己的收听状态，不开放摄像头、屏幕音频、数据发送或房间管理权限。

未加入语音时可查询当前群组的安全摘要：

```http
GET /api/rtc/room-summary?groupId=<现存群组的 UUID>
Authorization: Bearer <当前会话>
```

该接口向已登录账号返回 `participantCount` 和按加入顺序排列的 `participants`（含 `participantIdentity`、`displayName`），不返回头像、麦克风、发言、收听或屏幕共享状态。

凭证用于 10 分钟内首次加入，不代表 10 分钟后强制结束通话。签发成功只证明后端生成了凭证，不保证 LiveKit 在线或媒体连接成功。不启用 `rtc-local` 时，已认证请求返回 404（匿名请求先返回 401），也不会出现在 OpenAPI 文档中。

## 启动浏览器客户端

浏览器客户端使用 Vue 3、TypeScript 和 Vite，实时音视频使用 LiveKit JavaScript SDK。

先按上文启动 PostgreSQL、LiveKit 和启用 `rtc-local` 的后端，再打开一个终端，在仓库根目录执行：

```powershell
cd apps/web
npm ci
npm run dev
```

访问 `http://127.0.0.1:4173`，完成登录后创建群组，双击群组头像进入语音。浏览器调试会话仅保存在内存，刷新需重新登录；桌面端支持自动登录。Vite 仅监听本机，可通过 `WEB_PORT` 更换端口；`/api` 代理到 `127.0.0.1:18080`，后端端口改变时需同步修改 `apps/web/vite.config.ts` 的代理目标。前端不需要数据库密码或 LiveKit API secret。

- 明确加入语音后默认请求麦克风权限；屏幕只在点击共享图标后采集。关闭麦克风、停止共享或离开房间会停止对应采集。
- 成员区域显示真实群组成员，文字聊天区域尚不能发送消息；语音区域中的参与者来自实际 RTC 房间。没有全局在线或活动状态。
- 每个持久化群组使用独立的语音房间，预览其他群组不会自动切换通话。
- 有人共享时，主观看区自动显示第一路；展开底部成员条后，直接点击共享缩略图可同时放大最多 4 路。每个主画面可独立全屏或进入画中画。
- 本地原型不设置语音成员数上限；同一群组界面最多允许 8 路共享，目前为客户端软限制，尚无服务端并发名额控制。
- 耳机按钮控制是否播放成员语音，不会停止网络订阅；音量按钮只调整本机播放音量。若浏览器阻止自动播放，点击耳机按钮允许播放。
- 屏幕采集目标为 1920×1080、30 FPS，主画面编码上限约 5 Mbps，并提供 360p/15 FPS 与 720p/15 FPS 两层小画面；LiveKit 会结合画面尺寸和可见性按需选择、停用编码层。实际尺寸、帧率和码率仍取决于采集目标、电脑性能和网络状态。这不是 60 FPS 游戏直播模式。
- 首版只共享屏幕视频，不传输游戏/系统音频。语音开启浏览器回声消除、降噪和自动增益约束，效果需在真实设备上验证。

多用户手工测试需要创建不同账号；同账号同时入房会替换旧连接。建议戴耳机，并先只在一个页面开麦，避免同一物理麦克风被多路采集造成重复声音。共享时选择普通应用窗口，避免共享当前页面产生递归镜像。

## Windows 桌面客户端（开发版）

先启动上述 PostgreSQL、LiveKit 和后端，再执行：

```powershell
cd apps/web
npm ci
npm run desktop
```

该命令先构建 Vue 界面，再打开 Electron 窗口，无需启动 Vite。修改界面后需关闭桌面窗口并重新运行此命令。首次运行会下载 Electron；下载需要可访问其官方发行资源的网络。

需要在一台电脑模拟多人时，先运行一次 `npm run build`，再给每个测试实例指定不同的 Chromium 用户目录：

```powershell
npx electron electron/main.cjs --user-data-dir="$env:LOCALAPPDATA\LycanSync-Test-2"
npx electron electron/main.cjs --user-data-dir="$env:LOCALAPPDATA\LycanSync-Test-3"
```

不同目录拥有独立的加密登录会话和单实例锁；每个窗口请注册不同账号。同一账号同时加入同一语音房间时，LiveKit 会保留新连接并断开旧连接。正常启动仍只允许一个主实例。

- 支持拖动标题栏、最小化、最大化／还原和关闭；再次启动会唤起已有窗口。
- 默认窗口为 1280×820 逻辑像素，在当前屏幕工作区居中，小屏自动缩小。内容区独立滚动，不显示默认滚动条；支持滚轮和触控板。
- 关闭最后的应用窗口即退出，不驻留托盘；退出时停止麦克风和屏幕采集。后端与 Docker 容器需要独立停止。
- 共享前在窗口／屏幕列表中选择目标，可取消；当前仅共享视频，不采集摄像头或系统音频。
- 桌面业务请求由主进程转发到 `electron/server-config.json` 指定的服务，不依赖 Vite 代理。开发模式可用 `$env:LYCANSYNC_API_URL = "http://127.0.0.1:18080"` 临时覆盖；安装版固定使用打包时的配置且不提供服务器切换界面。地址不能包含路径，非本机地址必须使用 HTTPS。
- 此变量只指定业务后端；音视频服务地址仍来自后端签发的凭证。当前 RTC 配置及 LiveKit 仍限本机，修改变量不会自动获得公网部署能力。

目前提供源码开发运行，尚不包含安装程序、自动更新、托盘或游戏内悬浮层。

## 验证

```powershell
mvn -f services/api/pom.xml test
mvn -f services/api/pom.xml clean verify
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

测试覆盖窗口控制、页面隔离、摄像头拒绝、真实入房、取消共享、共享测试窗口、离房与关窗退出。麦克风使用合成设备，共享只选择测试创建的纯色窗口；不会录制真实桌面。桌面测试与浏览器测试分开运行。测试 API 替身仅位于 tests，媒体仍连接真实本机 LiveKit。认证后端测试使用隔离 PostgreSQL，不会修改开发数据库。

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
