package com.lycansync.api.chat.service;

import com.lycansync.api.chat.config.ChatFileProperties;
import com.lycansync.api.chat.mapper.ChatMapper;
import com.lycansync.api.chat.model.ChatFileUploadReservation;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
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
}
