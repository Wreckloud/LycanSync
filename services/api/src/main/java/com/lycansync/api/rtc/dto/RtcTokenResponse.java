package com.lycansync.api.rtc.dto;

import io.swagger.v3.oas.annotations.media.Schema;

import java.time.Instant;

/**
 * RTC 入房凭证响应。
 *
 * @author Wreckloud
 * @since 2026-09-03
 */
@Schema(description = "RTC 入房凭证，签发成功不代表已经连接 LiveKit")
public record RtcTokenResponse(
        @Schema(description = "LiveKit 信令连接地址", example = "ws://127.0.0.1:7880")
        String serverUrl,

        @Schema(description = "允许加入的群组房间", example = "lycan-sync-dev-pack")
        String roomName,

        @Schema(description = "服务端为本次请求生成的临时参与者标识")
        String participantIdentity,

        @Schema(description = "已签名的 JWT 入房凭证，不应写入日志或分享给他人")
        String token,

        @Schema(description = "初次入房凭证的过期时间，不是强制结束通话的时间")
        Instant expiresAt
) {
}
