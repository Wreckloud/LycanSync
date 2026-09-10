package com.lycansync.api.rtc.config;

import io.livekit.server.RoomServiceClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.util.Assert;

/**
 * 本地 RTC 调试配置。
 *
 * @author Wreckloud
 * @since 2026-09-03
 */
@Configuration(proxyBeanMethods = false)
// TODO: 完成公网媒体端口与群组权限验证后，再引入非本机 RTC 配置。
@Profile("rtc-local")
@EnableConfigurationProperties(LiveKitProperties.class)
public class LocalRtcConfiguration {

    public LocalRtcConfiguration(
            @Value("${server.address:}") String serverAddress,
            LiveKitProperties liveKitProperties
    ) {
        // 当前媒体配置仅适用于本机，接入登录不代表已经完成公网部署。
        Assert.state("127.0.0.1".equals(serverAddress),
                "rtc-local 模式要求 server.address=127.0.0.1，当前媒体配置仅适用于本机");
        // 单独检查密钥长度，避免配置绑定错误报告把被拒绝的密钥原文打印出来。
        Assert.state(liveKitProperties.getApiSecret().length() >= 32,
                "LIVEKIT_API_SECRET 至少需要 32 个字符，请使用随机生成的密钥");
    }

    @Bean
    public RoomServiceClient localRoomServiceClient(LiveKitProperties liveKitProperties) {
        return RoomServiceClient.createClient(
                liveKitProperties.getApiUrl(),
                liveKitProperties.getApiKey(),
                liveKitProperties.getApiSecret());
    }
}
