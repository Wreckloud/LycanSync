package com.lycansync.api.auth.service;

import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AuthUser;
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

    public AuthUser authenticate(String token) {
        if (token == null || !token.matches("[A-Za-z0-9_-]{43}")) {
            throw new AuthException(HttpStatus.UNAUTHORIZED, "请先登录");
        }
        String hash = AuthSecrets.hash(token);
        Instant now = Instant.now(systemClock);
        AuthUser user = mapper.findSessionUser(hash, now);
        if (user == null) throw new AuthException(HttpStatus.UNAUTHORIZED, "登录已过期，请重新登录");
        mapper.extendSession(hash, now, now.plus(SESSION_TTL));
        return user;
    }

    public void logout(String token) {
        mapper.deleteSession(AuthSecrets.hash(token));
    }

    String issueSession(AuthUser user) {
        // 新会话原子替换该账号旧会话，旧设备下次请求会静默退出。
        String token = AuthSecrets.generate();
        mapper.replaceSession(AuthSecrets.hash(token), user.id(), Instant.now(systemClock).plus(SESSION_TTL));
        return token;
    }

    @Scheduled(fixedDelay = 3600000, initialDelay = 3600000)
    public void cleanExpiredCredentials() {
        Instant now = Instant.now(systemClock);
        mapper.deleteExpiredSessions(now);
    }
}
