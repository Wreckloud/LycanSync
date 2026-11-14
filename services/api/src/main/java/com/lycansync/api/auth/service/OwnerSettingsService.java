package com.lycansync.api.auth.service;

import com.lycansync.api.auth.config.AccountAccessProperties;
import com.lycansync.api.auth.dto.QqConfigurationRequest;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.mapper.AccessLinkMapper;
import com.lycansync.api.auth.mapper.QqConfigurationMapper;
import com.lycansync.api.auth.mapper.QqIdentityMapper;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.model.QqConfiguration;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.rtc.config.LiveKitProperties;
import io.swagger.v3.oas.annotations.media.Schema;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 服主可见的服务器配置管理，不探测设备或返回密钥。
 *
 * @author Wreckloud
 * @since 2026-11-04
 */
@Service
@RequiredArgsConstructor
public class OwnerSettingsService {
    private final AuthMapper users;
    private final AccountAccessProperties account;
    private final QqConfigurationService qq;
    private final QqConfigurationMapper configurations;
    private final QqIdentityMapper identities;
    private final AccessLinkMapper access;
    private final ObjectProvider<LiveKitProperties> media;

    @Schema(description = "服务器配置状态，不代表连接或真实授权验证通过")
    public record Status(String serverName, boolean publicUrlConfigured, boolean qqEnabled, boolean mediaConfigured) { }

    public Status status(AuthenticatedUser user) {
        requireOwner(user);
        return new Status(account.getServerName(), !account.getPublicUrl().isBlank(), qq.isEnabled(), media.getIfAvailable() != null);
    }

    @Schema(description = "QQ 应用配置，密钥只返回是否已设置")
    public record QqSettings(boolean enabled, String appId, String callbackUrl, boolean appKeyConfigured,
                             @Schema(description = "启用配置的本地校验错误；空字符串不代表腾讯实际授权已验证") String configurationError) { }

    public QqSettings qqSettings(AuthenticatedUser user) {
        requireOwner(user);
        return summary(qq.current());
    }

    @Transactional
    public QqSettings saveQqSettings(AuthenticatedUser user, QqConfigurationRequest request) {
        requireOwner(user);
        // 与服主转让、QQ 绑定共用初始化行锁，防止校验后身份或应用关联改变。
        if (!Boolean.TRUE.equals(access.lockInitialization())) throw invalid("服务器尚未完成首次激活");
        requireOwner(user);
        QqConfiguration previous = qq.current();
        String appId = request.appId().strip();
        if (identities.hasOtherApplication(appId)) throw invalid("已有成员绑定 QQ，不能更换 App ID。请继续使用原来的 QQ 应用");
        String appKey = request.appKey().isEmpty() && appId.equals(previous.appId()) ? previous.appKey() : request.appKey();
        QqConfiguration next = new QqConfiguration(request.enabled(), appId, appKey, request.callbackUrl().strip());
        if (next.enabled() || !appId.isEmpty() || !appKey.isEmpty() || !next.callbackUrl().isEmpty()) {
            String error = next.validationError();
            if (!error.isEmpty()) throw invalid(error);
        }
        if (configurations.save(next) != 1) throw new IllegalStateException("QQ 登录配置未保存");
        return summary(next);
    }

    private QqSettings summary(QqConfiguration configuration) {
        return new QqSettings(configuration.enabled(), configuration.appId(), configuration.callbackUrl(), !configuration.appKey().isEmpty(),
                configuration.enabled() ? configuration.validationError() : "");
    }

    private void requireOwner(AuthenticatedUser user) {
        if (user == null || !user.administrator()) throw denied();
        AuthUser current = users.findUserProfile(user.id());
        if (current == null || current.deletedAt() != null || !current.administrator()) throw denied();
    }

    private AuthException denied() {
        return new AuthException(HttpStatus.FORBIDDEN, ApiErrorCode.ACCESS_DENIED, "只有当前服主可以管理服务器配置");
    }

    private AuthException invalid(String message) {
        return new AuthException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST, message);
    }
}
