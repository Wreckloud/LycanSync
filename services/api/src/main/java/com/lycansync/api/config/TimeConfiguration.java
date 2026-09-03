package com.lycansync.api.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Clock;

/**
 * 应用时间配置。
 *
 * @author Wreckloud
 * @since 2026-09-01
 */
@Configuration(proxyBeanMethods = false)
public class TimeConfiguration {

    @Bean
    public Clock systemClock() {
        // 统一提供时钟，测试时可替换为固定时间，避免依赖实际系统时间。
        return Clock.systemUTC();
    }
}
