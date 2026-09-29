package com.lycansync.api.chat.model;

import java.time.Instant;
import java.util.UUID;

/**
 * 正在接收的群聊文件配额预留。
 *
 * @author Wreckloud
 * @since 2026-09-29
 */
public record ChatFileUploadReservation(UUID id, long byteSize, Instant createdAt) {
}
