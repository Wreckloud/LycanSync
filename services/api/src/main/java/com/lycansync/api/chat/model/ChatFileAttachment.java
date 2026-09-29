package com.lycansync.api.chat.model;

import java.util.UUID;

/**
 * 元数据和群聊消息关联的普通文件附件。
 *
 * @author Wreckloud
 * @since 2026-09-29
 */
public record ChatFileAttachment(UUID id, UUID messageId, UUID uploadId, String fileName, long byteSize) {
}
