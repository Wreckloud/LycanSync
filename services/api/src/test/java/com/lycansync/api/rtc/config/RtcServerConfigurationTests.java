package com.lycansync.api.rtc.config;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 独立服务器 RTC 配置边界测试。
 *
 * @author Wreckloud
 * @since 2026-10-09
 */
class RtcServerConfigurationTests {

    private final ApplicationContextRunner contextRunner = new ApplicationContextRunner()
            .withUserConfiguration(RtcServerConfiguration.class)
            .withPropertyValues(
                    "spring.profiles.active=rtc-server",
                    "lycansync.rtc.server-url=wss://example.com:8443",
                    "lycansync.rtc.api-url=http://livekit:7990",
                    "lycansync.rtc.api-key=server-test-key",
                    "lycansync.rtc.api-secret=server-test-secret-at-least-32-characters"
            );

    @Test
    void shouldEnableServerConfigurationWithSecureClientEndpoint() {
        contextRunner.run(context -> assertThat(context).hasNotFailed()
                .hasSingleBean(LiveKitProperties.class));
    }

    @Test
    void shouldRefuseInsecureClientEndpoint() {
        contextRunner.withPropertyValues("lycansync.rtc.server-url=ws://example.com:7990")
                .run(context -> assertThat(context).hasFailed());
    }

    @Test
    void shouldRefuseWeakSigningSecret() {
        contextRunner.withPropertyValues("lycansync.rtc.api-secret=short")
                .run(context -> assertThat(context).hasFailed());
    }

    @Test
    void shouldLeaveLocalConfigurationIndependent() {
        contextRunner.withPropertyValues("spring.profiles.active=rtc-local")
                .run(context -> assertThat(context).hasNotFailed()
                        .doesNotHaveBean(LiveKitProperties.class));
    }
}
