package com.lycansync.api.system.dto;

import io.swagger.v3.oas.annotations.media.Schema;

import java.time.Instant;

/**
 * 系统状态响应。
 *
 * @author Wreckloud
 * @since 2026-09-01
 */
@Schema(description = "系统状态响应")
public record SystemStatusResponse(
        @Schema(description = "当前 API 版本", example = "v1")
        String apiVersion,

        @Schema(
                description = "服务器 UTC 时间",
                example = "2026-09-01T12:00:00Z"
        )
        Instant serverTime
) {
}
