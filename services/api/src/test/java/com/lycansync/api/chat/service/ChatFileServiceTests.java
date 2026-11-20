package com.lycansync.api.chat.service;

import com.lycansync.api.audio.config.AudioProcessingProperties;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.config.ChatFileProperties;
import com.lycansync.api.chat.dto.ChatUploadLimits;
import com.lycansync.api.auth.mapper.AccessLinkMapper;
import com.lycansync.api.auth.service.OwnerSettingsService;
import com.lycansync.api.chat.mapper.ChatMapper;
import com.lycansync.api.chat.model.ChatMessageType;
import com.lycansync.api.chat.model.ChatMessageView;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.group.exception.GroupException;
import com.lycansync.api.group.service.GroupService;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.springframework.transaction.support.TransactionCallback;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 群聊文件上传的存储错误及重叠重试边界测试。
 *
 * @author Wreckloud
 * @since 2026-09-29
 */
class ChatFileServiceTests {

    private static final UUID GROUP_ID = UUID.randomUUID();
    private static final AuthenticatedUser USER = new AuthenticatedUser(UUID.randomUUID(), "Tester", false);
    private final ChatMapper mapper = mock(ChatMapper.class);
    private final ChatFileQuotaService quotaService = mock(ChatFileQuotaService.class);
    private final GroupService groupService = mock(GroupService.class);
    private final TransactionTemplate transactions = mock(TransactionTemplate.class);
    private final ChatFileProperties properties = new ChatFileProperties();
    private final ChatFileStorageCoordinator coordinator = new ChatFileStorageCoordinator();
    private final AudioProcessingProperties media = new AudioProcessingProperties();
    private ChatFileService service;

    @BeforeEach
    void setUp(@TempDir Path temporaryDirectory) {
        properties.setStorageDirectory(temporaryDirectory.resolve("chat-files"));
        when(mapper.findUploadLimits(properties.getMaxFileSize(), properties.getMaxStorageSize()))
                .thenReturn(new ChatUploadLimits(properties.getMaxFileSize(), properties.getMaxStorageSize()));
        ChatUploadSettingsService settings = new ChatUploadSettingsService(mapper, properties,
                mock(OwnerSettingsService.class), mock(AccessLinkMapper.class));
        service = new ChatFileService(mapper, quotaService, groupService, properties,
                Clock.systemUTC(), transactions, coordinator, mock(ApplicationEventPublisher.class), settings, new ChatVideoEncoder(media));
    }

    @Test
    @EnabledIfSystemProperty(named = "lycan.test.ffmpeg", matches = ".+")
    void downloadsOptimizedVideoUnlessOriginalRequested(@TempDir Path directory) throws Exception {
        String ffmpeg = System.getProperty("lycan.test.ffmpeg");
        media.setFfmpegExecutable(ffmpeg);
        Path input = directory.resolve("sample.mkv");
        Process generator = new ProcessBuilder(ffmpeg, "-v", "error", "-f", "lavfi", "-i",
                "testsrc2=size=320x180:rate=30:duration=2", "-c:v", "ffv1", input.toString()).start();
        assertThat(generator.waitFor(15, TimeUnit.SECONDS)).isTrue();
        assertThat(generator.exitValue()).isZero();
        byte[] original = Files.readAllBytes(input);
        when(mapper.allocateMessageSequence(GROUP_ID)).thenReturn(1L);
        when(transactions.execute(any())).thenAnswer(call ->
                call.<TransactionCallback<?>>getArgument(0).doInTransaction(null));
        String name = Base64.getUrlEncoder().encodeToString("sample.mkv".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        for (boolean optimize : new boolean[]{true, false}) {
            UUID attempt = UUID.randomUUID();
            var message = service.upload(GROUP_ID, USER, attempt, name, "", original.length,
                    new ByteArrayInputStream(original), null, optimize);
            Path stored = service.findFile(message.attachment().id()).getFile().toPath();
            assertThat(message.attachment().byteSize()).isEqualTo(Files.size(stored));
            verify(quotaService).complete(attempt, Files.size(stored));
            if (optimize) {
                assertThat(message.attachment().fileName()).isEqualTo("sample.mp4");
                assertThat(Files.size(stored)).isLessThan(original.length);
                Process decoder = new ProcessBuilder(ffmpeg, "-v", "error", "-f", "mov", "-i", stored.toString(),
                        "-c:v", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "null", "-").start();
                assertThat(decoder.waitFor(10, TimeUnit.SECONDS)).isTrue();
                assertThat(decoder.exitValue()).isZero();
            } else {
                assertThat(message.attachment().fileName()).isEqualTo("sample.mkv");
                assertThat(Files.readAllBytes(stored)).isEqualTo(original);
            }
        }
    }

    @Test
    void shouldRejectOversizedDeclarationWithoutAllocatingMessageOrReceivingBytes() {
        when(mapper.findUploadLimits(properties.getMaxFileSize(), properties.getMaxStorageSize()))
                .thenReturn(new ChatUploadLimits(100L * 1024 * 1024, properties.getMaxStorageSize()));
        String name = Base64.getUrlEncoder().encodeToString(new byte[]{'a'});
        UUID id = UUID.randomUUID();
        when(mapper.lockGroupForMessageSend(GROUP_ID)).thenReturn(1L);
        assertThatThrownBy(() -> service.declare(GROUP_ID, USER, id, UUID.randomUUID(), name,
                300L * 1024 * 1024, "")).isInstanceOfSatisfying(GroupException.class, failure -> {
                    assertThat(failure.getStatus()).isEqualTo(HttpStatus.PAYLOAD_TOO_LARGE);
                    assertThat(failure.getMessage()).contains("100 MiB");
                });
        verify(mapper, never()).allocateMessageSequence(any());
        verify(mapper, never()).insertMessage(any());
    }

    @Test
    void shouldReportIncompleteUploadAsBadRequestAndReleaseReservation() {
        UUID uploadId = UUID.randomUUID();
        String encodedName = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("report.bin".getBytes(java.nio.charset.StandardCharsets.UTF_8));

        assertThatThrownBy(() -> service.upload(GROUP_ID, USER, uploadId, encodedName, "", 2,
                new ByteArrayInputStream(new byte[] { 1 })))
                .isInstanceOfSatisfying(GroupException.class, exception -> {
                    assertThat(exception.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
                    assertThat(exception.getCode()).isEqualTo(ApiErrorCode.INVALID_REQUEST);
                });

        verify(quotaService).reserve(uploadId, GROUP_ID, 2, coordinator.processInstanceId());
        verify(quotaService).release(uploadId);
    }

    @Test
    void shouldReportStorageIoFailureAsServerErrorAndReleaseReservation(@TempDir Path temporaryDirectory)
            throws Exception {
        Path storagePath = temporaryDirectory.resolve("not-a-directory");
        Files.write(storagePath, new byte[] { 1 });
        properties.setStorageDirectory(storagePath);
        UUID uploadId = UUID.randomUUID();
        String encodedName = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("report.bin".getBytes(java.nio.charset.StandardCharsets.UTF_8));

        assertThatThrownBy(() -> service.upload(GROUP_ID, USER, uploadId, encodedName, "", 1,
                new ByteArrayInputStream(new byte[] { 1 })))
                .isInstanceOfSatisfying(GroupException.class, exception -> {
                    assertThat(exception.getStatus()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
                    assertThat(exception.getCode()).isEqualTo(ApiErrorCode.CHAT_FILE_STORAGE_FAILED);
                });

        verify(quotaService).reserve(uploadId, GROUP_ID, 1, coordinator.processInstanceId());
        verify(quotaService).release(uploadId);
    }
    @Test
    void shouldReturnCompletedMessageWhenReservationConflictHasAlreadyFinished() {
        UUID uploadId = UUID.randomUUID();
        var existing = completedMessage();
        when(mapper.findFileMessage(GROUP_ID, uploadId, USER.id())).thenReturn(null, existing);
        doThrow(new DuplicateKeyException("reservation")).when(quotaService)
                .reserve(uploadId, GROUP_ID, 1, coordinator.processInstanceId());
        var result = service.upload(GROUP_ID, USER, uploadId, encodedName(), "", 1,
                new ByteArrayInputStream(new byte[] {1}));
        assertThat(result.id()).isEqualTo(existing.id());
        verify(quotaService, never()).release(any());
        verify(transactions, never()).execute(any());
    }

    @Test
    void shouldReturnCompletedMessageAndReleaseOnlyOwnReservationAfterWaiting() {
        UUID uploadId = UUID.randomUUID();
        var existing = completedMessage();
        when(mapper.findFileMessage(GROUP_ID, uploadId, USER.id())).thenReturn(null, existing);
        var result = service.upload(GROUP_ID, USER, uploadId, encodedName(), "", 1,
                new ByteArrayInputStream(new byte[] {1}));
        assertThat(result.id()).isEqualTo(existing.id());
        verify(quotaService).release(uploadId);
        verify(transactions, never()).execute(any());
        assertThat(properties.getStorageDirectory()).doesNotExist();
    }

    @Test
    void shouldKeepConcurrentUploadFileAndReservationWhenRetryConflicts() throws Exception {
        UUID uploadId = UUID.randomUUID();
        var reserved = new AtomicBoolean();
        doAnswer(invocation -> {
            if (!reserved.compareAndSet(false, true)) throw new DuplicateKeyException("reservation");
            return null;
        }).when(quotaService).reserve(uploadId, GROUP_ID, 1, coordinator.processInstanceId());
        var receiving = new CountDownLatch(1);
        var cancel = new CountDownLatch(1);
        var executor = Executors.newSingleThreadExecutor();
        try {
            var first = executor.submit(() -> assertThatThrownBy(() -> service.upload(GROUP_ID, USER,
                    uploadId, encodedName(), "", 1, new InputStream() {
                        @Override public int read() throws IOException {
                            receiving.countDown();
                            try {
                                if (!cancel.await(5, TimeUnit.SECONDS)) throw new IOException("timeout");
                            } catch (InterruptedException exception) {
                                Thread.currentThread().interrupt(); throw new IOException(exception);
                            }
                            throw new IOException("cancelled");
                        }
                    })).isInstanceOf(GroupException.class));
            assertThat(receiving.await(5, TimeUnit.SECONDS)).isTrue();
            Path temporary = properties.getStorageDirectory().resolve(".tmp").resolve(uploadId + ".part");
            assertThat(temporary).exists();
            assertThatThrownBy(() -> service.upload(GROUP_ID, USER, uploadId, encodedName(), "", 1,
                    new ByteArrayInputStream(new byte[] {1})))
                    .isInstanceOfSatisfying(GroupException.class,
                            exception -> assertThat(exception.getStatus()).isEqualTo(HttpStatus.CONFLICT));
            assertThat(temporary).exists();
            verify(quotaService, never()).release(any());
            cancel.countDown(); first.get(5, TimeUnit.SECONDS);
            verify(quotaService).release(uploadId);
            assertThat(temporary).doesNotExist();
        } finally { cancel.countDown(); executor.shutdownNow(); }
    }

    private ChatMessageView completedMessage() {
        return new ChatMessageView(UUID.randomUUID(), USER.id(), USER.nickname(), ChatMessageType.FILE,
                "", Instant.now(), UUID.randomUUID(), "application/octet-stream", null, null, 1L, "report.bin");
    }

    private String encodedName() {
        return Base64.getUrlEncoder().withoutPadding().encodeToString("report.bin".getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

}
