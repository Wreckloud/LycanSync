package com.lycansync.api.chat.dto;

import io.swagger.v3.oas.annotations.media.Schema;

/**
 * 按需兼容视频的生成状态，不暴露服务器文件路径。
 *
 * @author Wreckloud
 * @since 2026-11-15
 */
@Schema(description = "兼容视频预览状态")
public record ChatVideoPreviewResponse(
        @Schema(description = "absent、processing、ready 或 failed") String status,
        @Schema(description = "转换失败时可展示的说明") String message) {
}
