# LycanSync

面向 4–8 名熟人的 Windows 游戏语音、文字聊天和多人屏幕共享项目。

当前为开发预览，提供后端系统接口、本地数据库迁移和本地 RTC 入房凭证。尚无可用的桌面客户端、语音、文字聊天或屏幕共享界面。当前配置不适用于生产部署。

## 运行环境

- 后端：JDK 17、Maven。
- 本地数据库：Docker Desktop（Windows 使用 WSL 2），包含 Docker Compose。

## 启动本地数据库

后端需要 PostgreSQL 18.6。

1. 启动 Docker Desktop。
2. 将根目录 `.env.example` 复制为 `.env`，设置随机的 `POSTGRES_PASSWORD`。已有 `.env` 时不要覆盖。
3. 在仓库根目录执行：

```powershell
docker compose up -d --wait postgres
docker compose ps
```

连接地址为 `127.0.0.1:5432`，数据库名为 `lycansync`，用户名为 `postgres`，密码为 `.env` 中的 `POSTGRES_PASSWORD`。该管理员账号仅用于本地开发。

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

1. 在根目录 `.env` 中配置 `LIVEKIT_API_KEY` 和 `LIVEKIT_API_SECRET`。API key 使用字母、数字、下划线或短横线；secret 使用至少 32 个字符的随机值。不要覆盖已有数据库密码，不要提交真实凭证。
2. 启动本地 LiveKit 1.13.6：

```powershell
docker compose -f compose.yaml -f compose.rtc.yaml config --quiet
docker compose -f compose.yaml -f compose.rtc.yaml up -d livekit
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

{"displayName":"小狼"}
```

响应包含 `serverUrl`、`roomName`、`participantIdentity`、`token` 和 `expiresAt`。固定房间为 `lycan-sync-dev`，最多 8 人；每次请求生成独立临时身份。昵称为 1–32 个字符且不能全为空白。凭证允许发布麦克风、屏幕视频并订阅其他人，不开放摄像头、屏幕音频、数据发送或管理权限。

凭证用于 10 分钟内首次加入，不代表 10 分钟后强制结束通话。签发成功只证明后端生成了凭证，不保证 LiveKit 在线或媒体连接成功。不启用 `rtc-local` 时，该接口返回 404，也不会出现在 OpenAPI 文档中。

## 验证

```powershell
mvn -f services/api/pom.xml test
mvn clean verify
```

`test` 无需 Docker。`verify` 需要 Docker，会自动创建隔离的 PostgreSQL 和 LiveKit 测试容器，不使用开发数据库。测试覆盖凭证签名、配置限制、接口校验、数据库迁移和 LiveKit 信令入房；尚不验证实际音视频传输。

## 停止运行

在后端终端按 `Ctrl+C`，然后在仓库根目录执行：

```powershell
docker compose down
```

如果启用了本地 RTC，使用同一组 Compose 文件停止全部开发服务：

```powershell
docker compose -f compose.yaml -f compose.rtc.yaml down
```

只停止 LiveKit、不影响数据库时使用 `docker compose -f compose.yaml -f compose.rtc.yaml stop livekit`。

不再使用 Docker 时，从系统托盘退出 Docker Desktop。必要时执行 `wsl --shutdown`；此命令会停止所有 WSL 发行版，请先保存其中的工作。

## 数据与密码

- 数据保存在命名卷 `lycan-sync_postgres-data` 中，`docker compose down` 会保留数据；添加 `-v` 会删除数据卷，请勿用于日常停止。
- `.env` 中的密码仅在数据库首次初始化时生效，已有数据库需通过 SQL 修改密码。
- 请勿公开 `.env` 中的真实密码；升级数据库前请另行备份，数据卷不能替代备份。
