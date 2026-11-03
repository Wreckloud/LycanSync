package com.lycansync.api.auth.config;

import lombok.Getter;
import lombok.Setter;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

import java.net.URI;
import jakarta.annotation.PostConstruct;

/**
 * QQ 互联固定应用配置，密钥仅由部署环境注入。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
@Getter
@Setter
@Component
@ConfigurationProperties(prefix = "lycansync.qq")
public class QqLoginProperties {
    private boolean enabled;
    private String appId = "";
    private String appKey = "";
    private String callbackUrl = "";

    @PostConstruct
    public void validate() {
        if (enabled) publicUrl();
    }

    public String publicUrl() {
        URI callback = URI.create(callbackUrl);
        if (!appId.matches("[0-9]{5,20}") || appKey.isBlank()
                || !"https".equals(callback.getScheme()) || callback.getHost() == null
                || callback.getUserInfo() != null || callback.getPort() != -1
                || callback.getQuery() != null || callback.getFragment() != null
                || !"/api/auth/qq/callback".equals(callback.getPath())) {
            throw new IllegalStateException("QQ 登录配置不完整或回调地址不符合要求");
        }
        return "https://" + callback.getHost();
    }
}
