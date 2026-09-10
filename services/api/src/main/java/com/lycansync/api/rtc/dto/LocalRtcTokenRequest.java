package com.lycansync.api.rtc.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

/**
 * 本地 RTC 入房凭证请求。
 *
 * @author Wreckloud
 * @since 2026-09-03
 */
@Schema(description = "本地 RTC 入房凭证请求，身份由登录会话提供")
public record LocalRtcTokenRequest(
        @NotBlank(message = "群组标识不能为空")
        @Pattern(regexp = GROUP_ID_PATTERN, message = "群组标识格式不正确")
        @Schema(description = "本地界面使用的群组标识", example = "pack", maxLength = 32)
        String groupId
) {

    public static final String GROUP_ID_PATTERN = "[a-z0-9][a-z0-9-]{0,31}";
}
