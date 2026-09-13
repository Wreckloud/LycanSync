package com.lycansync.api.common.error;

import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.group.exception.GroupException;
import com.lycansync.api.rtc.exception.RtcServiceUnavailableException;
import com.lycansync.api.system.exception.SystemStateNotFoundException;
import jakarta.validation.ConstraintViolationException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * API 异常处理。
 *
 * @author Wreckloud
 * @since 2026-09-02
 */
@RestControllerAdvice
@Slf4j
public class ApiExceptionHandler {

    @ExceptionHandler(AuthException.class)
    public ProblemDetail handleAuth(AuthException exception) {
        return createProblemDetail(
                exception.getStatus(), exception.getCode(), "认证请求失败", exception.getMessage());
    }

    @ExceptionHandler(GroupException.class)
    public ProblemDetail handleGroup(GroupException exception) {
        return createProblemDetail(
                exception.getStatus(), exception.getCode(), "群组请求失败", exception.getMessage());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ProblemDetail handleInvalidRequest(MethodArgumentNotValidException exception) {
        return createProblemDetail(
                HttpStatus.BAD_REQUEST,
                ApiErrorCode.INVALID_REQUEST,
                "请求参数无效",
                "请求参数不符合接口要求，请检查必填项和长度限制"
        );
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ProblemDetail handleUnreadableRequest(HttpMessageNotReadableException exception) {
        return createProblemDetail(
                HttpStatus.BAD_REQUEST,
                ApiErrorCode.INVALID_REQUEST,
                "请求参数无效",
                "请求体缺失或 JSON 格式不正确"
        );
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ProblemDetail handleTypeMismatch(MethodArgumentTypeMismatchException exception) {
        return createProblemDetail(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST,
                "请求参数无效", "路径或查询参数格式不正确");
    }

    @ExceptionHandler(SystemStateNotFoundException.class)
    public ProblemDetail handleSystemStateNotFound(SystemStateNotFoundException exception) {
        log.error("系统初始化状态记录不存在", exception);
        return createProblemDetail(
                HttpStatus.INTERNAL_SERVER_ERROR,
                ApiErrorCode.SYSTEM_STATE_NOT_FOUND,
                "系统状态异常",
                "系统初始化状态记录不存在"
        );
    }

    @ExceptionHandler(DataAccessException.class)
    public ProblemDetail handleDataAccess(DataAccessException exception) {
        log.error("数据库访问失败", exception);
        return createProblemDetail(
                HttpStatus.SERVICE_UNAVAILABLE,
                ApiErrorCode.DATABASE_ACCESS_ERROR,
                "数据库访问失败",
                "数据库暂时不可用"
        );
    }

    @ExceptionHandler(ConstraintViolationException.class)
    public ProblemDetail handleConstraintViolation(ConstraintViolationException exception) {
        return createProblemDetail(
                HttpStatus.BAD_REQUEST,
                ApiErrorCode.INVALID_REQUEST,
                "请求参数无效",
                "请求参数不符合接口要求，请检查必填项和格式"
        );
    }

    @ExceptionHandler(RtcServiceUnavailableException.class)
    public ProblemDetail handleRtcServiceUnavailable(RtcServiceUnavailableException exception) {
        log.error("RTC 服务端接口不可用", exception);
        return createProblemDetail(
                HttpStatus.SERVICE_UNAVAILABLE,
                ApiErrorCode.RTC_SERVICE_UNAVAILABLE,
                "语音状态暂时不可用",
                "暂时无法获取语音房间状态"
        );
    }

    private ProblemDetail createProblemDetail(
            HttpStatus status,
            ApiErrorCode code,
            String title,
            String detail
    ) {
        // 响应只包含预定义说明，底层异常详情留在服务端日志中。
        ProblemDetail problemDetail = ProblemDetail.forStatusAndDetail(status, detail);
        problemDetail.setTitle(title);
        problemDetail.setProperty("code", code.name());
        return problemDetail;
    }
}
