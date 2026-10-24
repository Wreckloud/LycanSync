# OBS 对应源码与构建材料

本包对应同版本 LycanSync Windows x64 安装包的 OBS 32.2.2 采集组件，不包含账号、服务器配置、设备记录或画面。
`source-materials.json` 列出固定归档、来源、版本、SHA-256 和自有源码文件；`runtime-build-manifest.json` 记录对应的运行文件哈希及静态依赖检查，不代表实机或性能验收。

## 重建 LycanSync 宿主、插件与 DXGI 图形模块

需要 Windows x64、已有的 Visual Studio C++ Build Tools、Windows SDK、Git 与 CMake（使用 Visual Studio 自带版本）。不需要安装或运行 OBS。

在本包根目录执行：

```powershell
./native/obs-capture-host/build.ps1
```

脚本使用已包含的官方 OBS 源码和 Windows 依赖 SDK，按固定 SHA-256 下载官方 OBS 运行 ZIP，生成真实 DLL 的导入库，然后从原始源码应用本包补丁并构建宿主、win-capture、win-wasapi 和 libobs-d3d11。网络受限时可自行从 `build.ps1` 中的官方地址下载对应运行 ZIP，校验后放入 `release/build-cache/obs-32.2.2/downloads`，再加 `-Offline` 构建。已有 OBS 安装不被替换，也不会在构建中初始化插件或设备。

## 官方组件与依赖

完整原始源码归档保留在 `release/build-cache/obs-32.2.2`，不以裁剪后的头文件目录代替源码。官方 OBS 源码包含 libobs、图形后端、WinRT、钩子与注入工具的原始构建脚本。完整 obs-deps 固定提交归档包含第三方依赖的 Windows 配置、补丁、校验文件和构建入口；其 `Build-Dependencies.ps1` 需要 PowerShell 7.2+ 及上游注明的工具。对应的各依赖源码另附在 `corresponding-source`，MbedTLS framework 子模块按父提交固定的 revision 单独提供，重建时解入 MbedTLS 的 `framework` 目录。

OBS 官方构建步骤见其原始源码的 `.github/scripts`、CMake 文件及上游构建文档。上游依赖脚本默认从网络检出固定提交；本包同时保留这些对应源文件供离线检查或重建，不修改上游脚本冒充其官方发布流程。Vulkan-Headers 为所用 SDK 同版本头文件；系统 Vulkan/D3D/Windows 库和 Visual Studio 工具由各自供应方提供。

本项目重建宿主、精确窗口／声音绑定插件和 DXGI 图形模块。`dxgi-output-compat.patch` 只在 DuplicateOutput1 明确返回 DXGI_ERROR_UNSUPPORTED 时使用 OBS 已有的 DuplicateOutput 分支；不切换 WGC，不降低分辨率或帧率。其余 DLL、官方图形钩子和注入工具使用经过校验的原始发布二进制。提供其对应源码和原始构建材料，不宣称本机已经重建全部上游二进制或做到字节一致。

## 许可证与边界

`native/obs-capture-host` 自有部分按 GPL-2.0-or-later；OBS 和各依赖保留其版权及许可证。固定 FFmpeg 构建启用 GPL 与 version3，相关 GPL v3 文本在其完整源码和安装包许可证中提供。未更改 LycanSync 其他目录的授权声明。

正式下载目录应同时提供此版本源码包、安装包、blockmap 与第三方许可文本，源码包不能被下一版覆盖。源码编译、静态依赖和打包核验不等于真实设备、反作弊兼容性、音画同步或性能验收。
