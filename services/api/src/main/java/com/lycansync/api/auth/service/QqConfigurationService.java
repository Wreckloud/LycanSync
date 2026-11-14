package com.lycansync.api.auth.service;

import com.lycansync.api.auth.config.QqLoginProperties;
import com.lycansync.api.auth.mapper.QqConfigurationMapper;
import com.lycansync.api.auth.model.QqConfiguration;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

/**
 * 设置页保存后以数据库配置为准；未保存的部署继续沿用环境配置。
 *
 * @author Wreckloud
 * @since 2026-11-13
 */
@Service
@RequiredArgsConstructor
public class QqConfigurationService {
    private final QqLoginProperties defaults;
    private final QqConfigurationMapper configurations;

    public QqConfiguration current() {
        QqConfiguration saved = configurations.find();
        return saved == null ? new QqConfiguration(defaults.isEnabled(), defaults.getAppId(),
                defaults.getAppKey(), defaults.getCallbackUrl()) : saved;
    }

    public boolean isEnabled() {
        QqConfiguration configuration = current();
        // QQ 配置不完整只关闭可选入口，服主仍可登录并修正配置。
        return configuration.enabled() && configuration.validationError().isEmpty();
    }
}
