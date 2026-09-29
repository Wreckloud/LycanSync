package com.lycansync.api.chat.service;

import com.lycansync.api.chat.config.ChatFileProperties;
import com.lycansync.api.chat.mapper.ChatMapper;
import com.lycansync.api.chat.model.ChatFileUploadReservation;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.group.exception.GroupException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 群聊文件存储额度预留与结算。
 *
 * @author Wreckloud
 * @since 2026-09-29
 */
@Service
public class ChatFileQuotaService {

    private final ChatMapper mapper;
    private final ChatFileProperties properties;
    private final Clock systemClock;

    public ChatFileQuotaService(ChatMapper mapper, ChatFileProperties properties, Clock systemClock) {
        this.mapper = mapper;
        this.properties = properties;
        this.systemClock = systemClock;
    }

    @Transactional
    public void reserve(UUID uploadId, UUID groupId, long byteSize) {
        int reserved = mapper.reserveFileStorage(uploadId, groupId, byteSize,
                properties.getMaxStorageSize(), Instant.now(systemClock));
        if (reserved != 1) {
            throw new GroupException(HttpStatus.INSUFFICIENT_STORAGE, ApiErrorCode.CHAT_FILE_STORAGE_FULL,
                    "服务器文件存储空间不足");
        }
    }

    @Transactional
    public void complete(UUID uploadId, long byteSize) {
        if (mapper.completeFileStorageReservation(uploadId, byteSize) != 1) {
            throw new IllegalStateException("文件存储额度预留已失效");
        }
    }

    @Transactional
    public void release(UUID uploadId) {
        mapper.releaseFileStorageReservation(uploadId);
    }

    public List<ChatFileUploadReservation> findExpiredReservations(Instant createdBefore) {
        return mapper.findExpiredFileStorageReservations(createdBefore);
    }

    public boolean fileExists(UUID attachmentId) {
        return mapper.fileAttachmentExists(attachmentId);
    }
}
