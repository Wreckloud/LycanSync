package com.lycansync.api.auth.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.service.AuthService;
import com.lycansync.api.common.error.ApiErrorCode;
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
import java.util.HashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;

/**
 * 无 Cookie 的 Bearer 会话边界与公开邀请入口；密码入口仅由测试控制器提供。
 *
 * @author Wreckloud
 * @since 2026-09-06
 */
@Configuration(proxyBeanMethods = false)
@EnableScheduling
public class AuthConfiguration {

    @Value("${lycansync.account.trust-proxy:false}")
    private boolean trustProxy;

    @Bean
    SecurityFilterChain authSecurity(HttpSecurity http, AuthService service, ObjectMapper json) throws Exception {
        // 不接受浏览器自动附带的身份，所有业务请求显式携带 Bearer，故不依赖 Cookie CSRF 防护。
        http.csrf(csrf -> csrf.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .requestCache(cache -> cache.disable())
                .formLogin(form -> form.disable()).httpBasic(basic -> basic.disable())
                .authorizeHttpRequests(requests -> requests
                        .requestMatchers("/api/auth/local/register", "/api/auth/local/login",
                                "/api/auth/options", "/api/auth/access/preview", "/api/auth/access/redeem",
                                "/join", "/join.js", "/api/system/initialization", "/actuator/health", "/actuator/info",
                                "/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html", "/error").permitAll()
                        .requestMatchers("/api/**").authenticated()
                        .anyRequest().denyAll())
                .exceptionHandling(errors -> errors
                        .authenticationEntryPoint((request, response, exception) -> writeProblem(
                                json, response, 401, ApiErrorCode.AUTHENTICATION_REQUIRED, "请先登录"))
                        .accessDeniedHandler((request, response, exception) -> writeProblem(
                                json, response, 403, ApiErrorCode.ACCESS_DENIED, "没有访问权限")))
                .addFilterBefore(new OncePerRequestFilter() {
                    private final Map<String, long[]> attempts = new HashMap<>();

                    @Override
                    protected boolean shouldNotFilterAsyncDispatch() {
                        return false;
                    }

                    private synchronized boolean allowAttempt(String source) {
                        long now = System.nanoTime();
                        attempts.entrySet().removeIf(entry -> now - entry.getValue()[0] > 60_000_000_000L);
                        long[] counter = attempts.get(source);
                        if (counter == null) {
                            if (attempts.size() >= 4096) return false;
                            counter = new long[] {now, 0};
                            attempts.put(source, counter);
                        }
                        return ++counter[1] <= 60;
                    }

                    @Override
                    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                                    FilterChain chain) throws ServletException, IOException {
                        String path = request.getRequestURI();
                        boolean loginAttempt = "/api/auth/local/register".equals(path)
                                || "/api/auth/local/login".equals(path)
                                || "/api/auth/access/preview".equals(path)
                                || "/api/auth/access/redeem".equals(path);
                        String source = trustProxy ? request.getHeader("X-Lycan-Client-IP") : null;
                        if (source == null || source.isBlank() || source.length() > 64) source = request.getRemoteAddr();
                        if (loginAttempt && !allowAttempt(source)) {
                            writeProblem(
                                    json, response, 429, ApiErrorCode.AUTH_RATE_LIMITED, "登录请求过于频繁，请一分钟后重试");
                            return;
                        }
                        String header = request.getHeader("Authorization");
                        if (header != null) {
                            try {
                                if (!header.startsWith("Bearer ")) throw new AuthException(
                                        HttpStatus.UNAUTHORIZED, ApiErrorCode.INVALID_AUTHORIZATION, "认证格式无效");
                                AuthenticatedUser user = service.authenticate(header.substring("Bearer ".length()));
                                SecurityContextHolder.getContext().setAuthentication(
                                        new PreAuthenticatedAuthenticationToken(user, null, List.of()));
                            } catch (AuthException exception) {
                                writeProblem(json, response, exception.getStatus().value(),
                                        exception.getCode(), exception.getMessage());
                                return;
                            } catch (DataAccessException exception) {
                                writeProblem(
                                        json, response, 503, ApiErrorCode.AUTH_SERVICE_UNAVAILABLE, "认证服务暂时不可用");
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
                                     int status, ApiErrorCode code, String message)
            throws IOException {
        response.setStatus(status);
        response.setContentType("application/problem+json");
        response.setCharacterEncoding("UTF-8");
        response.setHeader("Cache-Control", "no-store");
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatusCode.valueOf(status), message);
        problem.setProperty("code", code.name());
        json.writeValue(response.getOutputStream(), problem);
    }
}
