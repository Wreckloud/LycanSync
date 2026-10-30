package com.lycansync.api.audio.exception;

import com.lycansync.api.common.error.ApiErrorCode;
import lombok.Getter;
import org.springframework.http.HttpStatus;

/**
 * 可公开的音效处理失败，不包含上传内容或工具输出。
 *
 * @author Wreckloud
 * @since 2026-10-30
 */
@Getter
public class AudioProcessingException extends RuntimeException {

    private final HttpStatus status;
    private final ApiErrorCode code;

    public AudioProcessingException(HttpStatus status, ApiErrorCode code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
