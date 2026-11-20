package com.lycansync.api.chat.service;

import com.lycansync.api.audio.config.AudioProcessingProperties;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.dto.ChatMessageResponse;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.group.exception.GroupException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/**
 * 群聊音视频预览类型与按需封面，限制解码并发及缓存占用，不修改原文件。
 *
 * @author Wreckloud
 * @since 2026-11-15
 */
@Service
@Slf4j
public class ChatFileMediaService {

    private static final int MAX_THUMBNAIL_BYTES = 256 * 1024;
    private static final int CACHE_BYTES = 8 * 1024 * 1024;
    private final ChatFileService files;
    private final AudioProcessingProperties properties;
    private final Semaphore processing = new Semaphore(1, true);
    private final Map<String, byte[]> thumbnails = new LinkedHashMap<>(16, 0.75f, true);
    private int cachedBytes;

    public ChatFileMediaService(ChatFileService files, AudioProcessingProperties properties) {
        this.files = files;
        this.properties = properties;
    }

    public ChatMessageResponse declare(UUID groupId, AuthenticatedUser user, UUID messageId, UUID attemptId,
                                       String encodedName, long size, String content, byte[] cover) {
        if (cover != null) {
            try {
                ChatImageValidator.validate(cover, "image/jpeg", 240L * 136);
            } catch (ChatImageValidator.InvalidImageException exception) {
                throw new GroupException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST, exception.getMessage());
            }
        }
        ChatMessageResponse message = files.declare(groupId, user, messageId, attemptId, encodedName, size, content);
        if (cover != null && message.attachment().transferStatus() != null && videoFormat(message.attachment().fileName()) != null) {
            remember("pending:" + messageId, cover);
        }
        return message;
    }

    public byte[] pendingThumbnail(UUID groupId, UUID messageId, AuthenticatedUser user) {
        // 上传登记也属于群消息；先验证群成员和消息归属，再读取临时封面。
        var messages = files.deliveries(groupId, user, List.of(messageId));
        return messages.isEmpty() ? null : cached("pending:" + messageId);
    }

    public byte[] findThumbnail(UUID groupId, UUID attachmentId, AuthenticatedUser user) {
        // 即使缓存命中，也先核对当前群成员资格与附件是否仍然存在。
        var metadata = files.findMetadata(groupId, attachmentId, user);
        String format = videoFormat(metadata.fileName());
        if (format == null) return null;
        try {
            Path source = files.findFile(attachmentId).getFile().toPath();
            byte[] cached = cached(attachmentId.toString());
            if (cached != null) return cached.length == 0 ? null : cached;
            if (!processing.tryAcquire(8, TimeUnit.SECONDS)) {
                throw new GroupException(HttpStatus.TOO_MANY_REQUESTS, ApiErrorCode.INVALID_REQUEST,
                        "视频封面正在处理中，请稍后重试。");
            }
            try {
                cached = cached(attachmentId.toString());
                if (cached != null) return cached.length == 0 ? null : cached;
                byte[] thumbnail = extract(source, format);
                remember(attachmentId.toString(), thumbnail == null ? new byte[0] : thumbnail);
                return thumbnail;
            } finally { processing.release(); }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw unavailable();
        } catch (IOException exception) {
            log.warn("视频封面处理工具或目录不可用");
            throw unavailable();
        }
    }

    private byte[] extract(Path source, String format) throws IOException, InterruptedException {
        Path parent = properties.getProcessingDirectory().toAbsolutePath().normalize();
        Files.createDirectories(parent);
        Path directory = Files.createTempDirectory(parent, "thumbnail-");
        Path output = directory.resolve("cover.jpg");
        Process decoder = null;
        try {
            // 只接受已入库本地文件和固定容器，避免按文件内容跟随播放列表或网络地址。
            ProcessBuilder builder = new ProcessBuilder(List.of(properties.getFfmpegExecutable(), "-nostdin",
                    "-hide_banner", "-loglevel", "error", "-max_alloc", "67108864", "-threads", "1",
                    "-filter_threads", "1", "-protocol_whitelist", "file", "-f", format, "-i", source.toString(),
                    "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1",
                    "-vf", "scale=w='min(420,iw)':h='min(340,ih)':force_original_aspect_ratio=decrease", "-c:v", "mjpeg", "-q:v", "5",
                    "-threads", "1", "-f", "image2", "-fs", String.valueOf(MAX_THUMBNAIL_BYTES), output.toString()))
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD);
            builder.environment().clear();
            if (System.getenv("SystemRoot") != null) builder.environment().put("SystemRoot", System.getenv("SystemRoot"));
            decoder = builder.start();
            if (!decoder.waitFor(8, TimeUnit.SECONDS)) {
                log.warn("视频封面生成超时");
                throw unavailable();
            }
            // 无视频轨道或不支持的内容仍可正常下载，不伪造封面。
            if (decoder.exitValue() != 0 || !Files.exists(output)) return null;
            long size = Files.size(output);
            if (size == 0 || size > MAX_THUMBNAIL_BYTES) return null;
            return Files.readAllBytes(output);
        } finally {
            if (decoder != null && decoder.isAlive()) {
                decoder.destroyForcibly();
                try { decoder.waitFor(2, TimeUnit.SECONDS); }
                catch (InterruptedException exception) { Thread.currentThread().interrupt(); }
            }
            for (Path path : List.of(output, directory)) {
                try { Files.deleteIfExists(path); }
                catch (IOException exception) { log.warn("视频封面临时文件清理失败"); }
            }
        }
    }

    private synchronized byte[] cached(String id) { return thumbnails.get(id); }

    private synchronized void remember(String id, byte[] thumbnail) {
        byte[] previous = thumbnails.put(id, thumbnail);
        cachedBytes += thumbnail.length - (previous == null ? 0 : previous.length);
        var iterator = thumbnails.entrySet().iterator();
        while ((cachedBytes > CACHE_BYTES || thumbnails.size() > 128) && iterator.hasNext()) {
            cachedBytes -= iterator.next().getValue().length;
            iterator.remove();
        }
    }

    static String videoFormat(String fileName) {
        if (fileName.lastIndexOf('.') < 0) return null;
        String extension = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        return switch (extension) {
            case "mp4", "m4v", "mov", "3gp" -> "mov";
            case "mkv", "webm" -> "matroska";
            case "avi" -> "avi";
            default -> null;
        };
    }

    public static String mediaType(String fileName) {
        String extension = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        return switch (extension) {
            case "mp4", "m4v" -> "video/mp4";
            case "mov" -> "video/quicktime";
            case "avi" -> "video/x-msvideo";
            case "3gp" -> "video/3gpp";
            case "mkv" -> "video/x-matroska";
            case "webm" -> "video/webm";
            case "mp3" -> "audio/mpeg";
            case "m4a" -> "audio/mp4";
            case "ogg" -> "audio/ogg";
            case "wav" -> "audio/wav";
            case "flac" -> "audio/flac";
            default -> throw new GroupException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, ApiErrorCode.INVALID_REQUEST,
                    "这个文件暂时无法预览，可以下载后打开。");
        };
    }

    private GroupException unavailable() {
        return new GroupException(HttpStatus.SERVICE_UNAVAILABLE, ApiErrorCode.CHAT_FILE_STORAGE_FAILED,
                "暂时无法生成视频封面，请稍后重试。");
    }
}
