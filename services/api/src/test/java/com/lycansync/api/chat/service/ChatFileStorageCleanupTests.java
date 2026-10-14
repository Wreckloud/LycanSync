package com.lycansync.api.chat.service;

import com.lycansync.api.chat.config.ChatFileProperties;
import com.lycansync.api.chat.mapper.ChatMapper;
import com.lycansync.api.chat.model.ChatFileUploadReservation;
import com.lycansync.api.group.event.GroupChangedEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 群聊文件启动恢复失败时保留可重试状态的单元测试。
 *
 * @author Wreckloud
 * @since 2026-09-29
 */
class ChatFileStorageCleanupTests {

    @Test
    void shouldKeepQuotaReservationWhenTemporaryFileCannotBeDeleted(@TempDir Path temporaryDirectory)
            throws Exception {
        UUID uploadId = UUID.randomUUID();
        UUID previousProcessId = UUID.randomUUID();
        Path storage = temporaryDirectory.resolve("chat-files");
        Path temporaryFile = storage.resolve(".tmp").resolve(uploadId + ".part");
        Files.createDirectories(temporaryFile.resolve("child"));

        ChatFileQuotaService quotaService = mock(ChatFileQuotaService.class);
        ChatMapper mapper = mock(ChatMapper.class);
        ChatFileStorageCoordinator coordinator = new ChatFileStorageCoordinator();
        when(quotaService.findReservations()).thenReturn(List.of(new ChatFileUploadReservation(
                uploadId, 1, Instant.now().minusSeconds(300), previousProcessId)));
        ChatFileStorageCleanup cleanup = new ChatFileStorageCleanup(properties(storage), quotaService, mapper,
                coordinator);

        cleanup.removeOrphanedFiles();

        assertThat(Files.exists(temporaryFile.resolve("child"))).isTrue();
        verify(quotaService, times(0)).release(uploadId);
    }

    @Test
    void shouldRetryQuotaReleaseOnNextCleanupWhenTheFirstReleaseFails(@TempDir Path temporaryDirectory) {
        UUID uploadId = UUID.randomUUID();
        UUID previousProcessId = UUID.randomUUID();
        ChatFileQuotaService quotaService = mock(ChatFileQuotaService.class);
        ChatMapper mapper = mock(ChatMapper.class);
        when(quotaService.findReservations()).thenReturn(List.of(new ChatFileUploadReservation(
                uploadId, 1, Instant.now().minusSeconds(300), previousProcessId)));
        doThrow(new IllegalStateException("quota release failed")).doNothing()
                .when(quotaService).release(uploadId);
        ChatFileStorageCleanup cleanup = new ChatFileStorageCleanup(properties(temporaryDirectory.resolve("files")),
                quotaService, mapper, new ChatFileStorageCoordinator());

        cleanup.removeOrphanedFiles();
        cleanup.removeOrphanedFiles();

        verify(quotaService, times(2)).release(uploadId);
    }

    private ChatFileProperties properties(Path storageDirectory) {
        ChatFileProperties properties = new ChatFileProperties();
        properties.setStorageDirectory(storageDirectory);
        return properties;
    }

    @Test
    void dissolvedGroupCleanupOnlyDeletesOrphansWithoutQuotaWrites(@TempDir Path storage) throws Exception {
        UUID orphanId = UUID.randomUUID();
        UUID referencedId = UUID.randomUUID();
        Path orphan = Files.write(storage.resolve(orphanId + ".bin"), new byte[]{1});
        Path referenced = Files.write(storage.resolve(referencedId + ".bin"), new byte[]{2});
        ChatFileQuotaService quota = mock(ChatFileQuotaService.class);
        ChatMapper mapper = mock(ChatMapper.class);
        when(mapper.fileAttachmentExists(referencedId)).thenReturn(true);
        ChatFileStorageCleanup cleanup = new ChatFileStorageCleanup(properties(storage), quota, mapper,
                new ChatFileStorageCoordinator());

        cleanup.groupDissolved(new GroupChangedEvent(UUID.randomUUID(), false));
        verifyNoInteractions(quota, mapper);
        cleanup.groupDissolved(new GroupChangedEvent(UUID.randomUUID(), true));

        assertThat(orphan).doesNotExist();
        assertThat(referenced).exists();
        verifyNoInteractions(quota);
    }

    @Test
    void dissolvedGroupDoesNotWaitForUploadsOrReportCommittedDeletionAsFailure(@TempDir Path storage)
            throws Exception {
        Path orphan = Files.write(storage.resolve(UUID.randomUUID() + ".bin"), new byte[]{1});
        ChatFileQuotaService quota = mock(ChatFileQuotaService.class);
        ChatMapper mapper = mock(ChatMapper.class);
        ChatFileStorageCoordinator coordinator = new ChatFileStorageCoordinator();
        ChatFileStorageCleanup cleanup = new ChatFileStorageCleanup(properties(storage), quota, mapper, coordinator);
        coordinator.uploadLock().lock();
        try {
            cleanup.groupDissolved(new GroupChangedEvent(UUID.randomUUID(), true));
            assertThat(orphan).exists();
            verifyNoInteractions(quota, mapper);
        } finally {
            coordinator.uploadLock().unlock();
        }
        // 非目录触发真实文件系统异常，解散结果仍保持成功，日志保留失败上下文。
        ChatFileStorageCleanup failed = new ChatFileStorageCleanup(properties(orphan), quota, mapper, coordinator);
        assertThatCode(() -> failed.groupDissolved(new GroupChangedEvent(UUID.randomUUID(), true)))
                .doesNotThrowAnyException();
    }
}
