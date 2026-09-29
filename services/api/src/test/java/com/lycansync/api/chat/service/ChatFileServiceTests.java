package com.lycansync.api.chat.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.config.ChatFileProperties;
import com.lycansync.api.chat.mapper.ChatMapper;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.group.exception.GroupException;
import com.lycansync.api.group.service.GroupService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.Base64;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

/**
 * 群聊文件上传的存储错误映射测试。
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
    private ChatFileService service;

    @BeforeEach
    void setUp(@TempDir Path temporaryDirectory) {
        properties.setStorageDirectory(temporaryDirectory.resolve("chat-files"));
        service = new ChatFileService(mapper, quotaService, groupService, properties,
                Clock.systemUTC(), transactions);
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

        verify(quotaService).reserve(uploadId, GROUP_ID, 2);
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

        verify(quotaService).reserve(uploadId, GROUP_ID, 1);
        verify(quotaService).release(uploadId);
    }
}
