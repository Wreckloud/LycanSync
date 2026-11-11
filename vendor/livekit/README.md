# 固定的 LiveKit 配套修复

0.4.13 使用已验收的上游提交：

- 客户端：[client-sdk-js 1ca3298](https://github.com/livekit/client-sdk-js/commit/1ca329862a0ca62db82147ad11bf751c570b406b)，包含 [#2221](https://github.com/livekit/client-sdk-js/pull/2221)。
- 服务端：[livekit 0d762b4](https://github.com/livekit/livekit/commit/0d762b4e5062c4407712fef74f473dbc5a16cfac)，包含 [#5122](https://github.com/livekit/livekit/pull/5122)。

包内版本仍是 2.23.0 / 1.13.11，不能据此替换为同名发行版。SDK 仅在服务端协议至少为 19 时停止已取消发布的 transceiver；服务端配套修复防止复用时错误匹配媒体。升级先部署服务端，再发布客户端。后续官方版本包含两项修复并通过回归后，统一替换并移除此目录，不保留双实现。

`provenance.json` 固定源码归档、SDK 安装包、SDK ESM 和 Linux amd64 服务端的 SHA-256。SDK 安装包纳入 Git，npm lock 同时锁定其完整性。服务端二进制放在忽略的 `release/livekit/livekit-server`，部署打包时验证后收入 ZIP。

## 重建

从 `https://codeload.github.com/livekit/client-sdk-js/tar.gz/<sdkCommit>` 和 `https://codeload.github.com/livekit/livekit/tar.gz/<serverCommit>` 下载源码，先对照 provenance 校验归档。

SDK 使用 Node 22.22.3、pnpm 10.34.7 和上游冻结锁文件。Windows 上应用 `sdk-windows-build.patch`，只修正 Rollup 对绝对路径的判断，不修改运行逻辑。运行 `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm pack`；核对生成的 `dist/livekit-client.esm.mjs` 与安装包校验值。归档的文件时间可能使重新打包后的 tgz 校验值不同，不能直接更新校验值跳过审查，需比较实际内容。

服务端使用 Go 1.27.3；进入已校验源码目录，执行：

```sh
export GOTOOLCHAIN=local GOMAXPROCS=1 GOMEMLIMIT=850MiB
test "$(go env GOVERSION)" = go1.27.3
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -mod=readonly -p=1 -trimpath -o livekit-server ./cmd/server
sha256sum livekit-server
```

保留默认模块校验数据库；不得修改 go.mod/go.sum 以绕过校验。将匹配的二进制放入上述 release 路径，再运行 `deploy/package-server.ps1`。部署包的 `livekit/` 包含固定 Alpine 基础镜像的 Dockerfile、校验过的二进制、上游许可证与 provenance。运行 `docker compose build livekit` 构建配套镜像；不要沿用旧 VM override 中的 1.13.6 镜像。

验收覆盖重复共享、录制、即时回放、换源、重连、离房及 30 分钟多人显示；不代表真实麦克风、外网弱网或所有游戏场景已验收。
