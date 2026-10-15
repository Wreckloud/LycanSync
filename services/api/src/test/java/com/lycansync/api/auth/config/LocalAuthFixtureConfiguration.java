package com.lycansync.api.auth.config;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;

/**
 * 测试密码账号所需的加密器与公开入口，仅在测试类路径中注册。
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

    @Bean
    @Order(0)
    @ConditionalOnProperty(name = "lycansync.account.mode", havingValue = "test")
    SecurityFilterChain localAuthFixtureSecurity(HttpSecurity http) throws Exception {
        // 密码入口仅供旧数据库回归造数，不能要求正式鉴权配置为它保留匿名白名单。
        http.securityMatcher("/api/auth/local/register", "/api/auth/local/login")
                .csrf(csrf -> csrf.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .requestCache(cache -> cache.disable())
                .formLogin(form -> form.disable()).httpBasic(basic -> basic.disable())
                .authorizeHttpRequests(requests -> requests.anyRequest().permitAll());
        return http.build();
    }
}
