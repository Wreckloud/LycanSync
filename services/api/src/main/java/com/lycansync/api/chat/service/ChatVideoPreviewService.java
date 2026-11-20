package com.lycansync.api.chat.service;

import com.lycansync.api.audio.config.AudioProcessingProperties;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.dto.ChatVideoPreviewResponse;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.group.exception.GroupException;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.FileTime;
import java.time.Duration;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 用户主动请求的兼容视频缓存；单任务转换，不占用上传事务，也不覆盖原文件。
 *
 * @author Wreckloud
 * @since 2026-11-15
 */
@Service
@Slf4j
public class ChatVideoPreviewService {
    private static final long MAX_OUTPUT_BYTES = 128L * 1024 * 1024;
    private static final long CACHE_BYTES = 512L * 1024 * 1024;
    private static final long EXPIRES_MILLIS = Duration.ofDays(7).toMillis();
    private static final long RECENT_MILLIS = Duration.ofMinutes(15).toMillis();
    private final ChatFileService files;
    private final AudioProcessingProperties properties;
    private final ChatVideoEncoder encoder;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "chat-video-preview");
        thread.setDaemon(true);
        return thread;
    });
    private final Map<UUID, ChatVideoPreviewResponse> results = new LinkedHashMap<>();
    private UUID running;

    public ChatVideoPreviewService(ChatFileService files, AudioProcessingProperties properties, ChatVideoEncoder encoder) {
        this.encoder = encoder;
        this.files = files;
        this.properties = properties;
    }

    public synchronized ChatVideoPreviewResponse status(UUID group, UUID attachment, AuthenticatedUser user) {
        authorize(group, attachment, user);
        if (Files.isRegularFile(output(attachment))) return response("ready", null);
        var result = results.get(attachment);
        return result == null || result.status().equals("ready") ? response("absent", null) : result;
    }

    public synchronized ChatVideoPreviewResponse prepare(UUID group, UUID attachment, AuthenticatedUser user) {
        String format = authorize(group, attachment, user);
        if (Files.isRegularFile(output(attachment))) return response("ready", null);
        if (attachment.equals(running)) return response("processing", null);
        if (running != null || worker.isShutdown()) {
            throw failure(HttpStatus.TOO_MANY_REQUESTS, "服务器正在转换其他视频，请稍后再试。");
        }
        try {
            Path source = files.findFile(attachment).getFile().toPath();
            Files.createDirectories(directory());
            prune(MAX_OUTPUT_BYTES);
            if (Files.getFileStore(directory()).getUsableSpace() < MAX_OUTPUT_BYTES) {
                throw failure(HttpStatus.INSUFFICIENT_STORAGE, "服务器空间不足，暂时无法转换视频。可以下载原文件。");
            }
            running = attachment;
            remember(attachment, response("processing", null));
            worker.execute(() -> convert(attachment, source, format));
            return response("processing", null);
        } catch (IOException exception) {
            throw failure(HttpStatus.SERVICE_UNAVAILABLE, "视频预览缓存不可用，请稍后重试。");
        }
    }

    public synchronized Resource find(UUID group, UUID attachment, AuthenticatedUser user) {
        authorize(group, attachment, user);
        Path output = output(attachment);
        if (!Files.isRegularFile(output)) throw failure(HttpStatus.NOT_FOUND, "兼容预览已清理，请重新转换。");
        try { Files.setLastModifiedTime(output, FileTime.fromMillis(System.currentTimeMillis())); }
        catch (IOException exception) { throw failure(HttpStatus.SERVICE_UNAVAILABLE, "暂时无法读取兼容预览，请重试。"); }
        return new FileSystemResource(output);
    }

    private String authorize(UUID group, UUID attachment, AuthenticatedUser user) {
        var metadata = files.findMetadata(group, attachment, user);
        String format = ChatFileMediaService.videoFormat(metadata.fileName());
        if (format == null) throw failure(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "这个文件暂不支持转换，可以下载后打开。");
        return format;
    }

    private void convert(UUID attachment, Path source, String format) {
        Path partial = directory().resolve(attachment + ".part");
        ChatVideoPreviewResponse result;
        long started = System.nanoTime();
        try {
            Files.deleteIfExists(partial);
            encoder.encode(source, format, partial, MAX_OUTPUT_BYTES, true);
            Files.move(partial, output(attachment), StandardCopyOption.ATOMIC_MOVE);
            result = response("ready", null);
            log.info("聊天视频兼容预览完成 attachmentId={} elapsedMs={}", attachment,
                    TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started));
        } catch (IOException | InterruptedException | RuntimeException exception) {
            if (exception instanceof InterruptedException) Thread.currentThread().interrupt();
            log.warn("聊天视频兼容预览失败 attachmentId={} reason={}", attachment, exception.getClass().getSimpleName());
            result = response("failed", "视频转换未能完成，可能超出处理限制或编码不受支持。可以重试或下载原文件。");
        } finally {
            try { Files.deleteIfExists(partial); }
            catch (IOException exception) { log.warn("聊天视频转换临时文件清理失败 attachmentId={}", attachment); }
        }
        synchronized (this) {
            remember(attachment, result);
            running = null;
        }
    }

    @Scheduled(fixedDelay = 3600000, initialDelay = 60000)
    public synchronized void cleanExpired() {
        if (!Files.isDirectory(directory())) return;
        try { prune(0); }
        catch (IOException | GroupException exception) { log.warn("聊天视频预览缓存清理失败"); }
    }

    private void prune(long reserve) throws IOException {
        long now = System.currentTimeMillis();
        try (var entries = Files.list(directory())) {
            var paths = entries.filter(path -> path.getFileName().toString().matches("[0-9a-f-]{36}\\.(mp4|part)"))
                    .sorted(Comparator.comparingLong(path -> path.toFile().lastModified())).toList();
            long total = 0;
            for (Path path : paths) {
                if (running != null && path.equals(directory().resolve(running + ".part"))) continue;
                if (path.toString().endsWith(".part") || now - Files.getLastModifiedTime(path).toMillis() > EXPIRES_MILLIS) {
                    Files.deleteIfExists(path);
                } else { total += Files.size(path); }
            }
            for (Path path : paths) {
                if (total + reserve <= CACHE_BYTES) break;
                if (!path.toString().endsWith(".mp4") || !Files.exists(path)
                        || now - Files.getLastModifiedTime(path).toMillis() < RECENT_MILLIS) continue;
                total -= Files.size(path);
                Files.delete(path);
            }
            if (total + reserve > CACHE_BYTES) throw failure(HttpStatus.INSUFFICIENT_STORAGE,
                    "视频预览缓存暂时已满，请稍后重试或下载原文件。");
        }
    }

    private void remember(UUID attachment, ChatVideoPreviewResponse result) {
        results.put(attachment, result);
        while (results.size() > 128) results.remove(results.keySet().iterator().next());
    }

    private Path directory() { return properties.getProcessingDirectory().toAbsolutePath().normalize().resolve("chat-video-previews-v1"); }
    private Path output(UUID attachment) { return directory().resolve(attachment + ".mp4"); }
    private static ChatVideoPreviewResponse response(String status, String message) { return new ChatVideoPreviewResponse(status, message); }
    private static GroupException failure(HttpStatus status, String message) {
        return new GroupException(status, ApiErrorCode.CHAT_FILE_STORAGE_FAILED, message);
    }

    @PreDestroy
    public void close() {
        synchronized (this) { worker.shutdownNow(); }
        try {
            if (!worker.awaitTermination(3, TimeUnit.SECONDS)) log.warn("聊天视频转换进程仍在结束中");
        } catch (InterruptedException exception) { Thread.currentThread().interrupt(); }
    }
}
