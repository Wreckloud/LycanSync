package com.lycansync.api.chat.model;

import java.util.UUID;

/**
 * 与群聊消息一对一关联的图片二进制内容。
 *
 * @author Wreckloud
 * @since 2026-09-14
 */
public record ChatAttachment(UUID id, UUID messageId, String contentType, int width, int height,
                             int byteSize, byte[] data) {
}
