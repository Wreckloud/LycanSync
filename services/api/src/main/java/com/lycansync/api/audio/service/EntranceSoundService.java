package com.lycansync.api.audio.service;

import com.lycansync.api.audio.config.AudioProcessingProperties;
import com.lycansync.api.audio.exception.AudioProcessingException;
import com.lycansync.api.common.error.ApiErrorCode;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/**
 * 限时解码入场音效，统一为有峰值与增益上限的单声道 WAV。
 *
 * @author Wreckloud
 * @since 2026-10-30
 */
@Service
@Slf4j
public class EntranceSoundService {

    public static final int MAX_INPUT_BYTES = 512 * 1024;
    private static final int SAMPLE_RATE = 48_000;
    private static final int MAX_PCM_BYTES = SAMPLE_RATE * 2 * 5;
    private static final int DECODE_LIMIT_BYTES = MAX_PCM_BYTES + SAMPLE_RATE;
    private final AudioProcessingProperties properties;
    private final Semaphore processing = new Semaphore(1);

    public EntranceSoundService(AudioProcessingProperties properties) {
        this.properties = properties;
    }

    public byte[] normalize(InputStream input) {
        if (!processing.tryAcquire()) {
            throw new AudioProcessingException(HttpStatus.TOO_MANY_REQUESTS, ApiErrorCode.AUDIO_PROCESSING_BUSY,
                    "服务器正在处理另一段音效，请稍后重试");
        }
        Path directory = null;
        Process decoder = null;
        try {
            byte[] uploaded = input.readNBytes(MAX_INPUT_BYTES + 1);
            if (uploaded.length > MAX_INPUT_BYTES) {
                throw new AudioProcessingException(HttpStatus.PAYLOAD_TOO_LARGE, ApiErrorCode.INVALID_REQUEST,
                        "入场音效不能超过 512 KB");
            }
            String format = inputFormat(uploaded);
            Path parent = properties.getProcessingDirectory().toAbsolutePath().normalize();
            Files.createDirectories(parent);
            directory = Files.createTempDirectory(parent, "entrance-");
            Path source = directory.resolve("source");
            Path decoded = directory.resolve("decoded.pcm");
            Files.write(source, uploaded);
            // 格式由文件头限定；解码器只能读取当前本地文件，不接受播放列表、URL 或网络协议。
            ProcessBuilder builder = new ProcessBuilder(List.of(properties.getFfmpegExecutable(), "-nostdin", "-hide_banner",
                    "-loglevel", "error", "-max_alloc", "16777216", "-threads", "1", "-filter_threads", "1",
                    "-protocol_whitelist", "file", "-f", format, "-i", source.toString(),
                    "-map", "0:a:0", "-vn", "-sn", "-dn", "-t", "5.5", "-ac", "1", "-ar", "48000",
                    "-c:a", "pcm_s16le", "-f", "s16le", "-fs", String.valueOf(DECODE_LIMIT_BYTES), decoded.toString()))
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD);
            // 解码子进程不继承 API 的数据库和媒体凭据。
            builder.environment().clear();
            if (System.getenv("SystemRoot") != null) builder.environment().put("SystemRoot", System.getenv("SystemRoot"));
            decoder = builder.start();
            if (!decoder.waitFor(8, TimeUnit.SECONDS)) {
                throw new AudioProcessingException(HttpStatus.UNPROCESSABLE_ENTITY, ApiErrorCode.INVALID_REQUEST,
                        "音效处理超时。");
            }
            if (decoder.exitValue() != 0 || !Files.exists(decoded)) throw invalidAudio();
            long size = Files.size(decoded);
            if (size > MAX_PCM_BYTES) {
                throw new AudioProcessingException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST,
                        "入场音效不能超过 5 秒");
            }
            if (size < 2 || size % 2 != 0) throw invalidAudio();
            return normalizePcm(Files.readAllBytes(decoded));
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw unavailable();
        } catch (IOException exception) {
            log.warn("入场音效处理工具或目录不可用");
            throw unavailable();
        } finally {
            if (decoder != null && decoder.isAlive()) {
                decoder.destroyForcibly();
                try { decoder.waitFor(2, TimeUnit.SECONDS); }
                catch (InterruptedException exception) { Thread.currentThread().interrupt(); }
            }
            if (directory != null) {
                for (Path file : List.of(directory.resolve("source"), directory.resolve("decoded.pcm"), directory)) {
                    try { Files.deleteIfExists(file); }
                    catch (IOException exception) { log.warn("入场音效临时文件清理失败"); }
                }
            }
            processing.release();
        }
    }

    private String inputFormat(byte[] bytes) {
        if (bytes.length < 12) throw invalidAudio();
        if (matches(bytes, 0, "RIFF") && matches(bytes, 8, "WAVE")) return "wav";
        if (matches(bytes, 0, "OggS")) return "ogg";
        if (matches(bytes, 0, "ID3") || ((bytes[0] & 0xff) == 0xff && (bytes[1] & 0xe0) == 0xe0)) return "mp3";
        if ((bytes[0] & 0xff) == 0x1a && (bytes[1] & 0xff) == 0x45
                && (bytes[2] & 0xff) == 0xdf && (bytes[3] & 0xff) == 0xa3) return "matroska";
        throw invalidAudio();
    }

    private boolean matches(byte[] bytes, int offset, String text) {
        return new String(bytes, offset, text.length(), StandardCharsets.US_ASCII).equals(text);
    }

    static byte[] normalizePcm(byte[] pcm) {
        ByteBuffer input = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN);
        int samples = pcm.length / 2;
        double squared = 0;
        int peak = 0;
        for (int index = 0; index < samples; index++) {
            int sample = input.getShort();
            squared += (double) sample * sample;
            peak = Math.max(peak, Math.abs(sample));
        }
        double rms = Math.sqrt(squared / samples);
        // 统一能量而非每段拉满峰值：目标约 -23 dBFS RMS、峰值不超过 -6 dBFS，最多放大 12 dB。
        double gain = rms < 1 ? 1 : Math.min(4, Math.min(2320 / rms, 16422.0 / peak));
        ByteBuffer output = ByteBuffer.allocate(44 + pcm.length).order(ByteOrder.LITTLE_ENDIAN);
        output.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + pcm.length);
        output.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1);
        output.putInt(SAMPLE_RATE).putInt(SAMPLE_RATE * 2).putShort((short) 2).putShort((short) 16);
        output.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(pcm.length);
        input.rewind();
        for (int index = 0; index < samples; index++) output.putShort((short) Math.round(input.getShort() * gain));
        return output.array();
    }

    private AudioProcessingException invalidAudio() {
        return new AudioProcessingException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST,
                "无法读取这段音效，请使用 MP3、OGG、WAV 或 WebM 音频。");
    }

    private AudioProcessingException unavailable() {
        return new AudioProcessingException(HttpStatus.SERVICE_UNAVAILABLE, ApiErrorCode.AUDIO_PROCESSING_UNAVAILABLE,
                "服务器音效处理暂不可用，请稍后重试");
    }
}
