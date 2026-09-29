package com.lycansync.api.chat.service;

import com.lycansync.api.chat.config.ChatFileProperties;
import com.lycansync.api.chat.mapper.ChatMapper;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 群聊文件额度预留结算失败处理测试。
 *
 * @author Wreckloud
 * @since 2026-09-29
 */
class ChatFileQuotaServiceTests {

    @Test
    void shouldReportWhenReservationReleaseDidNotUpdateQuota() {
        ChatMapper mapper = mock(ChatMapper.class);
        ChatFileQuotaService quotaService = new ChatFileQuotaService(mapper, new ChatFileProperties(),
                Clock.systemUTC());
        UUID uploadId = UUID.randomUUID();
        when(mapper.releaseFileStorageReservation(uploadId)).thenReturn(0);

        assertThatThrownBy(() -> quotaService.release(uploadId))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("文件存储额度预留释放失败");
    }
}
