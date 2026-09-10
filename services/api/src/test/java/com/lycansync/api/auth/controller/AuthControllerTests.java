package com.lycansync.api.auth.controller;

import com.lycansync.api.auth.config.AuthConfiguration;
import com.lycansync.api.auth.dto.LocalLoginRequest;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.service.AuthService;
import com.lycansync.api.auth.service.LocalAuthService;
import com.lycansync.api.auth.service.ProfileService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 本地认证接口错误分层与登出边界测试。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
@WebMvcTest(AuthController.class)
@Import(AuthConfiguration.class)
class AuthControllerTests {

    private static final String SESSION_TOKEN = "a".repeat(43);
    private static final AuthUser AUTHENTICATED_USER =
            new AuthUser(UUID.fromString("2d983469-4442-44f5-b5a8-f3819f16a611"), "小狼", "", false);

    @Autowired
    private MockMvc mvc;

    @MockitoBean
    private AuthService authService;

    @MockitoBean
    private LocalAuthService localAuthService;

    @MockitoBean
    private ProfileService profileService;

    @Test
    void shouldDistinguishInvalidCredentialsFromRateLimit() throws Exception {
        when(localAuthService.login(any(LocalLoginRequest.class))).thenThrow(new AuthException(
                HttpStatus.UNAUTHORIZED, "INVALID_CREDENTIALS", "用户名或密码错误"));
        performLogin().andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("INVALID_CREDENTIALS"));

        reset(localAuthService);
        for (int attempt = 1; attempt < 60; attempt++) {
            performLogin().andExpect(status().isOk());
        }
        performLogin().andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.code").value("AUTH_RATE_LIMITED"));
    }

    @Test
    void shouldLogoutOnlyAfterBearerAuthentication() throws Exception {
        when(authService.authenticate(SESSION_TOKEN)).thenReturn(AUTHENTICATED_USER);
        mvc.perform(post("/api/auth/logout")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + SESSION_TOKEN))
                .andExpect(status().isNoContent());
        verify(authService).logout(SESSION_TOKEN);

        mvc.perform(post("/api/auth/logout"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("AUTHENTICATION_REQUIRED"));
        mvc.perform(post("/api/auth/logout").header(HttpHeaders.AUTHORIZATION, "Basic credentials"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("INVALID_AUTHORIZATION"));
    }

    private org.springframework.test.web.servlet.ResultActions performLogin() throws Exception {
        return mvc.perform(post("/api/auth/local/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"username\":\"tester\",\"password\":\"abc123\"}"));
    }
}
