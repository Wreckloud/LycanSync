package com.lycansync.api.group.dto;

import com.lycansync.api.group.model.GroupRole;
import io.swagger.v3.oas.annotations.media.Schema;

import java.time.Instant;
import java.util.UUID;

/**
 * 当前用户的群组摘要。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
@Schema(description = "当前用户可访问的群组摘要")
public record GroupSummaryResponse(
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
