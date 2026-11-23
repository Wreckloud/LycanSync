package com.lycansync.api.auth;

import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.dto.QqConfigurationRequest;
import com.lycansync.api.auth.config.QqLoginProperties;
import com.lycansync.api.auth.mapper.QqConfigurationMapper;
import com.lycansync.api.auth.service.OwnerSettingsService;
import com.lycansync.api.auth.service.QqConfigurationService;
import com.lycansync.api.auth.mapper.QqIdentityMapper;
import com.lycansync.api.auth.service.AccessLinkService;
import com.lycansync.api.auth.service.AccountLifecycleService;
import com.lycansync.api.auth.service.AuthSecrets;
import com.lycansync.api.auth.service.AuthService;
import com.lycansync.api.auth.service.DefaultAvatar;
import com.lycansync.api.auth.service.QqIdentityClient;
import com.lycansync.api.auth.service.QqLoginService;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.when;

/**
 * 独立 PostgreSQL 验证 QQ 账号创建、身份查询和原服主权限保留。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
@Testcontainers
@ActiveProfiles("test-fixtures")
@SpringBootTest(properties = {"lycansync.qq.enabled=true", "lycansync.qq.app-id=1234567",
        "lycansync.qq.app-key=test-only-key", "lycansync.qq.callback-url=https://example.com/api/auth/qq/callback",
        "lycansync.account.public-url=https://example.com"})
@Transactional
// 数据库容器按测试类关闭，避免缓存上下文的定时任务继续访问已销毁的数据库。
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class QqLoginApplicationIT {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:18.6-bookworm")
            .withDatabaseName("lycansync_qq_test");
    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        properties.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        properties.add("spring.datasource.username", POSTGRES::getUsername);
        properties.add("spring.datasource.password", POSTGRES::getPassword);
        properties.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        properties.add("spring.flyway.user", POSTGRES::getUsername);
        properties.add("spring.flyway.password", POSTGRES::getPassword);
    }

    @Autowired private JdbcClient jdbc;
    @Autowired private AccessLinkService links;
    @Autowired private AccountLifecycleService accounts;
    @Autowired private AuthService sessions;
    @Autowired private QqLoginService login;
    @Autowired private QqIdentityMapper identities;
    @Autowired private OwnerSettingsService settings;
    @Autowired private QqConfigurationMapper configurations;
    @Autowired private PlatformTransactionManager transactionManager;
    @MockitoBean private QqIdentityClient client;
    private String ownerToken;
    private static final String VERIFIER = "v".repeat(43);
    private static final String OPEN_ID = "A".repeat(32);

    @BeforeEach
    void setup() {
        assertThat(jdbc.sql("SELECT current_database()").query(String.class).single()).isEqualTo("lycansync_qq_test");
        var activation = links.activation();
        ownerToken = links.redeem(activation.url().substring(activation.url().indexOf("#token=") + 7), AuthSecrets.generate(), null, "owner-recovery-test-password").sessionToken();
        when(client.exchange(org.mockito.ArgumentMatchers.eq("test-code"), org.mockito.ArgumentMatchers.any())).thenReturn(new QqIdentityClient.Identity(OPEN_ID, "QQ 昵称", DefaultAvatar.value()));
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
    void closingAccountReleasesQqOnlyOnCommitAndAllowsRegistrationAgain() {
        var flow = ready(false);
        var first = login.exchange(flow.request(), VERIFIER);
        var member = sessions.authenticate(first.sessionToken());

        var rollback = new TransactionTemplate(transactionManager);
        rollback.setPropagationBehavior(TransactionDefinition.PROPAGATION_NESTED);
        rollback.executeWithoutResult(status -> {
            accounts.closeAccount(member, member.nickname());
            assertThat(jdbc.sql("SELECT count(*) FROM auth_qq_identity WHERE user_id = :id")
                    .param("id", member.id()).query(Long.class).single()).isZero();
            status.setRollbackOnly();
        });
        assertThat(identities.findUserId("1234567", OPEN_ID)).isEqualTo(member.id().toString());
        assertThat(sessions.authenticate(first.sessionToken()).id()).isEqualTo(member.id());

        accounts.closeAccount(member, member.nickname());
        assertThat(identities.findUserId("1234567", OPEN_ID)).isNull();
        assertThatThrownBy(() -> sessions.authenticate(first.sessionToken())).isInstanceOf(AuthException.class);
        assertThatThrownBy(() -> login.exchange(flow.request(), VERIFIER)).isInstanceOf(AuthException.class);

        var replacement = login.exchange(ready(false).request(), VERIFIER);
        assertThat(replacement.newAccount()).isTrue();
        assertThat(replacement.user().id()).isNotEqualTo(member.id());
        assertThat(replacement.user().administrator()).isFalse();
        assertThat(identities.findUserId("1234567", OPEN_ID)).isEqualTo(replacement.user().id().toString());
        assertThat(jdbc.sql("SELECT nickname FROM app_user WHERE id = :id AND deleted_at IS NOT NULL")
                .param("id", member.id()).query(String.class).single()).isEqualTo("账号已注销");
    }

    @Test
    void migrationFromVersion24ReleasesOnlyClosedAccountsQqBindings() {
        String schema = "qq_migration_" + UUID.randomUUID().toString().replace("-", "");
        String jdbcUrl = POSTGRES.getJdbcUrl();
        var configuration = Flyway.configure().dataSource(jdbcUrl, POSTGRES.getUsername(), POSTGRES.getPassword())
                .schemas(schema).defaultSchema(schema);
        configuration.target("24").load().migrate();
        String schemaUrl = jdbcUrl + (jdbcUrl.contains("?") ? "&" : "?") + "currentSchema=" + schema;
        JdbcClient migrationJdbc = JdbcClient.create(new DriverManagerDataSource(schemaUrl, POSTGRES.getUsername(), POSTGRES.getPassword()));
        try {
            UUID closed = UUID.randomUUID();
            UUID active = UUID.randomUUID();
            migrationJdbc.sql("INSERT INTO app_user (id, nickname, avatar, created_at, deleted_at) "
                            + "VALUES (:closed, '账号已注销', '', NOW(), NOW()), (:active, '正常账号', '', NOW(), NULL)")
                    .param("closed", closed).param("active", active).update();
            migrationJdbc.sql("INSERT INTO auth_qq_identity (app_id, open_id, user_id, nickname, created_at) "
                            + "VALUES ('1234567', :closedOpenId, :closed, '旧 QQ', NOW()), ('1234567', :activeOpenId, :active, '正常 QQ', NOW())")
                    .param("closedOpenId", OPEN_ID).param("closed", closed)
                    .param("activeOpenId", "B".repeat(32)).param("active", active).update();

            assertThat(configuration.target("25").load().migrate().migrationsExecuted).isEqualTo(1);
            assertThat(migrationJdbc.sql("SELECT user_id FROM auth_qq_identity").query(UUID.class).list()).containsExactly(active);
            assertThat(migrationJdbc.sql("SELECT id FROM app_user").query(UUID.class).list()).containsExactlyInAnyOrder(closed, active);
        } finally {
            migrationJdbc.sql("DROP SCHEMA " + schema + " CASCADE").update();
        }
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

    @Test
    void savedQqConfigurationSurvivesServiceRecreationAndControlsLogin() {
        var owner = sessions.authenticate(ownerToken);
        settings.saveQqSettings(owner, new QqConfigurationRequest(false, "1234567", "", "https://example.com/api/auth/qq/callback"));
        var restored = new QqConfigurationService(new QqLoginProperties(), configurations);
        assertThat(restored.isEnabled()).isFalse();
        assertThat(restored.current().appKey()).isEqualTo("test-only-key");
        assertThatThrownBy(() -> login.start(AuthSecrets.hash(VERIFIER), false, false, null)).isInstanceOf(AuthException.class);
        settings.saveQqSettings(owner, new QqConfigurationRequest(true, "1234567", "rotated-key", "https://example.com/api/auth/qq/callback"));
        assertThat(restored.isEnabled()).isTrue();
        assertThat(restored.current().appKey()).isEqualTo("rotated-key");
        login.exchange(ready(false).request(), VERIFIER);
        assertThatThrownBy(() -> settings.saveQqSettings(owner,
                new QqConfigurationRequest(true, "7654321", "other-key", "https://example.com/api/auth/qq/callback")))
                .isInstanceOf(AuthException.class).hasMessageContaining("已有成员绑定");
        assertThat(restored.current().appId()).isEqualTo("1234567");
    }
}
