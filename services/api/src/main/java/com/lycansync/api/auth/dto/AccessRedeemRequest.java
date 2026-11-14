package com.lycansync.api.auth.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;

/**
 * 用户明确确认后兑换一次性链接。
 * @author Wreckloud
 * @since 2026-10-10
 */
public record AccessRedeemRequest(@Schema(description = "链接中的一次性凭据")
        @NotNull @Pattern(regexp = "[A-Za-z0-9_-]{43}") String token,
        @Schema(description = "兑换确认时必须提供的客户端重试凭据；预览时可省略")
        @Pattern(regexp = "[A-Za-z0-9_-]{43}") String redemptionKey,
        @Schema(description = "首次激活服主时必须设置，其他链接不使用")
        @jakarta.validation.constraints.Size(min = 6, max = 128, message = "恢复密码长度不符合要求") String recoveryPassword) {
    public AccessRedeemRequest(String token, String redemptionKey) { this(token, redemptionKey, null); }
}
