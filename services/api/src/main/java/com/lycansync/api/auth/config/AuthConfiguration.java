package com.lycansync.api.auth.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.service.AuthService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.ProblemDetail;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.dao.DataAccessException;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.AnonymousAuthenticationFilter;
import org.springframework.security.web.authentication.preauth.PreAuthenticatedAuthenticationToken;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * 无 Cookie 的 Bearer 会话边界与公开本地登录入口。
 *
 * @author Wreckloud
 * @since 2026-09-06
 */
@Configuration(proxyBeanMethods = false)
@EnableScheduling
public class AuthConfiguration {

    @Bean
    SecurityFilterChain authSecurity(HttpSecurity http, AuthService service, ObjectMapper json) throws Exception {
        // 不接受浏览器自动附带的身份，所有业务请求显式携带 Bearer，故不依赖 Cookie CSRF 防护。
        http.csrf(csrf -> csrf.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .requestCache(cache -> cache.disable())
                .formLogin(form -> form.disable()).httpBasic(basic -> basic.disable())
                .authorizeHttpRequests(requests -> requests
                        .requestMatchers("/api/auth/local/register", "/api/auth/local/login",
                                "/api/system/initialization", "/actuator/health", "/actuator/info",
                                "/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html", "/error").permitAll()
                        .requestMatchers("/api/**").authenticated()
                        .anyRequest().denyAll())
                .exceptionHandling(errors -> errors
                        .authenticationEntryPoint((request, response, exception) -> writeProblem(
                                json, response, 401, "AUTHENTICATION_REQUIRED", "请先登录"))
                        .accessDeniedHandler((request, response, exception) -> writeProblem(
                                json, response, 403, "ACCESS_DENIED", "没有访问权限")))
                .addFilterBefore(new OncePerRequestFilter() {
                    private long window = System.nanoTime();
                    private int attempts;

                    private synchronized boolean allowAttempt() {
                        long now = System.nanoTime();
                        if (now - window > 60_000_000_000L) { window = now; attempts = 0; }
                        return ++attempts <= 60;
                    }

                    @Override
                    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                                    FilterChain chain) throws ServletException, IOException {
                        String path = request.getRequestURI();
                        boolean loginAttempt = "/api/auth/local/register".equals(path)
                                || "/api/auth/local/login".equals(path);
                        if (loginAttempt && !allowAttempt()) {
                            writeProblem(
                                    json, response, 429, "AUTH_RATE_LIMITED", "登录请求过于频繁，请一分钟后重试");
                            return;
                        }
                        String header = request.getHeader("Authorization");
                        if (header != null) {
                            try {
                                if (!header.startsWith("Bearer ")) throw new AuthException(
                                        HttpStatus.UNAUTHORIZED, "INVALID_AUTHORIZATION", "认证格式无效");
                                AuthUser user = service.authenticate(header.substring("Bearer ".length()));
                                SecurityContextHolder.getContext().setAuthentication(
                                        new PreAuthenticatedAuthenticationToken(user, null, List.of()));
                            } catch (AuthException exception) {
                                writeProblem(json, response, exception.getStatus().value(),
                                        exception.getCode(), exception.getMessage());
                                return;
                            } catch (DataAccessException exception) {
                                writeProblem(
                                        json, response, 503, "AUTH_SERVICE_UNAVAILABLE", "认证服务暂时不可用");
                                return;
                            }
                        }
                        chain.doFilter(request, response);
                    }
                }, AnonymousAuthenticationFilter.class);
        return http.build();
    }

    @Bean
    PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder(12);
    }

    private static void writeProblem(ObjectMapper json, HttpServletResponse response,
                                     int status, String code, String message)
            throws IOException {
        response.setStatus(status);
        response.setContentType("application/problem+json");
        response.setCharacterEncoding("UTF-8");
        response.setHeader("Cache-Control", "no-store");
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatusCode.valueOf(status), message);
        problem.setProperty("code", code);
        json.writeValue(response.getOutputStream(), problem);
    }
}
