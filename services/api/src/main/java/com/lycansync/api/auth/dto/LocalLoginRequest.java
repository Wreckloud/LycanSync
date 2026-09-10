package com.lycansync.api.auth.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * 本地账号登录参数。
 *
 * @author Wreckloud
 * @since 2026-09-09
 */
@Schema(description = "本地账号登录参数")
public record LocalLoginRequest(
        @NotBlank
        @Pattern(regexp = "[A-Za-z0-9_]{3,32}")
        @Schema(description = "用户名，3 至 32 位字母、数字或下划线", example = "wreckloud")
        String username,
        @NotBlank
        @Size(min = 6, max = 64)
        @Schema(description = "密码，6 至 64 个字符", accessMode = Schema.AccessMode.WRITE_ONLY)
        String password
) {
}
