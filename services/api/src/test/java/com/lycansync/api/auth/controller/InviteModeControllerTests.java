package com.lycansync.api.auth.controller;

import com.lycansync.api.auth.config.AuthConfiguration;
import com.lycansync.api.auth.config.LocalAuthFixtureConfiguration;
import com.lycansync.api.auth.service.AuthService;
import com.lycansync.api.auth.service.LocalAuthService;
import com.lycansync.api.auth.service.ProfileService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.context.ApplicationContext;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 正式模式不挂载测试账号注册与密码登录。
 * @author Wreckloud
 * @since 2026-10-10
 */
@WebMvcTest(controllers = {AuthController.class, LocalAuthController.class}, properties = "lycansync.account.mode=invite")
@Import({AuthConfiguration.class, LocalAuthFixtureConfiguration.class})
class InviteModeControllerTests {
    @Autowired private MockMvc mvc;
    @Autowired private ApplicationContext context;
    @MockitoBean private AuthService auth;
    @MockitoBean private LocalAuthService local;
    @MockitoBean private ProfileService profiles;

    @Test
    void shouldNotExposeTestAuthenticationEndpoints() throws Exception {
        assertThat(context.getBeansOfType(LocalAuthController.class)).isEmpty();
        mvc.perform(post("/api/auth/local/register")).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/auth/local/login")).andExpect(status().isUnauthorized());
        verifyNoInteractions(local);
    }
}
