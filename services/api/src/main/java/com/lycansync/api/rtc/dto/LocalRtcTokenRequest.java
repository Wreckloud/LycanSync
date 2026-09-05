package com.lycansync.api.rtc.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * 本地 RTC 入房凭证请求。
 *
 * @author Wreckloud
 * @since 2026-09-03
 */
@Schema(description = "本地 RTC 入房凭证请求，不代表正式登录")
public record LocalRtcTokenRequest(
        @NotBlank(message = "群组标识不能为空")
        @Pattern(regexp = GROUP_ID_PATTERN, message = "群组标识格式不正确")
        @Schema(description = "本地界面使用的群组标识", example = "pack", maxLength = 32)
        String groupId,

        @NotBlank(message = "显示昵称不能为空")
        @Size(max = 32, message = "显示昵称不能超过 32 个字符")
        @Schema(description = "本次连接的显示昵称，不作为身份标识", example = "小狼", maxLength = 32)
        String displayName
) {

    public static final String GROUP_ID_PATTERN = "[a-z0-9][a-z0-9-]{0,31}";
}
