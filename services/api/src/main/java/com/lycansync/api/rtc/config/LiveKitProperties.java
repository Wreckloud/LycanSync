package com.lycansync.api.rtc.config;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import lombok.Getter;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * LiveKit 连接与签名配置。
 *
 * @author Wreckloud
 * @since 2026-09-03
 */
@Getter
@RequiredArgsConstructor
@Validated
@ConfigurationProperties(prefix = "lycansync.rtc")
public class LiveKitProperties {

    // 客户端连接 LiveKit 的信令地址，不是 Spring Boot 的接口地址。
    @NotBlank
    private final String serverUrl;

    // 服务端通过 HTTP API 查询房间摘要，不会返回给浏览器。
    @NotBlank
    @Pattern(regexp = "https?://.+")
    private final String apiUrl;

    // 标识使用哪一组签名密钥，LiveKit 据此查找对应的 secret。
    @NotBlank
    @Pattern(regexp = "[A-Za-z0-9_-]+")
    private final String apiKey;

    // 仅由服务端持有，用于签名，不能返回给客户端。
    @NotBlank
    private final String apiSecret;
}
