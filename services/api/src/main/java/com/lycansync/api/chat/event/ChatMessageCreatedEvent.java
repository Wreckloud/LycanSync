package com.lycansync.api.chat.event;

import java.util.UUID;

/**
 * 已提交的群聊消息变化，不携带正文或附件。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
public record ChatMessageCreatedEvent(UUID groupId) {
}
