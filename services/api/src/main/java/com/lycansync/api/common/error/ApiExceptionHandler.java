package com.lycansync.api.common.error;

import com.lycansync.api.system.exception.SystemStateNotFoundException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
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

    @ExceptionHandler(SystemStateNotFoundException.class)
    public ProblemDetail handleSystemStateNotFound(SystemStateNotFoundException exception) {
        log.error("系统初始化状态记录不存在", exception);
        return createProblemDetail(
                HttpStatus.INTERNAL_SERVER_ERROR,
                "SYSTEM_STATE_NOT_FOUND",
                "系统状态异常",
                "系统初始化状态记录不存在"
        );
    }

    @ExceptionHandler(DataAccessException.class)
    public ProblemDetail handleDataAccess(DataAccessException exception) {
        log.error("数据库访问失败", exception);
        return createProblemDetail(
                HttpStatus.SERVICE_UNAVAILABLE,
                "DATABASE_ACCESS_ERROR",
                "数据库访问失败",
                "数据库暂时不可用"
        );
    }

    private ProblemDetail createProblemDetail(
            HttpStatus status,
            String code,
            String title,
            String detail
    ) {
        // 响应只包含预定义说明，底层异常详情留在服务端日志中。
        ProblemDetail problemDetail = ProblemDetail.forStatusAndDetail(status, detail);
        problemDetail.setTitle(title);
        problemDetail.setProperty("code", code);
        return problemDetail;
    }
}
