package com.lycansync.api.chat.model;

import java.util.UUID;

/**
 * 群聊文件下载所需的元数据。
 *
 * @author Wreckloud
 * @since 2026-09-29
 */
public record ChatFileMetadata(UUID id, String fileName, long byteSize) {
}
