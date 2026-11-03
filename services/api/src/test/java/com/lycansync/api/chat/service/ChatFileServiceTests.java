package com.lycansync.api.chat.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.config.ChatFileProperties;
import com.lycansync.api.chat.mapper.ChatMapper;
import com.lycansync.api.chat.model.ChatMessageType;
import com.lycansync.api.chat.model.ChatMessageView;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.group.exception.GroupException;
import com.lycansync.api.group.service.GroupService;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
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
    private ChatFileService service;

    @BeforeEach
    void setUp(@TempDir Path temporaryDirectory) {
        properties.setStorageDirectory(temporaryDirectory.resolve("chat-files"));
        service = new ChatFileService(mapper, quotaService, groupService, properties,
                Clock.systemUTC(), transactions, coordinator, mock(ApplicationEventPublisher.class));
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
