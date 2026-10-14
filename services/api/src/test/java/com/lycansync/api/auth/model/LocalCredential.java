package com.lycansync.api.auth.model;

import java.time.Instant;
import java.util.UUID;

/**
 * 仅供自动化测试构造账号的密码凭据查询结果。
 *
 * @author Wreckloud
 * @since 2026-09-09
 */
public record LocalCredential(
        UUID id,
        String nickname,
        String avatar,
        boolean administrator,
        String passwordHash,
        String signature,
        Instant createdAt
) {

    public AuthUser user() {
        return new AuthUser(id, nickname, avatar, administrator, signature, createdAt);
    }
}
