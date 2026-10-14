package com.lycansync.api.group.model;

import java.time.Instant;
import java.util.UUID;

/**
 * 当前群成员的公开资料和入群时间。
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
