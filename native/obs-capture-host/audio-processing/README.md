# 离线语音处理验证

这里测试的是 OBS 麦克风滤镜实际调用的 Rust FFI。无需声卡、虚拟麦克风或朋友入房；工具不播放、不采集、不联网，也不进入安装包。

发送端依次使用现有 Sonora 降噪／自动增益／低频过滤，再应用用户音量和最终限幅。用户音量在一个 10 ms 块内渐变，设为零立即按零处理。最终限幅复用同版本 `sonora-agc2`，预留输出峰值空间，不额外增加音频块延迟。关闭自动增益仍保留最终限幅；这不能修复进入软件之前已发生的硬件失真。

## 重复测试

在仓库根目录执行：

```powershell
cargo test --offline --locked --manifest-path native/obs-capture-host/audio-processing/Cargo.toml --target-dir release/test-cache/voice-evaluation/build
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

修改前后对同一输入运行，分别保留结果。试听时保持系统音量一致，不自动归一化每段音频。报告中的稳态正弦残差是合成信号指标，不是语音质量评分。`fullScaleSamples` 不能单独证明无失真，须结合平顶、基频残差和试听。所有保存文件已排出并移除 FFI 的 480 帧适配延迟，使输入／输出对齐；该 10 ms 仅是适配器延迟，不是完整通话延迟。

处理耗时包括正式 FFI 分块，排除文件读写；平均／尾部耗时都应在同负载下比较，不能等同游戏中的 CPU 占用或端到端延迟。降噪强度、AGC 目标和算法切换需使用真实授权人声验证，不能凭合成噪声的衰减量直接更改默认值。

后续可以独自使用客户端已有“麦克风试听”，验证真实采集和本机 Opus 编解码；需耳机避免外放回收。朋友联机仍用于检查网络、两端设备和多人同时讲话，离线通过不能替代这些验收。
