package com.lycansync.api.auth.config;

import lombok.Getter;
import lombok.Setter;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 邀请准入的部署配置。
 * @author Wreckloud
 * @since 2026-10-10
 */
@Getter
@Setter
@Component
@ConfigurationProperties(prefix = "lycansync.account")
public class AccountAccessProperties {
    private String mode = "invite";
    private String publicUrl = "";
    private String serverName = "LycanSync";
    private String bootstrapFile = "./var/bootstrap/admin-activation.txt";
}
