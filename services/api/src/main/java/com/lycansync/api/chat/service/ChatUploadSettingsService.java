package com.lycansync.api.chat.service;

import com.lycansync.api.auth.mapper.AccessLinkMapper;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.service.OwnerSettingsService;
import com.lycansync.api.chat.config.ChatFileProperties;
import com.lycansync.api.chat.dto.ChatUploadLimits;
import com.lycansync.api.chat.mapper.ChatMapper;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.group.exception.GroupException;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;

/**
 * 群文件限额与服主配置。
 *
 * @author Wreckloud
 * @since 2026-11-20
 */
@Service
@RequiredArgsConstructor
public class ChatUploadSettingsService {
    private final ChatMapper mapper;
    private final ChatFileProperties properties;
    private final OwnerSettingsService owners;
    private final AccessLinkMapper access;

    public ChatUploadLimits limits() {
        ChatUploadLimits limits = mapper.findUploadLimits(properties.getMaxFileSize(), properties.getMaxStorageSize());
        if (limits == null) throw new IllegalStateException("缺少群聊文件容量记录");
        return limits;
    }

    public void checkFileSize(long size) {
        long limit = limits().maxFileBytes();
        if (size < 0) throw new GroupException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST, "文件大小无效");
        if (size > limit) {
            throw new GroupException(HttpStatus.PAYLOAD_TOO_LARGE, ApiErrorCode.INVALID_REQUEST,
                    "单个文件上限为 " + BigDecimal.valueOf(limit).divide(BigDecimal.valueOf(1048576), 6,
                            RoundingMode.HALF_UP).stripTrailingZeros().toPlainString() + " MiB");
        }
    }

    @Transactional
    public ChatUploadLimits save(AuthenticatedUser user, ChatUploadLimits limits) {
        owners.requireOwner(user);
        if (!Boolean.TRUE.equals(access.lockInitialization())) {
            throw new GroupException(HttpStatus.CONFLICT, ApiErrorCode.INVALID_REQUEST, "服务器尚未完成首次激活");
        }
        owners.requireOwner(user);
        if (limits.maxFileBytes() > limits.maxStorageBytes()) {
            throw new GroupException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST, "单文件上限不能超过文件总容量");
        }
        if (mapper.saveLimits(limits.maxFileBytes(), limits.maxStorageBytes()) != 1) {
            throw new GroupException(HttpStatus.CONFLICT, ApiErrorCode.INVALID_REQUEST, "文件总容量低于已使用和上传中的空间");
        }
        return limits;
    }
}
