package com.lycansync.api.auth.service;

import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.common.error.ApiErrorCode;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;

/**
 * 通用登录会话业务。
 *
 * @author Wreckloud
 * @since 2026-09-06
 */
@Service
@RequiredArgsConstructor
public class AuthService {

    private static final Duration SESSION_TTL = Duration.ofDays(30);
    private final AuthMapper mapper;
    private final Clock systemClock;

    public AuthenticatedUser authenticate(String token) {
        if (token == null || !token.matches("[A-Za-z0-9_-]{43}")) {
            throw new AuthException(HttpStatus.UNAUTHORIZED, ApiErrorCode.INVALID_SESSION, "请先登录");
        }
        String hash = AuthSecrets.hash(token);
        Instant now = Instant.now(systemClock);
        AuthenticatedUser user = mapper.findSessionUser(hash, now);
        if (user == null) {
            throw new AuthException(
                    HttpStatus.UNAUTHORIZED, ApiErrorCode.INVALID_SESSION, "登录已过期，请重新登录");
        }
        mapper.extendSession(hash, now, now.plus(SESSION_TTL));
        return new AuthenticatedUser(user.id(), user.nickname(), user.administrator(), hash);
    }

    public void logout(String token) {
        mapper.deleteSession(AuthSecrets.hash(token));
    }

    String issueSession(AuthUser user) {
        return issueSession(user, AuthSecrets.generate());
    }

    String issueSession(AuthUser user, String token) {
        // 重试兑换使用同一凭据，避免响应逆序到达后保存已经失效的会话。
        mapper.replaceSession(AuthSecrets.hash(token), user.id(), Instant.now(systemClock).plus(SESSION_TTL));
        return token;
    }

    @Scheduled(fixedDelay = 3600000, initialDelay = 3600000)
    public void cleanExpiredCredentials() {
        Instant now = Instant.now(systemClock);
        mapper.deleteExpiredSessions(now);
    }
}
