package com.lycansync.api.rtc.config;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 本地 RTC 配置与启用边界测试。
 *
 * @author Wreckloud
 * @since 2026-09-03
 */
class LocalRtcConfigurationTests {

    private final ApplicationContextRunner contextRunner = new ApplicationContextRunner()
            .withUserConfiguration(LocalRtcConfiguration.class)
            .withPropertyValues(
                    "spring.profiles.active=rtc-local",
                    "server.address=127.0.0.1",
                    "lycansync.rtc.server-url=ws://127.0.0.1:7880",
                    "lycansync.rtc.api-key=local-test-key",
                    "lycansync.rtc.api-secret=local-test-secret-at-least-32-characters"
            );

    @Test
    void shouldBindExplicitLocalConfiguration() {
        contextRunner.run(context -> {
            assertThat(context).hasNotFailed().hasSingleBean(LiveKitProperties.class);
            assertThat(context.getBean(LiveKitProperties.class).getApiKey()).isEqualTo("local-test-key");
        });
    }

    @Test
    void shouldNotLoadRtcConfigurationWithoutLocalProfile() {
        contextRunner.withPropertyValues("spring.profiles.active=default").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(LiveKitProperties.class);
        });
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "0.0.0.0", "192.168.1.10", "::"})
    void shouldRefuseNonLocalHttpBinding(String bindAddress) {
        contextRunner.withPropertyValues("server.address=" + bindAddress).run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasRootCauseMessage(
                    "rtc-local 模式要求 server.address=127.0.0.1，禁止开放匿名入房接口");
        });
    }

    @ParameterizedTest
    @ValueSource(strings = {"server-url=", "api-key=", "api-key=${MISSING_RTC_KEY}", "api-secret=", "api-secret=short"})
    void shouldRejectMissingOrWeakConnectionSettings(String invalidSetting) {
        contextRunner.withPropertyValues("lycansync.rtc." + invalidSetting).run(context ->
                assertThat(context).hasFailed());
    }
}
