package com.lycansync.api.auth.dto;

import com.lycansync.api.auth.model.AuthUser;
import io.swagger.v3.oas.annotations.media.Schema;

/**
 * QQ 登录结果与首次资料确认资格，不包含 QQ 授权令牌。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
@Schema(description = "QQ 登录成功结果，首次创建账号后进入资料确认")
public record QqLoginResponse(
        @Schema(description = "本地 Bearer 会话，仅交付原发起端") String sessionToken,
        AuthUser user,
        @Schema(description = "本次授权是否新建了本地账号") boolean newAccount
) { }
