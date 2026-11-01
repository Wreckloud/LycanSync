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
        @Schema(description = "在线或闲置时的最近心跳时间；离线时为空") Instant lastSeenAt,
        UserActivityType activityType,
        String activityName,
        Instant activityStartedAt,
        @Schema(description = "上次公开在线时间；在线、未开放或未知时为空") Instant lastOnlineAt,
        @Schema(description = "最近一段已结束的公开游戏；未开放或未知时为空") RecentGame recentGame
) {
    @Schema(description = "最近一段公开游戏，不包含隐身或关闭动态期间")
    public record RecentGame(String name, Instant endedAt, long playedSeconds) {
    }
}
