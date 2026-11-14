package com.lycansync.api.auth.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/**
 * 修改仅服主可见的链接备注，不更换链接。
 * @author Wreckloud
 * @since 2026-11-14
 */
public record AccessLinkNoteRequest(
        @Schema(description = "链接备注，留空可清除") @NotNull @Size(max = 100) String note) { }
