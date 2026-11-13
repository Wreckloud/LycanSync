# RNNoise 固定来源

来自 OBS Studio 32.2.2 官方源码归档的 plugins/obs-filters/rnnoise。与本项目 2026-11-12 三轮离线试听所用实现相同，使用内置默认模型，不下载模型、不调用 GPU。

上游归档地址和 SHA-256 见 ../../sources.lock.json 中 OBS source 条目。此目录保留编译所需 C 源码、头文件及原始 COPYING/AUTHORS，不修改上游实现。NOTICES.txt 汇总原文件头的版权和许可，随二进制一同交付。RNNoise 仅负责降噪，后续增益、高通和限幅仍由 Sonora 持有。
