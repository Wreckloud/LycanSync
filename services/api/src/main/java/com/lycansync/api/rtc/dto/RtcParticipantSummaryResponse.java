package com.lycansync.api.rtc.dto;

import io.swagger.v3.oas.annotations.media.Schema;

/**
 * 房间外可见的参与者身份与显示名称。
 *
 * @author Wreckloud
 * @since 2026-09-12
 */
@Schema(description = "当前语音参与者，不包含头像和媒体状态")
public record RtcParticipantSummaryResponse(
        @Schema(description = "稳定的 LiveKit 参与者身份") String participantIdentity,
        @Schema(description = "入房时的显示昵称") String displayName
) {
}
