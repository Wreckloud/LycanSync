package com.lycansync.api.group.dto;

import io.swagger.v3.oas.annotations.media.Schema;

import java.util.UUID;

/**
 * 群组在线状态变化等待接口的轻量游标响应。
 *
 * @author Wreckloud
 * @since 2026-09-30
 */
@Schema(description = "群组在线状态变化游标")
public record GroupPresenceChangeResponse(
        UUID serverInstanceId,
        long version,
        boolean changed
) {
}
