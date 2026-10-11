package com.lycansync.api.group.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * 创建群组请求。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
@Schema(description = "创建群组请求")
public record CreateGroupRequest(
        @NotBlank
        @Size(max = 32)
        @Schema(description = "群组名称，最多 32 个字符", example = "周末开黑")
        String name,
        @Size(max = 200)
        @Schema(description = "群组描述，可省略或留空", example = "周六晚上随叫随到")
        String description,
        @Schema(description = "裁剪后的 PNG/JPEG data URL，最多 1024 × 1024、2 MiB；服务器统一为 256 × 256 PNG；可省略")
        String avatar
) {
}
