package com.lycansync.api.chat.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import java.util.List;

/**
 * 群聊消息的单页响应。
 *
 * @author Wreckloud
 * @since 2026-09-14
 */
@Schema(description = "群聊消息列表")
public record ChatMessagePageResponse(
        @Schema(description = "按群内消息序号正序排列的消息") List<ChatMessageResponse> messages,
        @Schema(description = "是否还有更早消息") boolean hasMore) {
}
