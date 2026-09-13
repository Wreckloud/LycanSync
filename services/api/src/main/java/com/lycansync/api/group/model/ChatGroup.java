package com.lycansync.api.group.model;

import java.time.Instant;
import java.util.UUID;

/**
 * 持久化群组基本资料。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
public record ChatGroup(
        UUID id,
        String name,
        String description,
        String avatar,
        UUID ownerUserId,
        Instant createdAt,
        Instant updatedAt
) {
}
