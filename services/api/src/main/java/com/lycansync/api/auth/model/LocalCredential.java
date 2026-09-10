package com.lycansync.api.auth.model;

import java.util.UUID;

/**
 * 本地账号凭据查询结果。
 *
 * @author Wreckloud
 * @since 2026-09-09
 */
public record LocalCredential(
        UUID id,
        String nickname,
        String avatar,
        boolean administrator,
        String passwordHash
) {

    public AuthUser user() {
        return new AuthUser(id, nickname, avatar, administrator);
    }
}
