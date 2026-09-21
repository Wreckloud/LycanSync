package com.lycansync.api.rtc.dto;

import io.swagger.v3.oas.annotations.media.Schema;

import java.util.UUID;

/**
 * 群组语音房间当前占用人数。
 *
 * @author Wreckloud
 * @since 2026-09-20
 */
@Schema(description = "群组语音房间当前占用人数")
public record RtcRoomOccupancyResponse(
        UUID groupId,
        @Schema(minimum = "0") int participantCount
) {
}
