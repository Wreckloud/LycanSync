package com.lycansync.api.auth.service;

import com.lycansync.api.auth.dto.LocalLoginRequest;
import com.lycansync.api.auth.dto.LocalRegistrationRequest;
import com.lycansync.api.auth.dto.LoginResponse;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.model.LocalCredential;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * 本地用户名密码注册与登录业务。
 *
 * @author Wreckloud
 * @since 2026-09-09
 */
@Service
public class LocalAuthService {

    private static final Pattern USERNAME = Pattern.compile("[A-Za-z0-9_]{3,32}");
    private final AuthMapper mapper;
    private final AuthService authService;
    private final PasswordEncoder passwordEncoder;
    private final Clock systemClock;
    private final TransactionTemplate transactions;
    private final String dummyPasswordHash;

    public LocalAuthService(AuthMapper mapper, AuthService authService,
                            PasswordEncoder passwordEncoder, Clock systemClock, TransactionTemplate transactions) {
        this.mapper = mapper;
        this.authService = authService;
        this.passwordEncoder = passwordEncoder;
        this.systemClock = systemClock;
        this.transactions = transactions;
        this.dummyPasswordHash = passwordEncoder.encode(AuthSecrets.generate());
    }

    public LoginResponse register(LocalRegistrationRequest request) {
        String username = normalizeUsername(request.username());
        validatePassword(request.password());
        String passwordHash = passwordEncoder.encode(request.password());
        try {
            return transactions.execute(status -> registerInTransaction(request, username, passwordHash));
        } catch (DuplicateKeyException exception) {
            throw new AuthException(HttpStatus.CONFLICT, "用户名已被使用");
        }
    }

    private LoginResponse registerInTransaction(LocalRegistrationRequest request, String username, String passwordHash) {
        Instant now = Instant.now(systemClock);
        if (mapper.findLocalCredential(username) != null) {
            throw new AuthException(HttpStatus.CONFLICT, "用户名已被使用");
        }
        // 条件更新会原子选出首位管理员；事务失败时初始化状态和账号写入一起回滚。
        boolean administrator = mapper.markInitialized(now) == 1;
        AuthUser user = new AuthUser(UUID.randomUUID(), request.username(), "", administrator);
        mapper.insertUser(user, now);
        mapper.insertLocalCredential(user.id(), username, passwordHash, now);
        String sessionToken = authService.issueSession(user);
        return new LoginResponse(sessionToken, user);
    }

    public LoginResponse login(LocalLoginRequest request) {
        String username = normalizeUsername(request.username());
        validatePassword(request.password());
        LocalCredential credential = mapper.findLocalCredential(username);
        String passwordHash = credential == null ? dummyPasswordHash : credential.passwordHash();
        boolean matches = passwordEncoder.matches(request.password(), passwordHash);
        if (credential == null || !matches) {
            throw new AuthException(HttpStatus.UNAUTHORIZED, "用户名或密码错误");
        }
        AuthUser user = credential.user();
        return new LoginResponse(authService.issueSession(user), user);
    }

    private String normalizeUsername(String username) {
        if (username == null || !USERNAME.matcher(username).matches()) {
            throw new AuthException(HttpStatus.BAD_REQUEST, "用户名只能使用 3 至 32 位字母、数字或下划线");
        }
        return username.toLowerCase(Locale.ROOT);
    }

    private void validatePassword(String password) {
        if (password == null || password.isBlank() || password.length() < 6 || password.length() > 64
                || password.getBytes(StandardCharsets.UTF_8).length > 72) {
            throw new AuthException(HttpStatus.BAD_REQUEST, "密码需为 6 至 64 个字符，且编码后不能超过 72 字节");
        }
    }
}
