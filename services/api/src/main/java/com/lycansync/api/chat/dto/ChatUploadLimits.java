package com.lycansync.api.chat.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Positive;

/**
 * 群聊文件上传的有效限额。
 *
 * @author Wreckloud
 * @since 2026-11-20
 */
@Schema(description = "单文件限额与服务器群文件总容量，单位为字节")
public record ChatUploadLimits(@Positive @Max(9007199254740991L) long maxFileBytes,
                              @Positive @Max(9007199254740991L) long maxStorageBytes) { }
