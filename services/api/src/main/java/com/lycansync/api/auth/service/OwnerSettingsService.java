package com.lycansync.api.auth.service;

import com.lycansync.api.auth.config.AccountAccessProperties;
import com.lycansync.api.auth.config.QqLoginProperties;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.rtc.config.LiveKitProperties;
import io.swagger.v3.oas.annotations.media.Schema;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/**
 * 服主可见的部署配置状态；只确认配置，不探测设备或返回密钥。
 *
 * @author Wreckloud
 * @since 2026-11-04
 */
@Service
@RequiredArgsConstructor
public class OwnerSettingsService {
    private final AuthMapper users;
    private final AccountAccessProperties account;
    private final QqLoginProperties qq;
    private final ObjectProvider<LiveKitProperties> media;

    @Schema(description = "服务器配置状态，不代表连接或真实授权验证通过")
    public record Status(String serverName, boolean publicUrlConfigured, boolean qqEnabled, boolean mediaConfigured) { }

    public Status status(AuthenticatedUser user) {
        if (user == null || !user.administrator()) throw denied();
        AuthUser current = users.findUserProfile(user.id());
        if (current == null || current.deletedAt() != null || !current.administrator()) throw denied();
        return new Status(account.getServerName(), !account.getPublicUrl().isBlank(), qq.isEnabled(), media.getIfAvailable() != null);
    }

    private AuthException denied() {
        return new AuthException(HttpStatus.FORBIDDEN, ApiErrorCode.ACCESS_DENIED, "只有当前服主可以查看服务器配置");
    }
}
