package com.lycansync.api.auth.config;

import lombok.Getter;
import lombok.Setter;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * QQ 互联初始部署配置；设置页保存后以服务端数据库为准。
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
}
