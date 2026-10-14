package com.lycansync.api.group.dto;

import com.lycansync.api.group.model.GroupRole;
import io.swagger.v3.oas.annotations.media.Schema;

import java.time.Instant;
import java.util.UUID;

/**
 * 当前群成员的公开资料与实际入群时间。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
@Schema(description = "群组成员公开资料")
public record GroupMemberResponse(
        UUID userId,
        String nickname,
        String avatar,
        GroupRole role,
        Instant joinedAt
) {
}
