package com.lycansync.api.group.dto;

import com.lycansync.api.presence.model.UserActivityType;
import com.lycansync.api.presence.model.UserPresenceStatus;
import io.swagger.v3.oas.annotations.media.Schema;

import java.time.Instant;
import java.util.UUID;

/**
 * 群组成员的轻量在线与活动状态。
 *
 * @author Wreckloud
 * @since 2026-09-20
 */
@Schema(description = "群组成员在线状态")
public record GroupPresenceResponse(
        UUID userId,
        UserPresenceStatus status,
        Instant lastSeenAt,
        UserActivityType activityType,
        String activityName,
        Instant activityStartedAt
) {
}
