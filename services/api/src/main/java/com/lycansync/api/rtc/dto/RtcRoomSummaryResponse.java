package com.lycansync.api.rtc.dto;

import io.swagger.v3.oas.annotations.media.Schema;

import java.util.List;

/**
 * RTC 房间外可见摘要。
 *
 * @author Wreckloud
 * @since 2026-09-04
 */
@Schema(description = "房间外可见的语音成员摘要，不包含媒体和发言状态")
public record RtcRoomSummaryResponse(
        @Schema(description = "当前语音成员数量", example = "2")
        int participantCount,

        @Schema(description = "当前语音成员身份与昵称，按加入顺序排列")
        List<RtcParticipantSummaryResponse> participants
) {

    public RtcRoomSummaryResponse {
        participants = List.copyOf(participants);
    }
}
