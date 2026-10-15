package com.lycansync.api.auth.controller;

import com.lycansync.api.auth.config.AccountAccessProperties;
import com.lycansync.api.auth.config.AuthConfiguration;
import com.lycansync.api.auth.dto.ProfileUpdateRequest;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.service.AccessLinkService;
import com.lycansync.api.auth.service.AuthService;
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
 * 邀请入口限流、会话资料与登出边界测试。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
@WebMvcTest({AuthController.class, AccessLinkController.class})
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
    private AccessLinkService accessLinkService;

    @MockitoBean
    private AccountAccessProperties accountAccessProperties;

    @MockitoBean
    private ProfileService profileService;

    @Test
    void shouldDistinguishInvalidLinkFromRateLimit() throws Exception {
        when(accessLinkService.preview(SESSION_TOKEN)).thenThrow(new AuthException(
                HttpStatus.CONFLICT, ApiErrorCode.INVALID_REQUEST, "链接无效"));
        performPreview().andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));

        reset(accessLinkService);
        for (int attempt = 1; attempt < 60; attempt++) {
            performPreview().andExpect(status().isOk());
        }
        performPreview().andExpect(status().isTooManyRequests())
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

    private org.springframework.test.web.servlet.ResultActions performPreview() throws Exception {
        return mvc.perform(post("/api/auth/access/preview")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"token\":\"" + SESSION_TOKEN + "\"}"));
    }

    @Test
    void shouldIsolateSourcesAndIgnoreUntrustedProxyHeader() throws Exception {
        for (int attempt = 0; attempt < 60; attempt++) {
            mvc.perform(post("/api/auth/access/preview").with(request -> {
                request.setRemoteAddr("192.0.2.41"); return request;
            }).contentType(MediaType.APPLICATION_JSON)
                    .content("{\"token\":\"" + SESSION_TOKEN + "\"}"))
                    .andExpect(status().isOk());
        }
        mvc.perform(post("/api/auth/access/redeem").with(request -> {
            request.setRemoteAddr("192.0.2.41"); return request;
        }).header("X-Lycan-Client-IP", "192.0.2.99")).andExpect(status().isTooManyRequests());
        mvc.perform(post("/api/auth/access/preview").with(request -> {
            request.setRemoteAddr("192.0.2.42"); return request;
        }).contentType(MediaType.APPLICATION_JSON)
                .content("{\"token\":\"" + SESSION_TOKEN + "\"}"))
                .andExpect(status().isOk());
    }
}
