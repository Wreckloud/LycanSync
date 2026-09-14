package com.lycansync.api.chat.model;

import java.time.Instant;
import java.util.UUID;

/**
 * 群聊列表的消息查询投影。
 *
 * @author Wreckloud
 * @since 2026-09-14
 */
public record ChatMessageView(UUID id, UUID senderUserId, String senderNickname, ChatMessageType type,
                              String content, Instant createdAt, UUID attachmentId, String attachmentContentType,
                              Integer attachmentWidth, Integer attachmentHeight, Integer attachmentByteSize) {
}
