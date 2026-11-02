package com.lycansync.api.rtc.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

/**
 * 隔离语音统计的外部查询，避免占用在线状态过期任务的调度线程。
 *
 * @author Wreckloud
 * @since 2026-11-02
 */
@Configuration(proxyBeanMethods = false)
@Profile({"rtc-local", "rtc-server"})
public class SharedVoiceTimeConfiguration {
    @Bean
    public ThreadPoolTaskScheduler taskScheduler() {
        // 保留其他定时任务的默认线程，避免唯一的自定义调度器被当作全局默认值。
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(1);
        scheduler.setThreadNamePrefix("scheduling-");
        return scheduler;
    }

    @Bean
    public ThreadPoolTaskScheduler sharedVoiceScheduler() {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(1);
        scheduler.setThreadNamePrefix("shared-voice-");
        return scheduler;
    }
}
