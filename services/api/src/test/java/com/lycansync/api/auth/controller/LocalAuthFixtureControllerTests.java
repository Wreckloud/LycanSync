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
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 测试密码入口的独立鉴权配置不能放开正式业务接口。
 *
 * @author Wreckloud
 * @since 2026-10-15
 */
@WebMvcTest({AuthController.class, LocalAuthController.class})
@Import({AuthConfiguration.class, LocalAuthFixtureConfiguration.class})
class LocalAuthFixtureControllerTests {

    @Autowired
    private MockMvc mvc;

    @MockitoBean
    private AuthService authService;

    @MockitoBean
    private LocalAuthService localAuthService;

    @MockitoBean
    private ProfileService profileService;

    @Test
    void shouldAllowTestPasswordLoginWithoutOpeningProtectedEndpoints() throws Exception {
        mvc.perform(post("/api/auth/local/login").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"tester\",\"password\":\"abc123\"}"))
                .andExpect(status().isOk());
        mvc.perform(post("/api/auth/local/register").contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isBadRequest());
        mvc.perform(post("/api/auth/local/other")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/auth/session")).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/auth/logout")).andExpect(status().isUnauthorized());
    }
}
