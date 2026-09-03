package com.lycansync.api.rtc.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
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
@Profile("rtc-local")
@EnableConfigurationProperties(LiveKitProperties.class)
public class LocalRtcConfiguration {

    public LocalRtcConfiguration(
            @Value("${server.address:}") String serverAddress,
            LiveKitProperties liveKitProperties
    ) {
        // 未接入登录的签发入口只能本机访问，配置被覆盖时也不能开放监听。
        Assert.state("127.0.0.1".equals(serverAddress),
                "rtc-local 模式要求 server.address=127.0.0.1，禁止开放匿名入房接口");
        // 单独检查密钥长度，避免配置绑定错误报告把被拒绝的密钥原文打印出来。
        Assert.state(liveKitProperties.getApiSecret().length() >= 32,
                "LIVEKIT_API_SECRET 至少需要 32 个字符，请使用随机生成的密钥");
    }
}
