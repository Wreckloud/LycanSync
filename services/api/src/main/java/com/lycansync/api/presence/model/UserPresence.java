package com.lycansync.api.presence.model;

import java.time.Instant;
import java.util.UUID;

/**
 * 用户在线状态持久化记录。
 *
 * @author Wreckloud
 * @since 2026-09-20
 */
public record UserPresence(
        UUID userId,
        UserPresenceStatus status,
        Instant lastSeenAt,
        UserActivityType activityType,
        String activityName,
        Instant activityStartedAt,
        Instant updatedAt
) {
}
