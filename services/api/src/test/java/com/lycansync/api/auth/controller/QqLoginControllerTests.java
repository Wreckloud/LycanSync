package com.lycansync.api.auth.controller;

import com.lycansync.api.auth.config.AuthConfiguration;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.service.AuthService;
import com.lycansync.api.auth.service.QqLoginService;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;
import static org.hamcrest.Matchers.containsString;

/**
 * QQ 公开入口、原账号绑定权限及浏览器回调隔离。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
@WebMvcTest({QqLoginController.class, QqSiteController.class})
@Import(AuthConfiguration.class)
class QqLoginControllerTests {
    @Autowired private MockMvc mvc;
    @MockitoBean private QqLoginService login;
    @MockitoBean private AuthService sessions;
    private static final String REQUEST = "r".repeat(43);
    private static final String PROOF = "p".repeat(43);

    @Test
    void homepageHasOfficialLoginAndPrivacyWithoutLoadingDesktop() throws Exception {
        mvc.perform(get("/")).andExpect(status().isOk())
                .andExpect(content().string(containsString("/qq-login.png")))
                .andExpect(content().string(containsString("/privacy")))
                .andExpect(header().string("Content-Security-Policy", containsString("frame-ancestors 'none'")));
        mvc.perform(get("/qq-login.png")).andExpect(status().isOk()).andExpect(content().contentType(MediaType.IMAGE_PNG));
        verifyNoInteractions(login, sessions);
    }

    @Test
    void bindingRequiresAuthenticatedOriginalAccount() throws Exception {
        mvc.perform(post("/api/auth/qq/binding/confirm").contentType(MediaType.APPLICATION_JSON)
                .content("{\"request\":\"" + REQUEST + "\",\"verifier\":\"" + PROOF + "\"}"))
                .andExpect(status().isUnauthorized());
        verifyNoInteractions(login);
        var user = new AuthenticatedUser(UUID.randomUUID(), "原账号", true);
        when(sessions.authenticate(PROOF)).thenReturn(user);
        when(login.binding(user)).thenReturn(new QqLoginService.Binding(false, ""));
        mvc.perform(get("/api/auth/qq/binding").header("Authorization", "Bearer " + PROOF))
                .andExpect(status().isOk()).andExpect(jsonPath("$.bound").value(false));
        verify(login).binding(user);
    }

    @Test
    void authorizationUsesSecureCookieAndCallbackPassesOnlyItsProof() throws Exception {
        when(login.cookieName(REQUEST)).thenReturn("__Host-lycan-qq-test");
        when(login.authorize(REQUEST, null)).thenReturn(new QqLoginService.Authorization("https://graph.qq.com/oauth2.0/authorize", PROOF));
        mvc.perform(get("/api/auth/qq/authorize").param("request", REQUEST))
                .andExpect(status().isFound()).andExpect(header().string("Set-Cookie", containsString("Secure; HttpOnly; SameSite=Lax")))
                .andExpect(header().string("Cache-Control", containsString("no-store")));
        mvc.perform(get("/api/auth/qq/callback").param("state", REQUEST).param("code", "test-code")
                .cookie(new Cookie("__Host-lycan-qq-test", PROOF), new Cookie("other", "ignored")))
                .andExpect(status().isFound()).andExpect(header().string("Location", "/qq/result#request=" + REQUEST));
        verify(login).callback(REQUEST, PROOF, "test-code", null);
    }

    @Test
    void malformedChallengeDoesNotReachService() throws Exception {
        mvc.perform(post("/api/auth/qq/start").contentType(MediaType.APPLICATION_JSON)
                .content("{\"challenge\":\"invalid\",\"desktop\":false}"))
                .andExpect(status().isBadRequest());
        verifyNoInteractions(login);
    }
}
