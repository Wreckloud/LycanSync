package com.lycansync.api.auth.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/**
 * 自定义个人资料。
 *
 * @author Wreckloud
 * @since 2026-09-06
 */
@Schema(description = "自定义个人资料")
public record ProfileUpdateRequest(
        @NotBlank
        @Size(max = 32)
        @Schema(description = "显示昵称，最多 32 个字符", example = "Wreckloud")
        String nickname,
        @NotNull
        @Size(max = 700000)
        @Schema(description = "PNG/JPEG data URL；空串表示移除头像")
        String avatar
) {
}
