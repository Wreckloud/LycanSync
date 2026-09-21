package com.lycansync.api.presence.dto;

import com.lycansync.api.presence.model.UserActivityType;
import com.lycansync.api.presence.model.UserPresenceStatus;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * 客户端心跳上报当前在线状态。
 *
 * @author Wreckloud
 * @since 2026-09-20
 */
@Schema(description = "在线状态心跳")
public record PresenceHeartbeatRequest(
        @NotNull @Schema(description = "当前状态", example = "ONLINE")
        UserPresenceStatus status,
        @Valid @Schema(description = "当前公开活动；没有可公开活动时为空")
        Activity activity
) {

    @Schema(description = "用户当前公开活动")
    public record Activity(
            @NotNull @Schema(description = "活动类型", example = "GAME")
            UserActivityType type,
            @NotBlank @Size(max = 80) @Pattern(regexp = "^[^\\p{Cntrl}]*$")
            @Schema(description = "活动名称", example = "Core Keeper")
            String name
    ) {
    }
}
