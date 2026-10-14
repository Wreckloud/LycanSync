package com.lycansync.api.auth.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

/**
 * 测试密码账号所需的加密器，仅在测试类路径中注册。
 *
 * @author Wreckloud
 * @since 2026-10-14
 */
@Configuration(proxyBeanMethods = false)
public class LocalAuthFixtureConfiguration {

    @Bean
    PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder(12);
    }
}
