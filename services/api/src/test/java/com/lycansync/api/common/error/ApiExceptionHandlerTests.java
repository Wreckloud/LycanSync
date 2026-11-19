package com.lycansync.api.common.error;

import jakarta.servlet.ServletException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.transaction.CannotCreateTransactionException;
import org.springframework.transaction.TransactionSystemException;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.sql.SQLException;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 核对数据库不可用的 HTTP 错误契约，事务创建失败不能遗漏或泄露底层详情。
 *
 * @author Wreckloud
 * @since 2026-11-18
 */
class ApiExceptionHandlerTests {
    private static final String INTERNAL_DETAIL = "synthetic JDBC connection detail";

    static Stream<RuntimeException> unavailableDatabaseFailures() {
        return Stream.of(new DataAccessResourceFailureException(INTERNAL_DETAIL),
                new CannotCreateTransactionException("synthetic transaction creation", new SQLException(INTERNAL_DETAIL)));
    }

    @ParameterizedTest
    @MethodSource("unavailableDatabaseFailures")
    void shouldReportDatabaseUnavailabilityWithoutExposingConnectionDetails(RuntimeException failure) throws Exception {
        var result = endpoint(failure).perform(get("/failure"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.status").value(503))
                .andExpect(jsonPath("$.code").value("DATABASE_ACCESS_ERROR"))
                .andExpect(jsonPath("$.detail").value("服务器暂时无法读取或保存数据。"))
                .andExpect(jsonPath("$.trace").doesNotExist())
                .andReturn();
        assertThat(result.getResponse().getContentAsString()).doesNotContain(INTERNAL_DETAIL, "synthetic transaction creation");
    }

    @Test
    void shouldNotTreatAnUncertainTransactionOutcomeAsAnAcquisitionFailure() {
        var failure = new TransactionSystemException("synthetic commit failure", new SQLException(INTERNAL_DETAIL));
        assertThatThrownBy(() -> endpoint(failure).perform(get("/failure")))
                .isInstanceOf(ServletException.class)
                .hasCauseInstanceOf(TransactionSystemException.class);
    }

    private MockMvc endpoint(RuntimeException failure) {
        return MockMvcBuilders.standaloneSetup(new FailureController(failure))
                .setControllerAdvice(new ApiExceptionHandler()).build();
    }

    // 非静态夹具由单测显式构造，不参与应用组件扫描。
    @RestController
    private class FailureController {
        private final RuntimeException failure;

        private FailureController(RuntimeException failure) {
            this.failure = failure;
        }

        @GetMapping("/failure")
        public void fail() {
            throw failure;
        }
    }
}
