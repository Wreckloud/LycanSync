# LycanSync 单机部署包

本包用于当前测试阶段，面向 Linux x86_64，需预先安装 Docker Engine 和 Docker Compose v2。不需要在服务器安装 Java、Node 或 Rust。首次启动仍需要联网拉取镜像并构建 API 镜像；本包不是离线镜像包。

Ubuntu 24.04 或 CentOS Stream 9/10 可按各自的 [Docker 官方安装说明](https://docs.docker.com/engine/install/) 准备环境；旧 CentOS 的版本和已有 Docker 需先核实，不保证可运行当前镜像。Caddy 文件挂载使用 `ro,Z` 以适配 SELinux，不要求关闭 SELinux。

## 1. 准备地址和网络

- `SERVER_DOMAIN`：API 使用 `https://域名`，LiveKit 信令使用同一域名的 `wss://域名:8443`。
- `MEDIA_ADVERTISE_IP`：所有测试客户端能直接访问的服务器 IPv4，不能填写 `127.0.0.1`、Docker 容器地址或域名。公网服务器填公网 IP；同一局域网的 VMware 测试填虚拟机 IP，建议桥接网络。
- 需要 TCP 80、443、8443、7991 和 UDP 7992。80 用于证书申请，7991/7992 是媒体流，不经过 HTTPS 代理。PostgreSQL、API 18080 和 LiveKit 7990 不向宿主机公开。
- Caddy 默认自动申请可信证书，需要域名 DNS 指向服务器，且互联网能访问服务器的 80/443。仅有内网虚拟机 IP 时，不能直接按本配置申请公网证书。请先确定测试网络方案，不要禁用客户端证书校验。
- 当前未提供 TURN；严格 NAT、防火墙或运营商网络下可能无法传输媒体。先在同一局域网验证，再验证公网。

## 2. 配置并启动

解压后进入包目录：

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
nano .env
```

把两个独立随机值分别填入 `POSTGRES_PASSWORD` 和 `LIVEKIT_API_SECRET`，再填写域名和 IP。

```bash
chmod 600 .env
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 api livekit caddy
curl https://你的域名/actuator/health
```

健康接口应返回 `{"status":"UP"}`。首次启动自动创建数据库并执行 Flyway 迁移，包括本包的 V13。不要把本包直接指向未备份的现有开发数据库。

默认 `ACCOUNT_MODE=invite`，关闭测试注册和密码登录。必须使用新的独立数据库；已有测试账号的数据库切换邀请模式会明确拒绝启动，不自动删除数据。

首次激活：

```bash
docker compose exec -T api cat /var/bootstrap/admin-activation.txt
```

复制输出链接到浏览器，下载应用后返回原页面点击“打开应用”，确认成为服主。激活链接 12 小时有效；未激活时重启 API 会生成新链接，旧链接失效。激活文件在私有 `account-bootstrap` 卷中，不能映射到公开网站；输出不要分享给成员。激活后的重启会删除旧文件。

在服主设置“邀请与成员”中生成每人一条的 3 天邀请，或为原成员生成 12 小时恢复链接。成功恢复后旧会话失效，原资料和权限保留；服主自身恢复暂不提供。本机和虚拟机同样使用邀请登录，运行环境不支持 `ACCOUNT_MODE=test`。QQ 尚未开通，当前使用邀请身份与系统加密的桌面会话。

`downloads/LycanSync-setup.exe` 是网页使用的安装程序别名；版本化的安装包、同名 `.blockmap` 和 `latest.yml` 供自动更新使用，由 Caddy 提供，API、PostgreSQL 仍不直接暴露。`package-server.ps1` 检查清单名称及 SHA-512 与安装包一致，不允许混用不同构建批次。首次接入自动更新需手动安装 0.0.4 或以后版本。

发布新客户端时先递增 `apps/web/package.json` 与锁文件的版本，再按 README 构建。将版本化安装包及 `.blockmap` 上传到打包时固定的 HTTPS 更新目录，更新 `LycanSync-setup.exe` 别名，最后将同批 `latest.yml` 原子替换到位；不得先发布清单，也不要覆盖旧的版本化文件。保留旧 `.blockmap` 供差量下载；缺失时更新库会尝试完整下载。只发布静态文件不需要重启 API 或清理数据库。

例如在服务器目录已收到同批产物后（将 `0.0.5` 换成实际版本；这些文件必须先上传完整）：

```bash
cp incoming/LycanSync-0.0.5-windows-x64-setup.exe downloads/
cp incoming/LycanSync-0.0.5-windows-x64-setup.exe.blockmap downloads/
cp incoming/LycanSync-0.0.5-windows-x64-setup.exe downloads/LycanSync-setup.exe.next
mv downloads/LycanSync-setup.exe.next downloads/LycanSync-setup.exe
cp incoming/latest.yml downloads/latest.yml.next
mv downloads/latest.yml.next downloads/latest.yml
```

更新目录默认是打包 API 地址的 `/downloads/`，可用 `LYCANSYNC_PACKAGED_UPDATE_URL` 在构建时指定独立站点。用户切换业务服务器不改变更新目录；不要从用户填写的服务器获取并执行安装包。内网更新同样要求信任自己的测试 CA，不禁用 TLS 校验。SHA-512 检查用于发现文件损坏，不代替发布者签名；当前安装包未签名，正式对外发布前需评估签名并完成 Windows 安装升级验收。

请勿公开密钥、`.env`、激活文件或恢复链接。

## 3. 仅内网 VMware 测试

没有公网域名或端口映射时，使用独立的内网覆盖文件，保留 HTTPS 校验。在 `.env` 中将 `SERVER_DOMAIN` 和 `MEDIA_ADVERTISE_IP` 都填写为 Linux VM 的固定 IPv4，例如 `192.168.1.50`。不要继续使用示例公网域名。

```bash
docker compose -f compose.yaml -f compose.lan.yaml config --quiet
docker compose -f compose.yaml -f compose.lan.yaml up -d --build
docker compose -f compose.yaml -f compose.lan.yaml cp \
  caddy:/data/caddy/pki/authorities/local/root.crt ./lycansync-local-ca.crt
curl --cacert ./lycansync-local-ca.crt https://192.168.1.50/actuator/health
```

Caddy 完成首次启动后才能导出证书。把**自己这台服务器导出的** `lycansync-local-ca.crt` 复制到物理 Windows 和各 Windows VM，由你手动导入“当前用户 → 受信任的根证书颁发机构”，再启动客户端。这会增加对该测试 CA 的信任；不要导入来源不明的 CA，测试结束后可以删除该证书。不要复制服务器的私钥。这个步骤只用于你自己的内网测试，不分发到普通用户。

客户端地址填写 `https://192.168.1.50`。所有后续内网维护命令都带上 `-f compose.yaml -f compose.lan.yaml`，否则会切回公网证书配置。服务器更换 IP 后，要同步修改 `.env`、客户端地址并重建连接。

## 4. 配置 Windows 客户端

直接运行 Windows x64 安装程序；缺少所需 VC++ x64 运行库时，安装程序会启动内置的微软安装程序，可能请求管理员授权。已有满足要求的运行库则跳过。完成页可选择立即启动。

安装包预填打包时指定的服务器地址。在未登录页面打开“服务器地址”，填写 `https://你的域名` 或内网测试 IP，然后保存并重启。已经登录时先退出登录。

地址只包含协议、主机和可选端口，不添加 `/api` 或凭据。选择保存在用户目录，不编辑安装目录或 `app.asar`，也不禁用 TLS 校验。换服务器不会沿用另一个服务器的登录会话。内网测试仍需按前节手动导入自己服务器的 CA。

安装包未做代码签名。若安全软件阻止，请保留报告排查或使用正式签名流程，不要关闭保护或添加整盘排除。

## 5. 数据和维护

- PostgreSQL 数据位于 `postgres-data` 卷；原始文件位于 `chat-files` 卷。单文件 100 MiB，总文件容量 10 GiB。
- Caddy 证书位于 `caddy-data` 卷；不要丢弃，否则需要重新申请证书。
- `docker compose stop` 保留数据；`docker compose down` 也保留命名卷。**不要用 `down -v`，它会删除数据。**
- 备份时先停止写入，备份 PostgreSQL 和聊天文件同一时间点的数据；恢复时一起恢复。不要只备份数据库。
- 更新 API 前备份数据，替换 `api.jar` 后运行 `docker compose up -d --build api`。数据库迁移不能通过替换旧 JAR 自动回滚。
- 在登录页保存的服务器地址位于用户目录，更新安装包不会覆盖；未自行选择时使用新包的默认地址。

## 6. 首轮验收

物理主机及 Windows VM 各安装一个客户端：服主激活 → 邀请加入、跳过/保存资料 → 换电脑恢复登录与旧会话失效 → 同群聊天、图片和文件 → 双向语音 → 屏幕共享与共享声音 → 重复开关、退出重入 → 30 分钟持续运行。VM 的虚拟声卡、显卡和硬件编码能力与真实设备不同；音质和高帧率最终还需真实设备验收。

这个包已做构建和静态检查，不代表已在 Linux、安装版或真实媒体设备上验收。Windows 10/11 的黄色边框、进程音频及设备兼容限制仍以当前实现和实际系统为准；NSIS 安装不会自动获得 MSIX 的系统能力声明。
