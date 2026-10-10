package com.lycansync.api.auth.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.UUID;

/**
 * 服主生成链接的请求。
 * @author Wreckloud
 * @since 2026-10-10
 */
public record AccessLinkRequest(
        @Schema(description = "INVITE 邀请新朋友，RECOVERY 恢复成员登录")
        @NotNull @Pattern(regexp = "INVITE|RECOVERY") String kind,
        @Schema(description = "恢复时必须指定原成员") UUID targetId,
        @Size(max = 100) String note) { }
