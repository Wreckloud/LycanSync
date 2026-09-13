package com.lycansync.api.group.model;

import java.time.Instant;
import java.util.UUID;

/**
 * 所有注册用户在群组中的公开资料。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
public record GroupMember(
        UUID userId,
        String nickname,
        String avatar,
        GroupRole role,
        Instant joinedAt
) {
}
