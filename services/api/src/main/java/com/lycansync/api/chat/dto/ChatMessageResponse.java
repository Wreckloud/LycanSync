package com.lycansync.api.chat.dto;

import com.lycansync.api.chat.model.ChatMessageType;
import io.swagger.v3.oas.annotations.media.Schema;
import java.time.Instant;
import java.util.UUID;

/**
 * 群聊消息的客户端响应。
 *
 * @author Wreckloud
 * @since 2026-09-14
 */
@Schema(description = "群聊消息")
public record ChatMessageResponse(
        @Schema(description = "消息 ID") UUID id,
        @Schema(description = "发送者用户 ID") UUID senderUserId,
        @Schema(description = "发送者昵称") String senderNickname,
        @Schema(description = "消息类型") ChatMessageType type,
        @Schema(description = "文本内容；图片消息可附带说明") String content,
        @Schema(description = "发送时间") Instant createdAt,
        @Schema(description = "图片或文件附件；纯文本时为空") ChatAttachmentResponse attachment) {
}
