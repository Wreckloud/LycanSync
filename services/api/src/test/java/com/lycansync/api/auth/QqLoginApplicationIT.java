package com.lycansync.api.auth;

import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.QqIdentityMapper;
import com.lycansync.api.auth.service.AccessLinkService;
import com.lycansync.api.auth.service.AuthSecrets;
import com.lycansync.api.auth.service.AuthService;
import com.lycansync.api.auth.service.DefaultAvatar;
import com.lycansync.api.auth.service.QqIdentityClient;
import com.lycansync.api.auth.service.QqLoginService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.annotation.Transactional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.when;

/**
 * 独立 PostgreSQL 验证 QQ 账号创建、身份查询和原服主权限保留。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
@EnabledIfEnvironmentVariable(named = "QQ_TEST_DB_URL", matches = ".+/lycansync_qq_test")
@ActiveProfiles("test-fixtures")
@SpringBootTest(properties = {"lycansync.qq.enabled=true", "lycansync.qq.app-id=1234567",
        "lycansync.qq.app-key=test-only-key", "lycansync.qq.callback-url=https://example.com/api/auth/qq/callback",
        "lycansync.account.public-url=https://example.com"})
@Transactional
class QqLoginApplicationIT {
    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        properties.add("spring.datasource.url", () -> System.getenv("QQ_TEST_DB_URL"));
        properties.add("spring.datasource.username", () -> System.getenv("QQ_TEST_DB_USER"));
        properties.add("spring.datasource.password", () -> System.getenv("QQ_TEST_DB_PASSWORD"));
        properties.add("spring.flyway.user", () -> System.getenv("QQ_TEST_DB_USER"));
        properties.add("spring.flyway.password", () -> System.getenv("QQ_TEST_DB_PASSWORD"));
    }

    @Autowired private JdbcClient jdbc;
    @Autowired private AccessLinkService links;
    @Autowired private AuthService sessions;
    @Autowired private QqLoginService login;
    @Autowired private QqIdentityMapper identities;
    @MockitoBean private QqIdentityClient client;
    private String ownerToken;
    private static final String VERIFIER = "v".repeat(43);
    private static final String OPEN_ID = "A".repeat(32);

    @BeforeEach
    void setup() {
        assertThat(jdbc.sql("SELECT current_database()").query(String.class).single()).isEqualTo("lycansync_qq_test");
        var activation = links.activation();
        ownerToken = links.redeem(activation.url().substring(activation.url().indexOf("#token=") + 7), AuthSecrets.generate(), null, "owner-recovery-test-password").sessionToken();
        when(client.exchange("test-code")).thenReturn(new QqIdentityClient.Identity(OPEN_ID, "QQ 昵称", DefaultAvatar.value()));
    }

    private QqLoginService.Start ready(boolean binding) {
        var flow = login.start(AuthSecrets.hash(VERIFIER), false, binding, binding ? sessions.authenticate(ownerToken) : null);
        var browser = login.authorize(flow.request(), null);
        login.callback(flow.request(), browser.browserProof(), "test-code", null);
        return flow;
    }

    @Test
    void newQqUserIsOrdinaryAndHasNoGroupAndCanLoginAgain() {
        var first = login.exchange(ready(false).request(), VERIFIER);
        assertThat(first.user().administrator()).isFalse();
        assertThat(first.newAccount()).isTrue();
        assertThat(jdbc.sql("SELECT count(*) FROM group_member WHERE user_id = :id").param("id", first.user().id()).query(Long.class).single()).isZero();
        assertThat(identities.findUserId("1234567", OPEN_ID)).isEqualTo(first.user().id().toString());
        var second = login.exchange(ready(false).request(), VERIFIER);
        assertThat(second.user().id()).isEqualTo(first.user().id());
        assertThat(second.newAccount()).isFalse();
    }

    @Test
    void bindingKeepsOwnerAndRejectsUsingBindingAsLogin() {
        var owner = sessions.authenticate(ownerToken);
        var flow = ready(true);
        assertThatThrownBy(() -> login.exchange(flow.request(), VERIFIER)).isInstanceOf(AuthException.class);
        assertThat(login.confirmBinding(flow.request(), VERIFIER, owner).bound()).isTrue();
        var result = login.exchange(ready(false).request(), VERIFIER);
        assertThat(result.user().id()).isEqualTo(owner.id());
        assertThat(result.user().administrator()).isTrue();
    }
}
