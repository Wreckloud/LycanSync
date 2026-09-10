package com.lycansync.api.auth.exception;

import lombok.Getter;
import org.springframework.http.HttpStatus;

/**
 * 可向客户端公开的认证失败原因，不携带登录凭据。
 *
 * @author Wreckloud
 * @since 2026-09-06
 */
@Getter
public class AuthException extends RuntimeException {

    private final HttpStatus status;
    private final String code;

    public AuthException(HttpStatus status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
