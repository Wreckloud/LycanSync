package com.lycansync.api.system.dto;

import io.swagger.v3.oas.annotations.media.Schema;

/**
 * 系统初始化状态响应。
 *
 * @author Wreckloud
 * @since 2026-09-02
 */
@Schema(description = "系统初始化状态响应")
public record SystemInitializationStatusResponse(
        @Schema(description = "是否已完成首次管理员初始化", example = "false")
        boolean initialized
) {
}
