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

健康接口应返回 `{"status":"UP"}`。首次启动自动创建数据库并执行 Flyway 迁移，包括 V13 邀请账号、V14 私密群成员和 V15 音乐动态迁移；V14 从旧全员测试群只保留群主，群资料与聊天记录保留。V15 仅放宽动态类型约束，保留原有数据；须先备份并更新 API、确认迁移成功，再发布支持音乐动态的客户端。不要把本包直接指向未备份的现有开发数据库。

默认 `ACCOUNT_MODE=invite`，关闭测试注册和密码登录。必须使用新的独立数据库；已有测试账号的数据库切换邀请模式会明确拒绝启动，不自动删除数据。

0.2.20 的资料卡动态还需要 V16 迁移，给现有在线状态表增加独立展示开关、上次公开在线时间和最近一段公开游戏；不新增活动历史表。迁移仅从旧的公开在线记录回填时间，不从旧离线／隐身心跳推算，也不补造游戏历史。升级时先备份数据库，再更新 API 并确认 V16 成功，最后发布客户端；旧客户端省略新开关字段时沿用服务端已收到的选择。

首次激活：

```bash
docker compose exec -T api cat /var/bootstrap/admin-activation.txt
```

复制输出链接到浏览器，下载应用后返回原页面点击“打开应用”，确认成为服主。激活链接 12 小时有效；未激活时重启 API 会生成新链接，旧链接失效。激活文件在私有 `account-bootstrap` 卷中，不能映射到公开网站；输出不要分享给成员。激活后的重启会删除旧文件。

在服主设置“服主管理”中生成每人一条的 3 天邀请，或为原成员生成 12 小时恢复链接。成功恢复后旧会话失效，原资料和权限保留；服主自身可使用独立恢复密码从欢迎页“群组恢复”重新登录。首次激活需设置恢复密码；已有服主升级后必须先到账号设置中设置，升级不会替其生成密码。本机和虚拟机同样使用邀请登录，运行环境不支持 `ACCOUNT_MODE=test`。QQ 登录默认关闭；启用时填写 QQ_ENABLED、QQ_APP_ID、QQ_APP_KEY、QQ_CALLBACK_URL，回调使用同源 HTTPS 的 /api/auth/qq/callback。QQ 首次登录创建普通账号且不自动入群；老账号在设置中主动绑定后保留原资料和权限。独立官网部署见 ../qq-site/DEPLOY.md，平台未审核不代表所有 QQ 都能测试登录。

`downloads/LycanSync-setup.exe` 是网页使用的安装程序别名；版本化的安装包、同名 `.blockmap` 和 `latest.yml` 供自动更新使用，由 Caddy 提供，API、PostgreSQL 仍不直接暴露。`package-server.ps1` 检查清单版本、名称及 SHA-512 与安装包一致，再按同批 `LycanSync-版本-release.json` 核对全部分发文件的大小与 SHA-256；复制后复核，拒绝缺失、损坏或版本不符的材料。首次接入自动更新需手动安装 0.0.4 或以后版本。

发布新客户端时先递增 `apps/web/package.json` 与锁文件的版本，再按 README 构建。先上传版本化安装包、`.blockmap`、同版本 `LycanSync-版本-obs-source.tar.gz` 及第三方许可，确认下载文件哈希与构建记录匹配，再更新 `LycanSync-setup.exe` 及其 `.blockmap` 别名，最后原子替换同批 `latest.yml`；不得先发布清单，也不要覆盖旧的版本化文件。保留旧 `.blockmap` 供差量下载；缺失时更新库会尝试完整下载。只发布静态文件不需要重启 API 或清理数据库。

完整客户端构建会生成分发校验记录与 `LycanSync-版本-THIRD-PARTY-NOTICES.txt`。部署 ZIP 自动收集同版本安装包、`.blockmap`、OBS 源码归档、版本化许可、分发记录及 `latest.yml`，并包含 `LycanSync-setup.exe` 和 `.blockmap` 别名；不再需要人工补齐。脚本从独立暂存目录生成新 ZIP，失败保留旧包并清理本次暂存，不收集旧输出目录、数据库、运行时密钥或本机用户文件。

将同批构建产物一起保留，不手工修改分发记录来跳过校验；旧产物没有记录时请重新执行完整客户端打包。记录用于验证一致性，不替代发布者签名。Windows PowerShell 5.1 和 PowerShell 7 均有合成打包回归，真实 Linux 启动／迁移仍按集中验收执行。

例如在服务器目录已收到并核对同批产物后（将 `client_version` 换成实际版本；新版本下载路径不得已存在）：

```bash
set -euo pipefail
client_version=0.3.11
stage="incoming/$client_version"
installer="LycanSync-${client_version}-windows-x64-setup.exe"
# 上传前确认可用空间；同批材料放在 stage，校验后再执行以下步骤。
df -h .
mkdir -p "releases/$client_version"
cp downloads/latest.yml "releases/$client_version/previous-latest.yml"
ln "$stage/$installer" downloads/
ln "$stage/$installer.blockmap" downloads/
ln "$stage/LycanSync-${client_version}-obs-source.tar.gz" downloads/
ln "$stage/LycanSync-${client_version}-release.json" downloads/
ln "$stage/LycanSync-${client_version}-THIRD-PARTY-NOTICES.txt" downloads/
ln "downloads/$installer" downloads/LycanSync-setup.exe.next
mv downloads/LycanSync-setup.exe.next downloads/LycanSync-setup.exe
ln "downloads/$installer.blockmap" downloads/LycanSync-setup.exe.blockmap.next
mv downloads/LycanSync-setup.exe.blockmap.next downloads/LycanSync-setup.exe.blockmap
cp "$stage/latest.yml" "releases/$client_version/latest.yml"
cp "$stage/latest.yml" downloads/latest.yml.next
mv downloads/latest.yml.next downloads/latest.yml
```

## 发布目录与保留规则

现有部署根目录保留运行入口：api.jar、Dockerfile、Compose、Caddyfile 和 .env。不为整理目录迁移正在使用的挂载点或 Docker 命名卷，也不将私有配置放入下载区。

| 目录 | 用途与规则 |
| --- | --- |
| downloads/ | 唯一公开分发目录。保留当前版和上一版安装包、稳定下载别名与最新清单；所有已发布 OBS 对应源码、版本化许可证、分发记录和旧 blockmap 继续保留。更早安装包链接可退役。 |
| incoming/版本/ | 私有上传暂存，权限 700。核验完成再发布，不把临时目录放在 downloads 下。同一文件系统使用硬链接交付，避免复制一整套载荷；不要原地改写已经发布的文件。 |
| releases/版本/ | 小型发布记录、清单快照与历史部署脚本。不重复保存下载区已有的大载荷；清理后的历史脚本仅供追溯，不直接重新执行。客户端回退所需完整载荷在 downloads 保留两版。 |
| backups/ | 数据库、配置和旧后端备份；私有保存，不随客户端清理自动删除。后端回退与客户端保留规则分开。 |
| maintenance/ | 维护工具与操作报告。清理报告记录相对路径、原因和大小，不记录凭据正文。 |

数据库、聊天文件、账号初始化材料及网关证书继续使用 Compose 声明的命名卷，不在发布清理范围内。旧散落上传目录收进 incoming/legacy；无法确认相同内容的文件保留，不按名字猜测删除。

先预览，再显式执行（部署根目录按实际路径填写）：

```bash
python3 maintenance/maintain-releases.py /opt/lycansync-invite
python3 maintenance/maintain-releases.py /opt/lycansync-invite --apply
```

脚本先核对当前／上一版分发记录、校验和及下载别名，再按大小和 SHA-256 清理已确认的暂存副本与更早安装包；保留全部公开源码和许可证，忽略符号链接。更新清单变化或保留载荷损坏时停止，操作清单留在 maintenance。仅手动执行，不增加定时后台任务。发布与清理应串行进行；日后如使用外部磁盘，硬链接会明确失败，需另行设计交付步骤，不静默复制到占满磁盘。

更新目录默认是打包 API 地址的 `/downloads/`，可用 `LYCANSYNC_PACKAGED_UPDATE_URL` 在构建时指定独立站点。用户切换业务服务器不改变更新目录；不要从用户填写的服务器获取并执行安装包。内网更新同样要求信任自己的测试 CA，不禁用 TLS 校验。SHA-512 检查用于发现文件损坏，不代替发布者签名；当前安装包未签名，正式对外发布前需评估签名并完成 Windows 安装升级验收。

`latest.yml`、`LycanSync-setup.exe` 和对应别名 `.blockmap` 使用 `Cache-Control: no-store`，避免更新入口保留旧内容；保留期内的版本化文件不覆盖，并继续支持范围下载；源码、许可证和旧 blockmap 按前述规则保留。若前面另有 CDN 或代理，须遵循该响应头；曾配置强制缓存时需先清除已有缓存。

请勿公开密钥、`.env`、激活文件或恢复链接。

从 0.2.15 起，入场音效处理要求 API 镜像包含 FFmpeg；仓库 Dockerfile 使用 Java 17 的 Ubuntu Noble 基础镜像，在构建时安装该软件源的 `ffmpeg`，升级 API 时须同时更新 Dockerfile 并重建镜像，不只替换 JAR。应用不将音频转码放在通话实时链路；登录用户主动上传时才短暂启动单个解码进程，8 秒超时，不排队启动多个进程。仅接受固定音频容器与本地文件协议，不接收任意 URL、路径或 FFmpeg 参数；解码子进程不继承 API 凭据环境。失败返回固定原因，不向客户端或日志输出原音频及工具正文。

临时文件位于 API 工作目录下的 `./var/audio-processing`（镜像内 `/app/var/audio-processing`），正常成功和失败均删除，不写数据库或长期音效库。开发部署可用 `AUDIO_FFMPEG_EXECUTABLE` 指定受信任的 FFmpeg 可执行文件，`AUDIO_PROCESSING_DIR` 指定服务自身可写目录；不要由请求参数决定。缺少工具仅使音效处理返回不可用，不影响已有语音／共享。音效页保存的是处理后返回的本机副本，不提供跨设备同步。

私密群权限要求后端与 Caddy 配置一起更新：8443 端口只代理 `/rtc`、`/rtc/validate`、`/rtc/v1`、`/rtc/v1/validate`，每次连接先由 `/internal/rtc/access` 验证 LiveKit 签名及当前群成员资格。该内部路径在业务入口返回 404；API 与 LiveKit HTTP 端口保持容器内访问，不直接发布。不要将 7990 映射给客户端，也不要通过另一个未校验的代理开放信令。首次从全员测试版迁移时，旧群只保留群主，并关闭旧公开语音房间；建议无人通话时部署。成员日常退出／移除只断开目标用户，不重建房间。

同版本 `compose.yaml` 配置 LiveKit 签名 webhook 到 `http://api:18080/internal/rtc/events`，用于复核迟到入房，不轮询房间。升级已有部署时需要加载这项 LiveKit 配置；先确认无人通话，再更新后端及 LiveKit，最后验证并重新加载 Caddy。不要对外开放回调路径，不关闭签名和正文 SHA-256 校验。此异步复核不等于零帧暴露保证。

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

内网证书由 Caddy 自动维护，默认有效期 12 小时；本配置将续期检查间隔设为 1 分钟，缩短虚拟机长时间暂停、恢复计时和校时后的检查等待。检查不等于每分钟签发证书，也不会重启网关或媒体服务。保持 Docker 开机启动和虚拟机时间同步；暂停期间无法续期，恢复网络、时钟和进程调度仍需时间，不能保证恢复瞬间即可访问。不要通过延长证书有效期、删除 `caddy-data` 或关闭客户端校验处理问题。参考 [Caddy 续期检查选项](https://caddyserver.com/docs/caddyfile/options#renew-interval) 和 [内网签发配置](https://caddyserver.com/docs/caddyfile/directives/tls#internal)。

仅更新网关配置时，在原部署目录验证并平滑加载，无需重启 API、LiveKit 或数据库：

```bash
docker compose -f compose.yaml -f compose.lan.yaml exec -T caddy \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose -f compose.yaml -f compose.lan.yaml exec -T caddy \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
curl --fail --cacert ./lycansync-local-ca.crt \
  -D - https://你的内网IP/downloads/latest.yml
```

当前固定的 Caddy 2.10.2／CertMagic 0.24.0 在创建证书缓存时建立续期计时器，平滑加载只更新配置，不重建已有计时器。首次修改 `renew_interval` 后，须在无人通话时额外运行一次 `docker compose -f compose.yaml -f compose.lan.yaml restart caddy`，仅重启网关，可能短暂中断下载及信令连接；其他服务不重启。后续无需定时重启。依据：[Caddy 缓存复用](https://github.com/caddyserver/caddy/blob/v2.10.2/modules/caddytls/tls.go)、[CertMagic 计时器创建](https://github.com/caddyserver/certmagic/blob/v0.24.0/maintain.go)。

确认清单版本及 `Cache-Control: no-store`，并核验版本化安装包仍支持 `Range` 请求。若 HTTPS 失败，先检查虚拟机时间、证书有效期和 `docker compose -f compose.yaml -f compose.lan.yaml logs --tail=100 caddy` 的续期错误；平滑加载只用于配置变更或明确故障排查，不设置无条件的定时重载。保留原 CA，已有客户端无需重新导入证书。

## 4. 配置 Windows 客户端

直接运行 Windows x64 安装程序；缺少所需 VC++ x64 运行库时，安装程序会启动内置的微软安装程序，可能请求管理员授权。已有满足要求的运行库则跳过。完成页可选择立即启动。

安装包预填打包时指定的服务器地址。在未登录页面展开“更多”，在其中填写服务器地址 `https://你的域名` 或内网测试 IP，然后保存并重启。已经登录时先退出，再在账号页“更多”中确认清除本机登录凭据。

地址只包含协议、主机和可选端口，不添加 `/api` 或凭据。选择写入安装目录下的 `data` 文件夹，不修改程序文件或 `app.asar`，也不禁用 TLS 校验。换服务器不会沿用另一个服务器的登录会话。内网测试仍需按前节手动导入自己服务器的 CA。

安装包未做代码签名。若安全软件阻止，请保留报告排查或使用正式签名流程，不要关闭保护或添加整盘排除。

## 5. 数据和维护

- PostgreSQL 数据位于 `postgres-data` 卷；原始文件位于 `chat-files` 卷。单文件 100 MiB，总文件容量 10 GiB。
- Caddy 证书位于 `caddy-data` 卷；不要丢弃，否则需要重新申请证书。
- `docker compose stop` 保留数据；`docker compose down` 也保留命名卷。**不要用 `down -v`，它会删除数据。**
- 备份时先停止写入，备份 PostgreSQL 和聊天文件同一时间点的数据；恢复时一起恢复。不要只备份数据库。
- 更新 API 前备份数据，替换 `api.jar` 后运行 `docker compose up -d --build api`。数据库迁移不能通过替换旧 JAR 自动回滚。
- 在登录页保存的服务器地址位于安装目录的 `data` 文件夹，更新安装包不会覆盖；未自行选择时使用新包的默认地址。

升级账号生命周期功能时先备份数据库，再更新 API 执行 V19。迁移增加注销时间、服主恢复密码哈希和待确认交接信息，不删除已有资料；最后更新客户端。服主转让由接任者确认，旧恢复密码和未使用的账号链接随之失效。注销永久停用登录，但保留公开身份与历史；请勿通过删除用户行来模拟注销。

## 6. 首轮验收

物理主机及 Windows VM 各安装一个客户端：服主激活 → 邀请加入、跳过/保存资料 → 换电脑恢复登录与旧会话失效 → 同群聊天、图片和文件 → 双向语音 → 屏幕共享与共享声音 → 重复开关、退出重入 → 30 分钟持续运行。VM 的虚拟声卡、显卡和硬件编码能力与真实设备不同；音质和高帧率最终还需真实设备验收。

部署包的实际内容和验证记录以对应发布批次为准，打包成功不代表已在 Linux、安装版或真实媒体设备上验收。Windows 10/11 的黄色边框、进程音频及设备兼容限制仍以当前实现和实际系统为准；NSIS 安装不会自动获得 MSIX 的系统能力声明。
