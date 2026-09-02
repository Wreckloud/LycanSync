# LycanSync

面向 4–8 名熟人的 Windows 游戏语音、文字聊天和多人屏幕共享项目。

当前为开发预览，仅提供后端系统状态接口和本地数据库配置，尚无可用的桌面客户端、语音、文字聊天或屏幕共享功能。当前配置不适用于生产部署。

## 运行环境

- 后端：JDK 17、Maven。
- 本地数据库：Docker Desktop（Windows 使用 WSL 2），包含 Docker Compose。

## 启动后端

在仓库根目录执行：

```powershell
mvn -f services/api/pom.xml spring-boot:run
```

默认端口为 `8080`，可通过环境变量 `SERVER_PORT` 修改。

- 系统状态：<http://localhost:8080/api/v1/system/status>
- 接口文档：<http://localhost:8080/swagger-ui.html>
- OpenAPI JSON：<http://localhost:8080/v3/api-docs>

## 启动本地数据库

后端目前不依赖数据库，可按需单独启动 PostgreSQL 18.6。

1. 启动 Docker Desktop。
2. 将根目录 `.env.example` 复制为 `.env`，设置随机的 `POSTGRES_PASSWORD`。已有 `.env` 时不要覆盖。
3. 在仓库根目录执行：

```powershell
docker compose up -d --wait postgres
docker compose ps
```

连接地址为 `127.0.0.1:5432`，数据库名为 `lycansync`，用户名为 `postgres`，密码为 `.env` 中的 `POSTGRES_PASSWORD`。该管理员账号仅用于本地开发。

## 停止运行

在后端终端按 `Ctrl+C`，然后在仓库根目录执行：

```powershell
docker compose down
```

不再使用 Docker 时，从系统托盘退出 Docker Desktop。必要时执行 `wsl --shutdown`；此命令会停止所有 WSL 发行版，请先保存其中的工作。

## 数据与密码

- 数据保存在命名卷 `lycan-sync_postgres-data` 中，`docker compose down` 会保留数据；添加 `-v` 会删除数据卷，请勿用于日常停止。
- `.env` 中的密码仅在数据库首次初始化时生效，已有数据库需通过 SQL 修改密码。
- 请勿公开 `.env` 中的真实密码；升级数据库前请另行备份，数据卷不能替代备份。
