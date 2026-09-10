package com.lycansync.api.system.controller;

import com.lycansync.api.auth.config.AuthConfiguration;
import com.lycansync.api.auth.service.AuthService;
import com.lycansync.api.system.dto.SystemInitializationStatusResponse;
import com.lycansync.api.system.service.SystemInitializationService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;

import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.not;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 系统初始化接口测试。
 *
 * @author Wreckloud
 * @since 2026-09-02
 */
@WebMvcTest(
        controllers = SystemInitializationController.class,
        properties = "logging.level.com.lycansync.api.common.error=OFF"
)
@Import(AuthConfiguration.class)
class SystemInitializationControllerTests {

    private static final Instant SERVER_TIME = Instant.parse("2026-09-03T06:30:00Z");

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private SystemInitializationService systemInitializationService;

    @MockitoBean
    private AuthService authService;

    @Test
    void shouldReturnInitializationStateAndServerTimeWithoutCaching() throws Exception {
        when(systemInitializationService.getInitializationStatus())
                .thenReturn(new SystemInitializationStatusResponse(false, SERVER_TIME));

        mockMvc.perform(get("/api/system/initialization"))
                .andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(content().contentTypeCompatibleWith("application/json"))
                .andExpect(jsonPath("$.initialized").value(false))
                .andExpect(jsonPath("$.serverTime").value(SERVER_TIME.toString()))
                .andExpect(jsonPath("$.apiVersion").doesNotExist());
    }

    @Test
    void shouldReturnSafeErrorWhenDatabaseIsUnavailable() throws Exception {
        when(systemInitializationService.getInitializationStatus())
                .thenThrow(new DataAccessResourceFailureException("connection details must stay hidden"));

        mockMvc.perform(get("/api/system/initialization"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                .andExpect(jsonPath("$.code").value("DATABASE_ACCESS_ERROR"))
                .andExpect(jsonPath("$.detail").value("数据库暂时不可用"))
                .andExpect(content().string(not(containsString("connection details"))));
    }
}
