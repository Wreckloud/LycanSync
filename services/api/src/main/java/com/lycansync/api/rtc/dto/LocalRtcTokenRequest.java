package com.lycansync.api.rtc.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotNull;

import java.util.UUID;

/**
 * 本地 RTC 入房凭证请求。
 *
 * @author Wreckloud
 * @since 2026-09-03
 */
@Schema(description = "群组 RTC 入房凭证请求，身份由登录会话提供")
public record LocalRtcTokenRequest(
        @NotNull
        @Schema(description = "已加入群组的 UUID", example = "01b08c29-d1e5-4bca-987f-64946541e93b")
        UUID groupId
) {
}
