package com.lycansync.api.auth.controller;

import com.lycansync.api.auth.config.AuthConfiguration;
import com.lycansync.api.auth.dto.LocalLoginRequest;
import com.lycansync.api.auth.dto.ProfileUpdateRequest;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.service.AuthService;
import com.lycansync.api.auth.service.LocalAuthService;
import com.lycansync.api.auth.service.ProfileService;
import com.lycansync.api.common.error.ApiErrorCode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;
import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 本地认证接口错误分层与登出边界测试。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
@WebMvcTest({AuthController.class, LocalAuthController.class})
@Import(AuthConfiguration.class)
class AuthControllerTests {

    private static final String SESSION_TOKEN = "a".repeat(43);
    private static final UUID USER_ID = UUID.fromString("2d983469-4442-44f5-b5a8-f3819f16a611");
    private static final AuthenticatedUser AUTHENTICATED_USER =
            new AuthenticatedUser(USER_ID, "小狼", false);

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
                HttpStatus.UNAUTHORIZED, ApiErrorCode.INVALID_CREDENTIALS, "用户名或密码错误"));
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
    void shouldReturnLightweightSessionWithoutLoadingProfile() throws Exception {
        when(authService.authenticate(SESSION_TOKEN)).thenReturn(AUTHENTICATED_USER);

        mvc.perform(get("/api/auth/session")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + SESSION_TOKEN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(USER_ID.toString()))
                .andExpect(jsonPath("$.nickname").value("小狼"))
                .andExpect(jsonPath("$.administrator").value(false))
                .andExpect(jsonPath("$.avatar").doesNotExist());

        verifyNoInteractions(profileService);
    }

    @Test
    void shouldLoadFullProfileOnlyForMeEndpoint() throws Exception {
        AuthUser profile = new AuthUser(USER_ID, "小狼", "stored-avatar", false, "一起开黑", Instant.parse("2026-09-06T08:00:00Z"));
        when(authService.authenticate(SESSION_TOKEN)).thenReturn(AUTHENTICATED_USER);
        when(profileService.findProfile(AUTHENTICATED_USER)).thenReturn(profile);

        mvc.perform(get("/api/auth/me")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + SESSION_TOKEN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.avatar").value("stored-avatar"))
                .andExpect(jsonPath("$.signature").value("一起开黑"))
                .andExpect(jsonPath("$.createdAt").value("2026-09-06T08:00:00Z"));

        verify(profileService).findProfile(AUTHENTICATED_USER);
    }

    @Test
    void shouldPassOptionalSignatureAndRejectOversizedSignature() throws Exception {
        when(authService.authenticate(SESSION_TOKEN)).thenReturn(AUTHENTICATED_USER);
        AuthUser profile = new AuthUser(USER_ID, "小狼", "", false, "签名", Instant.parse("2026-09-06T08:00:00Z"));
        when(profileService.update(any(), any())).thenReturn(profile);

        mvc.perform(put("/api/auth/me")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + SESSION_TOKEN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"nickname\":\"小狼\",\"avatar\":\"\",\"signature\":\"签名\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.signature").value("签名"));
        verify(profileService).update(AUTHENTICATED_USER, new ProfileUpdateRequest("小狼", "", "签名"));

        reset(profileService);
        mvc.perform(put("/api/auth/me")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer " + SESSION_TOKEN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"nickname\":\"小狼\",\"avatar\":\"\",\"signature\":\"" + "字".repeat(121) + "\"}"))
                .andExpect(status().isBadRequest());
        verifyNoInteractions(profileService);
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

    @Test
    void shouldIsolateSourcesAndIgnoreUntrustedProxyHeader() throws Exception {
        for (int attempt = 0; attempt < 60; attempt++) {
            mvc.perform(post("/api/auth/local/login").with(request -> {
                request.setRemoteAddr("192.0.2.41"); return request;
            }).contentType(MediaType.APPLICATION_JSON)
                    .content("{\"username\":\"tester\",\"password\":\"abc123\"}"))
                    .andExpect(status().isOk());
        }
        mvc.perform(post("/api/auth/local/login").with(request -> {
            request.setRemoteAddr("192.0.2.41"); return request;
        }).header("X-Lycan-Client-IP", "192.0.2.99")).andExpect(status().isTooManyRequests());
        mvc.perform(post("/api/auth/local/login").with(request -> {
            request.setRemoteAddr("192.0.2.42"); return request;
        }).contentType(MediaType.APPLICATION_JSON)
                .content("{\"username\":\"tester\",\"password\":\"abc123\"}"))
                .andExpect(status().isOk());
    }
}
