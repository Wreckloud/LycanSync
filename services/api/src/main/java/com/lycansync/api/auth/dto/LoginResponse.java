package com.lycansync.api.auth.dto;

import com.lycansync.api.auth.model.AuthUser;
import io.swagger.v3.oas.annotations.media.Schema;

/**
 * 登录成功结果。
 *
 * @author Wreckloud
 * @since 2026-09-09
 */
@Schema(description = "登录成功结果；会话凭据只返回一次")
public record LoginResponse(
        @Schema(description = "Bearer 会话凭据", accessMode = Schema.AccessMode.READ_ONLY)
        String sessionToken,
        AuthUser user
) {
}
