package com.lycansync.api.chat.service;

import com.lycansync.api.audio.config.AudioProcessingProperties;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.model.ChatFileMetadata;
import com.lycansync.api.group.exception.GroupException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.HttpStatus;

import javax.imageio.ImageIO;
import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockConstruction;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 视频封面的缓存、授权、失败清理与可选真实解码验证。
 *
 * @author Wreckloud
 * @since 2026-11-15
 */
class ChatFileMediaServiceTests {

    @TempDir Path directory;
    private final ChatFileService files = mock(ChatFileService.class);
    private final AudioProcessingProperties properties = new AudioProcessingProperties();
    private final UUID group = UUID.randomUUID();
    private final UUID attachment = UUID.randomUUID();
    private final AuthenticatedUser user = new AuthenticatedUser(UUID.randomUUID(), "测试成员", false);

    private ChatFileMediaService service(String name) throws Exception {
        properties.setProcessingDirectory(directory.resolve("processing"));
        Path original = directory.resolve(name);
        Files.write(original, new byte[]{1, 2, 3});
        when(files.findMetadata(group, attachment, user)).thenReturn(new ChatFileMetadata(attachment, name, 3));
        when(files.findFile(attachment)).thenReturn(new FileSystemResource(original));
        return new ChatFileMediaService(files, properties);
    }

    @Test
    void cachesCoverButChecksMembershipAgainAndRemovesTemporaryFiles() throws Exception {
        var service = service("test.mp4");
        Process decoder = mock(Process.class);
        when(decoder.waitFor(8, TimeUnit.SECONDS)).thenReturn(true);
        try (var builders = mockConstruction(ProcessBuilder.class, (builder, context) -> {
            when(builder.redirectOutput(any(ProcessBuilder.Redirect.class))).thenReturn(builder);
            when(builder.redirectError(any(ProcessBuilder.Redirect.class))).thenReturn(builder);
            when(builder.environment()).thenReturn(new HashMap<>());
            when(builder.start()).thenAnswer(invocation -> {
                var command = (List<?>) context.arguments().get(0);
                Files.write(Path.of((String) command.get(command.size() - 1)), new byte[]{4, 5});
                return decoder;
            });
        })) {
            assertThat(service.findThumbnail(group, attachment, user)).containsExactly(4, 5);
            assertThat(service.findThumbnail(group, attachment, user)).containsExactly(4, 5);
            assertThat(builders.constructed()).hasSize(1);
            verify(files, times(2)).findMetadata(group, attachment, user);
            when(files.findMetadata(group, attachment, user)).thenThrow(new GroupException(HttpStatus.FORBIDDEN,
                    com.lycansync.api.common.error.ApiErrorCode.INVALID_REQUEST, "已退出群聊"));
            assertThatThrownBy(() -> service.findThumbnail(group, attachment, user)).isInstanceOf(GroupException.class);
            try (var remaining = Files.list(properties.getProcessingDirectory())) { assertThat(remaining).isEmpty(); }
            assertThat(Files.readAllBytes(directory.resolve("test.mp4"))).containsExactly(1, 2, 3);
        }
    }

    @Test
    void decodeTimeoutStopsChildAndDoesNotCacheFailure() throws Exception {
        var service = service("test.webm");
        Process decoder = mock(Process.class);
        when(decoder.isAlive()).thenReturn(true);
        try (var builders = mockConstruction(ProcessBuilder.class, (builder, context) -> {
            when(builder.redirectOutput(any(ProcessBuilder.Redirect.class))).thenReturn(builder);
            when(builder.redirectError(any(ProcessBuilder.Redirect.class))).thenReturn(builder);
            when(builder.environment()).thenReturn(new HashMap<>());
            when(builder.start()).thenReturn(decoder);
        })) {
            assertThatThrownBy(() -> service.findThumbnail(group, attachment, user)).isInstanceOf(GroupException.class);
            assertThatThrownBy(() -> service.findThumbnail(group, attachment, user)).isInstanceOf(GroupException.class);
            assertThat(builders.constructed()).hasSize(2);
            verify(decoder, times(2)).destroyForcibly();
            try (var remaining = Files.list(properties.getProcessingDirectory())) { assertThat(remaining).isEmpty(); }
        }
    }

    @Test
    void unsupportedFilesNeverStartDecoderAndMissingToolIsExplicitFailure() throws Exception {
        var service = service("test.txt");
        assertThat(service.findThumbnail(group, attachment, user)).isNull();
        verify(files, never()).findFile(any());
        service = service("test.mp4");
        properties.setFfmpegExecutable(directory.resolve("missing-tool").toString());
        var configured = service;
        assertThatThrownBy(() -> configured.findThumbnail(group, attachment, user)).isInstanceOf(GroupException.class);
        try (var remaining = Files.list(properties.getProcessingDirectory())) { assertThat(remaining).isEmpty(); }
    }

    @Test
    @EnabledIfSystemProperty(named = "lycan.test.ffmpeg", matches = ".+")
    void realFfmpegGeneratesSmallJpegAndReusesIt() throws Exception {
        var service = service("test.mp4");
        String executable = System.getProperty("lycan.test.ffmpeg");
        properties.setFfmpegExecutable(executable);
        Path video = directory.resolve("test.mp4");
        Process generator = new ProcessBuilder(executable, "-v", "error", "-y", "-f", "lavfi", "-i",
                "color=c=blue:s=1920x1080:r=15:d=1", "-threads", "1", "-c:v", "mpeg4", video.toString())
                .redirectError(ProcessBuilder.Redirect.INHERIT).start();
        assertThat(generator.waitFor(10, TimeUnit.SECONDS)).isTrue();
        assertThat(generator.exitValue()).isZero();
        byte[] jpeg = service.findThumbnail(group, attachment, user);
        var image = ImageIO.read(new ByteArrayInputStream(jpeg));
        assertThat(image.getWidth()).isEqualTo(420);
        assertThat(image.getHeight()).isBetween(235, 237);
        assertThat(jpeg.length).isLessThan(256 * 1024);
        assertThat(service.findThumbnail(group, attachment, user)).isSameAs(jpeg);
        try (var remaining = Files.list(properties.getProcessingDirectory())) { assertThat(remaining).isEmpty(); }
    }
}
