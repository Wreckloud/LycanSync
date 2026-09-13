package com.lycansync.api.group.exception;

import com.lycansync.api.common.error.ApiErrorCode;
import lombok.Getter;
import org.springframework.http.HttpStatus;

/**
 * 可向客户端公开的群组业务失败原因。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
@Getter
public class GroupException extends RuntimeException {

    private final HttpStatus status;
    private final ApiErrorCode code;

    public GroupException(HttpStatus status, ApiErrorCode code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
