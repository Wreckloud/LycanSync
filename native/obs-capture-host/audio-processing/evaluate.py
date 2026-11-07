"""离线验证正式语音处理器；只读写文件，不播放、采集或连接网络。"""

import argparse
import array
import json
import math
from pathlib import Path
import random
import subprocess
import sys
import wave

RATE = 48000


def write_pcm(path, samples):
    pcm = array.array('f', samples)
    if sys.byteorder != 'little':
        pcm.byteswap()
    with path.open('xb') as output:
        pcm.tofile(output)


def read_pcm(path):
    pcm = array.array('f')
    pcm.frombytes(path.read_bytes())
    if sys.byteorder != 'little':
        pcm.byteswap()
    return list(pcm)


def write_wav(path, samples):
    pcm = array.array('h', (round(max(-1, min(1, sample)) * 32767) for sample in samples))
    if sys.byteorder != 'little':
        pcm.byteswap()
    with wave.open(str(path), 'wb') as output:
        output.setparams((1, 2, RATE, 0, 'NONE', 'not compressed'))
        output.writeframes(pcm.tobytes())


def tone_residual(samples):
    # 整周期稳态正弦：去除基频后测残差，避免把正常音量变化误判为失真。
    segment = samples[-RATE:]
    sine = [math.sin(2 * math.pi * 500 * i / RATE) for i in range(len(segment))]
    cosine = [math.cos(2 * math.pi * 500 * i / RATE) for i in range(len(segment))]
    a = 2 * sum(x * y for x, y in zip(segment, sine)) / len(segment)
    b = 2 * sum(x * y for x, y in zip(segment, cosine)) / len(segment)
    residual = sum((x - a * s - b * c) ** 2 for x, s, c in zip(segment, sine, cosine))
    fundamental = len(segment) * (a * a + b * b) / 2
    if not fundamental:
        raise ValueError('正弦输出静音，不能报告失真改善')
    return math.sqrt(residual / fundamental)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--processor', type=Path, required=True)
    parser.add_argument('--speech', type=Path, required=True, help='48kHz、单声道、16-bit PCM WAV，最多 60 秒')
    parser.add_argument('--output', type=Path, required=True, help='必须是不存在的新目录')
    args = parser.parse_args()
    with wave.open(str(args.speech), 'rb') as source:
        if (source.getnchannels(), source.getsampwidth(), source.getframerate(), source.getcomptype()) != (1, 2, RATE, 'NONE'):
            raise ValueError('语音必须为 48kHz 单声道 16-bit PCM WAV')
        if not 0 < source.getnframes() <= RATE * 60:
            raise ValueError('语音必须为 0–60 秒的非空文件')
        pcm = array.array('h', source.readframes(source.getnframes()))
    if sys.byteorder != 'little':
        pcm.byteswap()
    peak = max(abs(sample) for sample in pcm)
    if not peak:
        raise ValueError('语音输入完全静音')
    speech = [sample / peak for sample in pcm]
    random_generator = random.Random(20261107)
    noise = [random_generator.uniform(-0.025, 0.025) for _ in range(len(speech))]
    # 同一句合成/授权语音重复三档电平；不能视作真实喊叫或空间混响。
    levels = [0.0] * (RATE // 2)
    for amplitude in (0.025, 0.2, 0.95, 0.2):
        levels.extend(sample * amplitude for sample in speech)
        levels.extend([0.0] * (RATE // 2))
    tone = [0.8 * math.sin(2 * math.pi * 500 * i / RATE) for i in range(RATE * 3)]
    cases = [
        ('overload-tone', tone, (2, 0, 0, 0)),
        ('normal-speech', [sample * 0.2 for sample in speech], (1, 0, 0, 0)),
        ('speech-levels', levels, (2, 1, 1, 1)),
        ('speech-noise', [sample * 0.2 + hiss for sample, hiss in zip(speech, noise)], (1, 1, 1, 1)),
        ('noise-only', noise, (1, 1, 1, 1)),
    ]
    args.output.mkdir(parents=True, exist_ok=False)
    results = []
    for name, samples, settings in cases:
        input_path = args.output / f'{name}-input.f32'
        output_path = args.output / f'{name}-output.f32'
        write_pcm(input_path, samples)
        completed = subprocess.run([str(args.processor.resolve()), str(input_path), str(output_path),
                                    *(str(value) for value in settings)], check=True, capture_output=True, text=True)
        result = json.loads(completed.stdout)
        processed = read_pcm(output_path)
        if len(processed) != len(samples):
            raise ValueError('处理前后采样数量不一致')
        write_wav(args.output / f'{name}-input.wav', samples)
        write_wav(args.output / f'{name}-output.wav', processed)
        result.update(case=name, settings=settings, durationSeconds=len(samples) / RATE)
        if name == 'overload-tone':
            result['steadyToneResidualRatio'] = tone_residual(processed)
        if name == 'normal-speech':
            result['maximumSampleError'] = max(abs(x - y) for x, y in zip(samples, processed))
        results.append(result)
    report = {'sampleRate': RATE, 'realMicrophoneTested': False, 'networkTested': False, 'results': results}
    (args.output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
