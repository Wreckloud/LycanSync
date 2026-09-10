package com.lycansync.api.auth.dto;

import io.swagger.v3.oas.annotations.media.Schema;

import java.util.UUID;

/**
 * 当前登录会话的轻量状态。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
@Schema(description = "当前登录会话状态，不包含头像")
public record SessionStatusResponse(
        @Schema(description = "账号标识")
        UUID id,

        @Schema(description = "当前昵称", example = "小狼")
        String nickname,

        @Schema(description = "是否为管理员", example = "false")
        boolean administrator
) {
}
