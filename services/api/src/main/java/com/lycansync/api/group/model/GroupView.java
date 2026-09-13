package com.lycansync.api.group.model;

import java.time.Instant;
import java.util.UUID;

/**
 * 群组资料及当前用户在群内的角色。
 *
 * @author Wreckloud
 * @since 2026-09-13
 */
public record GroupView(
        UUID id,
        String name,
        String description,
        String avatar,
        GroupRole role,
        long memberCount,
        Instant createdAt,
        Instant updatedAt
) {
}
