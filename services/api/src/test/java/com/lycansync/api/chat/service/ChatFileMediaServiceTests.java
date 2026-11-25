package com.lycansync.api.chat.service;

import com.lycansync.api.audio.config.AudioProcessingProperties;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.mapper.ChatMapper;
import com.lycansync.api.chat.model.ChatAttachmentContent;
import com.lycansync.api.chat.model.ChatFileMetadata;
import com.lycansync.api.group.exception.GroupException;
import com.lycansync.api.group.service.GroupService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.HttpStatus;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.HashMap;
import java.util.List;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockConstruction;
import static org.mockito.Mockito.doThrow;
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
    void imageThumbnailUsesTheActualFormatForBothStoragePathsAndKeepsTheOriginal() throws Exception {
        byte[] original;
        var picture = new BufferedImage(1280, 720, BufferedImage.TYPE_INT_RGB);
        var random = new Random(7);
        for (int y = 0; y < picture.getHeight(); y++) {
            for (int x = 0; x < picture.getWidth(); x++) picture.setRGB(x, y, random.nextInt());
        }
        try (var bytes = new ByteArrayOutputStream()) {
            ImageIO.write(picture, "png", bytes);
            original = bytes.toByteArray();
        }
        var media = service("photo.jpg");
        Path file = Files.write(directory.resolve("photo.jpg"), original);
        when(files.findMetadata(group, attachment, user)).thenReturn(new ChatFileMetadata(attachment, "photo.jpg", original.length));
        byte[] fileThumbnail = media.findThumbnail(group, attachment, user);
        assertThat(fileThumbnail).isNotNull();
        assertThat(fileThumbnail.length).isLessThan(original.length / 10);
        assertThat(fileThumbnail.length).isLessThan(256 * 1024);
        var decoded = ImageIO.read(new ByteArrayInputStream(fileThumbnail));
        assertThat(decoded.getWidth()).isEqualTo(420);
        assertThat(decoded.getHeight()).isEqualTo(236);
        assertThat(Files.readAllBytes(file)).isEqualTo(original);

        var mapper = mock(ChatMapper.class);
        var groups = mock(GroupService.class);
        var chat = new ChatService(mapper, groups, Clock.systemUTC(), mock(org.springframework.context.ApplicationEventPublisher.class),
                mock(ChatUploadSettingsService.class), media);
        when(mapper.findAttachment(group, attachment)).thenReturn(new ChatAttachmentContent(attachment, "image/png", original));
        assertThat(chat.findAttachmentThumbnail(group, attachment, user)).isEqualTo(fileThumbnail);
        assertThat(chat.findAttachmentThumbnail(group, attachment, user)).isEqualTo(fileThumbnail);
        verify(mapper, times(1)).findAttachment(group, attachment);
        verify(groups, times(2)).requireMember(group, user);
        assertThatThrownBy(() -> chat.findAttachmentThumbnail(UUID.randomUUID(), attachment, user)).isInstanceOf(GroupException.class);
        doThrow(new GroupException(HttpStatus.FORBIDDEN, com.lycansync.api.common.error.ApiErrorCode.INVALID_REQUEST, "已退出群聊"))
                .when(groups).requireMember(group, user);
        assertThatThrownBy(() -> chat.findAttachmentThumbnail(group, attachment, user)).isInstanceOf(GroupException.class);
    }

    @Test
    void temporaryImageReadFailureCanRecoverOnNextRequest() throws Exception {
        var media = service("test.png");
        Path file = directory.resolve("test.png");
        Files.delete(file);
        assertThatThrownBy(() -> media.findThumbnail(group, attachment, user))
                .isInstanceOfSatisfying(GroupException.class, error -> assertThat(error.getStatus()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE));
        ImageIO.write(new BufferedImage(2, 2, BufferedImage.TYPE_INT_RGB), "png", file.toFile());
        assertThat(media.findThumbnail(group, attachment, user)).isNotEmpty();
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
    void onlyRecognizesSupportedContainerHeaders() throws Exception {
        Path sample = directory.resolve("container");
        Files.writeString(sample, "RIFF0000AVI ");
        assertThat(ChatFileMediaService.inputFormat(sample, "mov")).isEqualTo("avi");
        Files.writeString(sample, "RIFF0000WAVE");
        assertThat(ChatFileMediaService.inputFormat(sample, "mov")).isEqualTo("mov");
        Files.writeString(sample, "0000ftyp");
        assertThat(ChatFileMediaService.inputFormat(sample, "matroska")).isEqualTo("matroska");
        assertThat(ChatFileMediaService.videoFormat("video.txt")).isNull();
    }

    @Test
    @EnabledIfSystemProperty(named = "lycan.test.ffmpeg", matches = ".+")
    void misnamedWebmCanBeDisplayedAndEncodedWithoutChangingOriginal() throws Exception {
        var service = service("upload.mp4");
        String executable = System.getProperty("lycan.test.ffmpeg");
        properties.setFfmpegExecutable(executable);
        Path video = directory.resolve("upload.mp4");
        Process generator = new ProcessBuilder(executable, "-v", "error", "-y", "-f", "lavfi", "-i",
                "color=c=blue:s=160x90:r=15:d=1", "-threads", "1", "-c:v", "libvpx", "-f", "webm", video.toString())
                .redirectError(ProcessBuilder.Redirect.INHERIT).start();
        assertThat(generator.waitFor(10, TimeUnit.SECONDS)).isTrue();
        assertThat(generator.exitValue()).isZero();
        byte[] original = Files.readAllBytes(video);
        assertThat(ImageIO.read(new ByteArrayInputStream(service.findThumbnail(group, attachment, user)))).isNotNull();
        var encoder = new ChatVideoEncoder(properties);
        for (boolean preview : new boolean[]{false, true}) {
            Path output = directory.resolve(preview ? "preview.mp4" : "optimized.mp4");
            encoder.encode(video, "mov", output, 1_000_000, preview);
            assertThat(ChatFileMediaService.inputFormat(output, "matroska")).isEqualTo("mov");
        }
        assertThat(Files.readAllBytes(video)).isEqualTo(original);
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
