package com.lycansync.api.chat.service;

import com.lycansync.api.audio.config.AudioProcessingProperties;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/**
 * 生成聊天下载文件或兼容预览，两条入口共用有限的编码资源。
 *
 * @author Wreckloud
 * @since 2026-11-20
 */
@Component
@RequiredArgsConstructor
public class ChatVideoEncoder {
    private final AudioProcessingProperties properties;
    private final Semaphore slot = new Semaphore(1, true);

    void encode(Path source, String format, Path output, long maxBytes, boolean preview)
            throws IOException, InterruptedException {
        if (!slot.tryAcquire(20, TimeUnit.SECONDS)) throw new IOException("encoder-busy");
        Process encoder = null;
        long started = System.nanoTime();
        int width = preview ? 1280 : 1920;
        int height = preview ? 720 : 1080;
        Duration timeout = Duration.ofMinutes(preview ? 5 : 15);
        try {
            ProcessBuilder builder = new ProcessBuilder(List.of(properties.getFfmpegExecutable(), "-nostdin", "-xerror",
                    "-hide_banner", "-loglevel", "error", "-max_alloc", "67108864", "-threads", "1",
                    "-filter_threads", "1", "-protocol_whitelist", "file", "-f", ChatFileMediaService.inputFormat(source, format), "-i", source.toString(),
                    "-map", "0:v:0", "-map", preview ? "0:a:0?" : "0:a?", "-sn", "-dn", "-map_metadata", "-1",
                    "-vf", "scale=w='min(" + width + ",iw)':h='min(" + height + ",ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
                    "-fpsmax", preview ? "30" : "60", "-c:v", "libx264", "-preset", "veryfast", "-crf", preview ? "25" : "23", "-pix_fmt", "yuv420p",
                    "-threads", "1", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart",
                    "-f", "mp4", output.toString()))
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD);
            builder.environment().clear();
            if (System.getenv("SystemRoot") != null) builder.environment().put("SystemRoot", System.getenv("SystemRoot"));
            encoder = builder.start();
            while (!encoder.waitFor(1, TimeUnit.SECONDS)) {
                if (System.nanoTime() - started > timeout.toNanos()) {
                    throw new IOException("timeout");
                }
                // 不使用 -fs 截断视频，避免把只转换了一半的内容当成成功。
                if (Files.exists(output) && Files.size(output) > maxBytes) throw new IOException("size-limit");
            }
            if (encoder.exitValue() != 0 || !Files.isRegularFile(output)
                    || Files.size(output) == 0) throw new IOException("encode-failed");
            if (Files.size(output) > maxBytes) throw new IOException("size-limit");
        } finally {
            if (encoder != null && encoder.isAlive()) {
                encoder.destroyForcibly();
                try { encoder.waitFor(2, TimeUnit.SECONDS); }
                catch (InterruptedException exception) { Thread.currentThread().interrupt(); }
            }
            slot.release();
        }
    }
}
