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
        @Schema(description = "裁剪后的 PNG/JPEG data URL，最多 1024 × 1024、2 MiB；服务器统一为 256 × 256 PNG；空串移除头像")
        String avatar,
        @Size(max = 120)
        @Schema(description = "选填个性签名，最多 120 个字符；空串清空，省略或 null 保留原值")
        String signature
) {
}
