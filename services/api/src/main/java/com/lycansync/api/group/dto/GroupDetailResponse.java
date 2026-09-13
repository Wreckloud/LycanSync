package com.lycansync.api.group.dto;

import com.lycansync.api.group.model.GroupRole;
import io.swagger.v3.oas.annotations.media.Schema;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 群组详情及成员列表。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
@Schema(description = "群组详情及成员列表")
public record GroupDetailResponse(
        UUID id,
        String name,
        String description,
        String avatar,
        GroupRole role,
        long memberCount,
        Instant createdAt,
        Instant updatedAt,
        List<GroupMemberResponse> members
) {
}
