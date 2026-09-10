package com.lycansync.api.auth.model;

import io.swagger.v3.oas.annotations.media.Schema;

import java.util.UUID;

/**
 * 已认证用户资料，不包含登录凭据。
 *
 * @author Wreckloud
 * @since 2026-09-06
 */
@Schema(description = "本地账号资料，不包含登录凭据")
public record AuthUser(UUID id, String nickname, String avatar, boolean administrator) {
}
