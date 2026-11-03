package com.lycansync.api.rtc.dto;

import io.swagger.v3.oas.annotations.media.Schema;

/**
 * 当前账号经服务器确认的累计语音时长。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
@Schema(description = "当前账号累计语音时长")
public record VoiceTimeResponse(@Schema(description = "已确认秒数", minimum = "0") long seconds) {
}
