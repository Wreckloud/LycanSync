# 离线语音处理验证

这里测试的是 OBS 麦克风滤镜实际调用的 Rust FFI。无需声卡、虚拟麦克风或朋友入房；工具不播放、不采集、不联网，也不进入安装包。

发送端先使用随源静态编译的 RNNoise（OBS 32.2.2 内置默认模型），再使用 Sonora 0.2.0 的低频过滤和温和自动增益，最后应用用户音量和限幅。Sonora 自身降噪已移除，不叠加两层降噪。自动增益从 0 dB 开始，上限 6 dB，每秒变化不超过 1 dB；并非固定放大 6 dB。用户音量在一个 10 ms 块内渐变，设为零立即按零处理。最终限幅复用同版本 `sonora-agc2`，预留输出峰值空间，不额外增加音频块延迟。关闭自动增益仍保留最终限幅；这不能修复进入软件之前已发生的硬件失真。

## 重复测试

启用回声消除时，AEC3 在 RNNoise 之前处理麦克风；输入参考来自所选播放设备的 WASAPI loopback，仅存在于麦克风宿主，不发布或录制。默认输出跟随系统默认端点；指定输出按完整设备名唯一匹配，重名或不可用时明确提示，保留麦克风和降噪。换设备、参考断流会清除旧 AEC 状态。是否能抑制真实扬声器回声仍须实机验证。

`offline_voice` 可在原有六个参数之后传入等长的 48 kHz mono f32 播放参考文件；参考与麦克风按相同时钟提交，额外声学延迟应写入测试素材。工具不采集任何设备。启用 AEC 时仍移除适配器与 RNNoise 的 960 帧基础延迟，但 AEC 自身另有算法延迟，输出 `processingDelayFrames: null`，比较声音必须再次测量对齐，不能继续按总共 20 ms 解释。AEC 和 RNNoise 调用均临时启用 x64 FTZ / DAZ，返回时恢复线程原有浮点模式。

Windows 需已有 Visual Studio C++ Build Tools，并在其 x64 开发者环境中执行；RNNoise 的 C 源码随包构建，无需额外运行时、模型下载或 GPU。

在仓库根目录执行：

```powershell
cargo test --release --offline --locked --manifest-path native/obs-capture-host/audio-processing/Cargo.toml --target-dir release/test-cache/voice-evaluation/build
cargo build --release --offline --locked --manifest-path native/obs-capture-host/audio-processing/Cargo.toml --example offline_voice --target-dir release/test-cache/voice-evaluation/build
python native/obs-capture-host/audio-processing/evaluate.py --processor release/test-cache/voice-evaluation/build/release/examples/offline_voice.exe --speech YOUR-SPEECH.wav --output release/test-cache/voice-evaluation/new-run
```

输入语音必须是获准使用的 48 kHz、单声道、16-bit PCM WAV，时长不超过 60 秒。输出目录必须不存在，避免覆盖旧证据。可使用系统文字转语音生成 WAV；合成语音只用于流程与电平验证，不视作真实人声质量验收。

输出包含五组输入／输出 WAV、无损 f32 中间文件和 `report.json`：

- 过载正弦：检查增益放大后的峰值、平顶和稳态基频残差。
- 正常语音：关闭可选处理，检查低于限幅区的样本误差。
- 语音电平变化：同一句话依次低声、正常、很响、恢复正常；不是对真实喊叫音色的模拟。
- 语音混合固定种子的噪声：用于前后对照，不代表键盘、混响或远处人声。
- 纯噪声：检查没有人声时的输出电平。

修改前后对同一输入运行，分别保留结果。试听时保持系统音量一致，不自动归一化每段音频。报告中的稳态正弦残差是合成信号指标，不是语音质量评分。`fullScaleSamples` 不能单独证明无失真，须结合平顶、基频残差和试听。所有保存文件已排出并移除 960 帧固定延迟：FFI 适配器 480 帧、RNNoise 480 帧，使输入／输出对齐。该 20 ms 不是完整通话延迟。降噪关闭时干声也延迟 480 帧；模型保持处理历史，切换在 10 ms 内交叉淡化，不重启采集。代价是麦克风采集期间，即使关闭降噪也有模型计算开销；停止采集后销毁实例。x64 降噪调用临时启用 FTZ / DAZ，避免静音后的极小浮点残值拖慢计算，返回时恢复线程原有模式。

处理耗时包括正式 FFI 分块，排除文件读写；平均／尾部耗时都应在同负载下比较，不能等同游戏中的 CPU 占用或端到端延迟。默认算法沿用已试听的候选，温和增益避免原默认初始放大；真实人声、键盘声及游戏负载仍待授权实机验收，不能凭合成噪声的衰减量宣称真实体验已通过。

后续可以独自使用客户端已有“麦克风试听”，验证真实采集和本机 Opus 编解码；需耳机避免外放回收。朋友联机仍用于检查网络、两端设备和多人同时讲话，离线通过不能替代这些验收。
