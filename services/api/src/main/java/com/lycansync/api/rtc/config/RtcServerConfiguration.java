package com.lycansync.api.rtc.config;

import io.livekit.server.RoomServiceClient;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.util.Assert;

/**
 * 独立服务器的 RTC 连接与签名配置。
 *
 * @author Wreckloud
 * @since 2026-10-09
 */
@Configuration(proxyBeanMethods = false)
@Profile("rtc-server & !rtc-local")
@EnableConfigurationProperties(LiveKitProperties.class)
public class RtcServerConfiguration {

    public RtcServerConfiguration(LiveKitProperties properties) {
        Assert.state(properties.getServerUrl().startsWith("wss://"),
                "rtc-server 模式要求客户端使用 WSS 信令地址");
        Assert.state(properties.getApiSecret().length() >= 32,
                "LIVEKIT_API_SECRET 至少需要 32 个字符，请使用随机生成的密钥");
    }

    @Bean
    public RoomServiceClient serverRoomServiceClient(LiveKitProperties properties) {
        // 内部 API 地址与客户端的 WSS 地址分离，签名密钥只留在服务端。
        return RoomServiceClient.createClient(properties.getApiUrl(),
                properties.getApiKey(), properties.getApiSecret());
    }
}
