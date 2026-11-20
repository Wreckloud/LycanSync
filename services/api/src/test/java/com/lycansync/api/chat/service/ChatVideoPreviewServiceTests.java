package com.lycansync.api.chat.service;

import com.lycansync.api.audio.config.AudioProcessingProperties;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.model.ChatFileMetadata;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.group.exception.GroupException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.HttpStatus;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.io.RandomAccessFile;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.mockConstruction;
import static org.mockito.Mockito.verify;
import static org.mockito.ArgumentMatchers.any;

/**
 * 兼容预览的授权、重试、缓存清理及真实 FFmpeg 转换验收。
 *
 * @author Wreckloud
 * @since 2026-11-15
 */
class ChatVideoPreviewServiceTests {
    @TempDir Path directory;
    private final ChatFileService files = mock(ChatFileService.class);
    private final AudioProcessingProperties properties = new AudioProcessingProperties();
    private final UUID group = UUID.randomUUID();
    private final UUID attachment = UUID.randomUUID();
    private final AuthenticatedUser user = new AuthenticatedUser(UUID.randomUUID(), "测试成员", false);
    private ChatVideoPreviewService service;
    private Path original;

    @BeforeEach
    void setUp() throws Exception {
        properties.setProcessingDirectory(directory.resolve("processing"));
        properties.setFfmpegExecutable(directory.resolve("missing-ffmpeg").toString());
        original = directory.resolve("original.mp4");
        Files.write(original, new byte[]{1, 2, 3});
        when(files.findMetadata(group, attachment, user)).thenReturn(new ChatFileMetadata(attachment, "test.mp4", 3));
        when(files.findFile(attachment)).thenReturn(new FileSystemResource(original));
        service = new ChatVideoPreviewService(files, properties, new ChatVideoEncoder(properties));
    }

    @AfterEach
    void tearDown() { service.close(); }

    private Path cache() { return properties.getProcessingDirectory().resolve("chat-video-previews-v1"); }

    private String waitForResult() throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        String status;
        while ((status = service.status(group, attachment, user).status()).equals("processing") && System.nanoTime() < deadline) {
            Thread.sleep(20);
        }
        assertThat(status).isNotEqualTo("processing");
        return status;
    }

    @Test
    void statusDoesNotStartConversionAndCachedPreviewStillRequiresMembership() throws Exception {
        assertThat(service.status(group, attachment, user).status()).isEqualTo("absent");
        assertThat(cache()).doesNotExist();
        Files.createDirectories(cache());
        Path preview = cache().resolve(attachment + ".mp4");
        Files.write(preview, new byte[]{4, 5, 6});
        assertThat(service.prepare(group, attachment, user).status()).isEqualTo("ready");
        assertThat(service.find(group, attachment, user).getFile().toPath()).isEqualTo(preview.toAbsolutePath());
        when(files.findMetadata(group, attachment, user)).thenThrow(new GroupException(HttpStatus.FORBIDDEN,
                ApiErrorCode.INVALID_REQUEST, "已退出群聊"));
        assertThatThrownBy(() -> service.status(group, attachment, user)).isInstanceOf(GroupException.class);
        assertThatThrownBy(() -> service.prepare(group, attachment, user)).isInstanceOf(GroupException.class);
        assertThatThrownBy(() -> service.find(group, attachment, user)).isInstanceOf(GroupException.class);
    }

    @Test
    void failuresAreExplicitRetryableAndDoNotChangeOriginal() throws Exception {
        for (int attempt = 0; attempt < 2; attempt++) {
            assertThat(service.prepare(group, attachment, user).status()).isEqualTo("processing");
            assertThat(waitForResult()).isEqualTo("failed");
            assertThat(service.status(group, attachment, user).message()).contains("下载原文件");
        }
        try (var entries = Files.list(cache())) { assertThat(entries).isEmpty(); }
        assertThat(Files.readAllBytes(original)).containsExactly(1, 2, 3);
    }

    @Test
    void expiredAndAbandonedFilesAreRemovedWithoutTouchingOriginalOrRecentPreview() throws Exception {
        Files.createDirectories(cache());
        Path old = Files.write(cache().resolve(UUID.randomUUID() + ".mp4"), new byte[]{1});
        Files.setLastModifiedTime(old, FileTime.fromMillis(System.currentTimeMillis() - Duration.ofDays(8).toMillis()));
        Path partial = Files.write(cache().resolve(UUID.randomUUID() + ".part"), new byte[]{2});
        Path recent = Files.write(cache().resolve(attachment + ".mp4"), new byte[]{3});
        service.cleanExpired();
        assertThat(old).doesNotExist();
        assertThat(partial).doesNotExist();
        assertThat(recent).exists();
        assertThat(original).exists();
    }

    @Test
    void oversizedOutputStopsEncoderAndNeverPublishesTruncatedPreview() throws Exception {
        Files.createDirectories(cache());
        Process encoder = mock(Process.class);
        when(encoder.isAlive()).thenReturn(true);
        try (var builders = mockConstruction(ProcessBuilder.class, (builder, context) -> {
            when(builder.redirectOutput(any(ProcessBuilder.Redirect.class))).thenReturn(builder);
            when(builder.redirectError(any(ProcessBuilder.Redirect.class))).thenReturn(builder);
            when(builder.environment()).thenReturn(new HashMap<>());
            when(builder.start()).thenAnswer(invocation -> {
                var command = (List<?>) context.arguments().get(0);
                try (var output = new RandomAccessFile((String) command.get(command.size() - 1), "rw")) {
                    output.setLength(129L * 1024 * 1024);
                }
                return encoder;
            });
        })) {
            org.springframework.test.util.ReflectionTestUtils.invokeMethod(service, "convert", attachment, original, "mov");
            verify(encoder).destroyForcibly();
            assertThat(service.status(group, attachment, user).status()).isEqualTo("failed");
            try (var entries = Files.list(cache())) { assertThat(entries).isEmpty(); }
        }
    }

    @Test
    void cacheCapacityEvictsOldestPreviewButProtectsRecentPlayback() throws Exception {
        Files.createDirectories(cache());
        Path oldest = cache().resolve(UUID.randomUUID() + ".mp4");
        for (int i = 0; i < 5; i++) {
            Path entry = i == 0 ? oldest : cache().resolve(UUID.randomUUID() + ".mp4");
            try (var output = new RandomAccessFile(entry.toFile(), "rw")) { output.setLength(128L * 1024 * 1024); }
            Files.setLastModifiedTime(entry, FileTime.fromMillis(System.currentTimeMillis() - (i == 0 ? Duration.ofHours(1).toMillis() : 0)));
        }
        service.cleanExpired();
        assertThat(oldest).doesNotExist();
        try (var entries = Files.list(cache())) { assertThat(entries).hasSize(4); }
        assertThatThrownBy(() -> service.prepare(group, attachment, user)).isInstanceOf(GroupException.class)
                .hasMessageContaining("缓存暂时已满");
    }

    @Test
    void rejectsUnsupportedFilesBeforeCreatingCache() {
        when(files.findMetadata(group, attachment, user)).thenReturn(new ChatFileMetadata(attachment, "text.txt", 3));
        assertThatThrownBy(() -> service.prepare(group, attachment, user)).isInstanceOf(GroupException.class);
        assertThat(cache()).doesNotExist();
    }

    @Test
    @EnabledIfSystemProperty(named = "lycan.test.videoSample", matches = ".+")
    void authorizedSampleConvertsWithoutChangingItsContents() throws Exception {
        Path sample = Path.of(System.getProperty("lycan.test.videoSample"));
        byte[] before = Files.readAllBytes(sample);
        Files.copy(sample, original, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        properties.setFfmpegExecutable(System.getProperty("lycan.test.ffmpeg"));
        service.prepare(group, attachment, user);
        assertThat(waitForResult()).isEqualTo("ready");
        Path preview = service.find(group, attachment, user).getFile().toPath();
        String export = System.getProperty("lycan.test.previewExport");
        if (export != null) Files.copy(preview, Path.of(export), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        assertThat(Files.readAllBytes(sample)).isEqualTo(before);
        assertThat(Files.readAllBytes(original)).isEqualTo(before);
    }

    @Test
    @EnabledIfSystemProperty(named = "lycan.test.ffmpeg", matches = ".+")
    void realMpeg4ConvertsToReusableH264AndEvictionDoesNotLeaveAFalseReadyStatus() throws Exception {
        String executable = System.getProperty("lycan.test.ffmpeg");
        properties.setFfmpegExecutable(executable);
        Process generator = new ProcessBuilder(executable, "-v", "error", "-y", "-f", "lavfi", "-i",
                "testsrc2=size=1920x1080:rate=60:duration=2", "-threads", "1", "-c:v", "mpeg4", original.toString())
                .redirectError(ProcessBuilder.Redirect.INHERIT).start();
        assertThat(generator.waitFor(15, TimeUnit.SECONDS)).isTrue();
        assertThat(generator.exitValue()).isZero();
        byte[] before = Files.readAllBytes(original);
        synchronized (service) {
            assertThat(service.prepare(group, attachment, user).status()).isEqualTo("processing");
            assertThat(service.prepare(group, attachment, user).status()).isIn("processing", "ready");
            UUID other = UUID.randomUUID();
            when(files.findMetadata(group, other, user)).thenReturn(new ChatFileMetadata(other, "other.mp4", 3));
            assertThatThrownBy(() -> service.prepare(group, other, user)).isInstanceOf(GroupException.class);
        }
        assertThat(waitForResult()).isEqualTo("ready");
        Path preview = service.find(group, attachment, user).getFile().toPath();
        FileTime created = Files.getLastModifiedTime(preview);
        assertThat(service.prepare(group, attachment, user).status()).isEqualTo("ready");
        assertThat(Files.getLastModifiedTime(preview)).isEqualTo(created);
        Process decoder = new ProcessBuilder(executable, "-v", "error", "-i", preview.toString(), "-map", "0:v:0",
                "-c:v", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "null", "-")
                .redirectError(ProcessBuilder.Redirect.INHERIT).redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
        assertThat(decoder.waitFor(10, TimeUnit.SECONDS)).isTrue();
        assertThat(decoder.exitValue()).isZero();
        assertThat(Files.readAllBytes(original)).isEqualTo(before);
        Files.delete(preview);
        assertThat(service.status(group, attachment, user).status()).isEqualTo("absent");
    }
}
