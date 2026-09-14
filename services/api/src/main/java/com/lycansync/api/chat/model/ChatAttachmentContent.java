package com.lycansync.api.chat.model;

import java.util.UUID;

/**
 * 下载图片时读取的附件数据。
 *
 * @author Wreckloud
 * @since 2026-09-14
 */
public record ChatAttachmentContent(UUID id, String contentType, byte[] data) {
}
