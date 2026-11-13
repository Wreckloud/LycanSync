package com.lycansync.api.auth.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/**
 * 服主保存 QQ 应用配置的请求，不回传已保存的密钥。
 *
 * @author Wreckloud
 * @since 2026-11-13
 */
public record QqConfigurationRequest(
        @Schema(description = "是否允许 QQ 登录与绑定") @NotNull Boolean enabled,
        @Schema(description = "QQ 互联应用 App ID") @NotNull @Size(max = 20) String appId,
        @Schema(description = "App Key；留空保留同一应用的已有密钥", accessMode = Schema.AccessMode.WRITE_ONLY)
        @NotNull @Size(max = 128) String appKey,
        @Schema(description = "HTTPS 回调地址，路径必须为 /api/auth/qq/callback")
        @NotNull @Size(max = 2048) String callbackUrl) {
    @Override
    public String toString() { return "QqConfigurationRequest[enabled=" + enabled + "]"; }
}
