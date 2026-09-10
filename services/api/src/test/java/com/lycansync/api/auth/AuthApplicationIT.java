package com.lycansync.api.auth;

import com.lycansync.api.auth.dto.LocalLoginRequest;
import com.lycansync.api.auth.dto.LocalRegistrationRequest;
import com.lycansync.api.auth.dto.ProfileUpdateRequest;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.service.AuthService;
import com.lycansync.api.auth.service.LocalAuthService;
import com.lycansync.api.auth.service.ProfileService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.concurrent.Executors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 使用隔离 PostgreSQL 验证本地账号、首位管理员和会话边界。
 *
 * @author Wreckloud
 * @since 2026-09-09
 */
@Testcontainers
@SpringBootTest
@AutoConfigureMockMvc
class AuthApplicationIT {

    private static final String ADMIN_PASSWORD = "administrator-password";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:18.6-bookworm");

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
    }

    @Autowired
    private AuthService service;

    @Autowired
    private LocalAuthService localAuth;

    @Autowired
    private ProfileService profiles;

    @Autowired
    private JdbcClient jdbc;

    @Autowired
    private MockMvc mvc;

    @BeforeEach
    void resetDatabase() {
        jdbc.sql("TRUNCATE auth_session, auth_local_credential, app_user").update();
        jdbc.sql("UPDATE system_state SET initialized_at = NULL WHERE id = 1").update();
    }

    private String registerAdmin() {
        return localAuth.register(new LocalRegistrationRequest("Admin", ADMIN_PASSWORD)).sessionToken();
    }

    @Test
    void shouldMakeFirstRegisteredUserAdministrator() throws Exception {
        mvc.perform(get("/api/system/initialization")).andExpect(status().isOk())
                .andExpect(jsonPath("$.initialized").value(false));
        assertThat(service.authenticate(registerAdmin()).administrator()).isTrue();
        mvc.perform(get("/api/system/initialization")).andExpect(status().isOk())
                .andExpect(jsonPath("$.initialized").value(true));
    }

    @Test
    void shouldDescribePublicLocalEndpointsWithoutBearerRequirement() throws Exception {
        mvc.perform(get("/v3/api-docs"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.security[0].bearerAuth").isArray())
                .andExpect(jsonPath("$['paths']['/api/auth/local/register']['post']['security']").isEmpty())
                .andExpect(jsonPath("$['paths']['/api/auth/local/login']['post']['security']").isEmpty())
                .andExpect(jsonPath("$['paths']['/api/system/initialization']['get']['security']").isEmpty());
    }

    @Test
    void shouldHidePasswordAndRevokeSessionOnLogout() throws Exception {
        String token = registerAdmin();
        mvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk()).andExpect(jsonPath("$.passwordHash").doesNotExist());
        service.logout(token);
        assertThatThrownBy(() -> service.authenticate(token)).isInstanceOf(AuthException.class);
    }

    @Test
    void shouldReplacePreviousSessionAndMatchUsernameIgnoringCase() {
        String firstToken = registerAdmin();
        String secondToken = localAuth.login(new LocalLoginRequest("ADMIN", ADMIN_PASSWORD)).sessionToken();

        assertThatThrownBy(() -> service.authenticate(firstToken)).isInstanceOf(AuthException.class);
        assertThat(service.authenticate(secondToken).administrator()).isTrue();
        assertThat(jdbc.sql("SELECT count(*) FROM auth_session").query(Long.class).single()).isOne();
    }

    @Test
    void shouldRejectAnonymousBusinessRequests() throws Exception {
        mvc.perform(get("/api/auth/me")).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/rtc/token").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"groupId\":\"pack\"}"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void shouldAllowLaterUsersToRegisterAsRegularMembers() {
        registerAdmin();
        AuthUser friend = localAuth.register(new LocalRegistrationRequest("Friend", "friend-password")).user();
        assertThat(friend.administrator()).isFalse();
        assertThat(jdbc.sql("SELECT count(*) FROM app_user").query(Long.class).single()).isEqualTo(2);
    }

    @Test
    void shouldKeepCustomProfileOnLaterLogin() {
        AuthUser admin = service.authenticate(registerAdmin());
        profiles.update(admin, new ProfileUpdateRequest("自定义昵称", ""));
        assertThat(localAuth.login(new LocalLoginRequest("admin", ADMIN_PASSWORD)).user().nickname())
                .isEqualTo("自定义昵称");
    }

    @Test
    void shouldUseSameErrorForUnknownUserAndWrongPassword() {
        registerAdmin();
        assertThatThrownBy(() -> localAuth.login(new LocalLoginRequest("unknown", ADMIN_PASSWORD)))
                .isInstanceOf(AuthException.class).hasMessage("用户名或密码错误");
        assertThatThrownBy(() -> localAuth.login(new LocalLoginRequest("admin", "incorrect-password")))
                .isInstanceOf(AuthException.class).hasMessage("用户名或密码错误");
    }

    @Test
    void shouldAcceptSixCharacterPasswordAndRejectShorterPassword() throws Exception {
        AuthUser user = localAuth.register(new LocalRegistrationRequest("SixPassword", "abc123")).user();
        assertThat(localAuth.login(new LocalLoginRequest("sixpassword", "abc123")).user().id()).isEqualTo(user.id());
        assertThatThrownBy(() -> localAuth.register(new LocalRegistrationRequest("TooShort", "abc12")))
                .isInstanceOf(AuthException.class)
                .hasMessage("密码需为 6 至 64 个字符，且编码后不能超过 72 字节");
        mvc.perform(post("/api/auth/local/register").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"TooShort\",\"password\":\"abc12\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void shouldExpireSession() {
        String token = registerAdmin();
        jdbc.sql("UPDATE auth_session SET expires_at = now() - interval '1 minute'").update();
        assertThatThrownBy(() -> service.authenticate(token)).isInstanceOf(AuthException.class);
    }

    @Test
    void shouldChooseOnlyOneAdministratorDuringConcurrentRegistration() throws Exception {
        var pool = Executors.newFixedThreadPool(2);
        try {
            var first = pool.submit(() -> localAuth.register(
                    new LocalRegistrationRequest("AdminOne", ADMIN_PASSWORD)).user());
            var second = pool.submit(() -> localAuth.register(
                    new LocalRegistrationRequest("AdminTwo", ADMIN_PASSWORD)).user());
            assertThat(first.get().administrator() ^ second.get().administrator()).isTrue();
            assertThat(jdbc.sql("SELECT count(*) FROM app_user").query(Long.class).single()).isEqualTo(2);
            assertThat(jdbc.sql("SELECT count(*) FROM app_user WHERE administrator").query(Long.class).single())
                    .isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void shouldRejectInvalidCredentialAndProfileValues() {
        assertThatThrownBy(() -> localAuth.register(new LocalRegistrationRequest(
                "bad name", ADMIN_PASSWORD))).isInstanceOf(AuthException.class);
        assertThatThrownBy(() -> localAuth.register(new LocalRegistrationRequest(
                "Admin", "密密密密密密密密密密密密密密密密密密密密密密密密密密密密密密")))
                .isInstanceOf(AuthException.class);

        AuthUser admin = service.authenticate(registerAdmin());
        assertThatThrownBy(() -> profiles.update(admin, new ProfileUpdateRequest(" ", "")))
                .isInstanceOf(AuthException.class);
        assertThatThrownBy(() -> profiles.update(admin, new ProfileUpdateRequest("昵称", "https://localhost/private")))
                .isInstanceOf(AuthException.class);
        assertThatThrownBy(() -> profiles.update(admin,
                new ProfileUpdateRequest("昵称", "data:image/png;base64,YWJj"))).isInstanceOf(AuthException.class);
    }

}
