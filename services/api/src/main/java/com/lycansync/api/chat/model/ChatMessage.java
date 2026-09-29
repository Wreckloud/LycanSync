package com.lycansync.api.chat.model;

import java.time.Instant;
import java.util.UUID;

/**
 * 待保存的群聊消息。
 *
 * @author Wreckloud
 * @since 2026-09-14
 */
public record ChatMessage(UUID id, UUID groupId, UUID senderUserId, ChatMessageType type,
                          String content, Instant createdAt, long sequenceNumber) {
}
