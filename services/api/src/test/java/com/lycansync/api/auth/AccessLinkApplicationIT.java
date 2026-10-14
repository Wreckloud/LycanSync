package com.lycansync.api.auth;

import com.lycansync.api.auth.dto.AccessLinkRequest;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.service.AccessLinkService;
import com.lycansync.api.auth.service.AuthSecrets;
import com.lycansync.api.auth.service.AuthService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 独立 PostgreSQL 验证邀请一次性消费、并发与账号恢复事务。
 * @author Wreckloud
 * @since 2026-10-10
 */
@Testcontainers
@SpringBootTest(properties = "lycansync.account.public-url=https://example.com")
class AccessLinkApplicationIT {
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
    @Autowired private AccessLinkService links;
    @Autowired private AuthService sessions;
    @Autowired private JdbcClient jdbc;
    private AuthenticatedUser owner;

    @BeforeEach
    void setup() {
        jdbc.sql("TRUNCATE auth_access_link, user_presence, chat_attachment, chat_file_attachment, chat_file_upload_reservation, chat_message, group_member, chat_group, auth_session, auth_local_credential, app_user").update();
        jdbc.sql("UPDATE system_state SET initialized_at = NULL WHERE id = 1").update();
        var activation = links.activation();
        var result = links.redeem(token(activation), AuthSecrets.generate(), null);
        owner = sessions.authenticate(result.sessionToken());
        assertThat(owner.administrator()).isTrue();
    }

    @Test
    void shouldConsumeInvitationAndRestoreOriginalAccountWithoutResurrectingOldRetry() {
        var invitation = links.create(owner, new AccessLinkRequest("INVITE", null, "朋友"));
        String key = AuthSecrets.generate();
        var original = links.redeem(token(invitation), key, null);
        assertThat(links.redeem(token(invitation), key, null).sessionToken()).isEqualTo(original.sessionToken());
        assertThatThrownBy(() -> links.redeem(token(invitation), AuthSecrets.generate(), null)).isInstanceOf(AuthException.class);
        var recovery = links.create(owner, new AccessLinkRequest("RECOVERY", original.user().id(), "换电脑"));
        var restored = links.redeem(token(recovery), AuthSecrets.generate(), null);
        assertThat(restored.user()).usingRecursiveComparison().ignoringFields("createdAt").isEqualTo(original.user());
        // PostgreSQL 保存到微秒，恢复账号读取的是落库后的时间精度。
        assertThat(restored.user().createdAt()).isCloseTo(original.user().createdAt(),
                org.assertj.core.api.Assertions.within(1, java.time.temporal.ChronoUnit.MICROS));
        assertThatThrownBy(() -> sessions.authenticate(original.sessionToken())).isInstanceOf(AuthException.class);
        assertThatThrownBy(() -> links.redeem(token(invitation), key, null)).isInstanceOf(AuthException.class);
        assertThat(sessions.authenticate(restored.sessionToken()).id()).isEqualTo(original.user().id());
        assertThat(jdbc.sql("SELECT count(*) FROM app_user").query(Long.class).single()).isEqualTo(2);
    }

    @Test
    void shouldAllowOnlyOneRecipientUnderConcurrentRedemption() throws Exception {
        var invitation = links.create(owner, new AccessLinkRequest("INVITE", null, ""));
        var executor = Executors.newFixedThreadPool(2);
        try {
            Future<Boolean> first = executor.submit(() -> redeemOnce(token(invitation)));
            Future<Boolean> second = executor.submit(() -> redeemOnce(token(invitation)));
            assertThat(first.get(10, TimeUnit.SECONDS) != second.get(10, TimeUnit.SECONDS)).isTrue();
            assertThat(jdbc.sql("SELECT count(*) FROM app_user").query(Long.class).single()).isEqualTo(2);
            assertThat(links.list(owner, 0).get(0).consumedAt()).isNotNull();
        } finally { executor.shutdownNow(); }
    }

    @Test
    void shouldRollbackUserLinkAndSessionWhenSessionInsertionFails() {
        var invitation = links.create(owner, new AccessLinkRequest("INVITE", null, ""));
        jdbc.sql("ALTER TABLE auth_session ADD CONSTRAINT reject_member_session CHECK (user_id = '" + owner.id() + "')").update();
        try {
            assertThatThrownBy(() -> links.redeem(token(invitation), AuthSecrets.generate(), null))
                    .isInstanceOf(org.springframework.dao.DataAccessException.class);
            assertThat(jdbc.sql("SELECT count(*) FROM app_user").query(Long.class).single()).isEqualTo(1);
            assertThat(links.list(owner, 0).get(0).consumedAt()).isNull();
        } finally { jdbc.sql("ALTER TABLE auth_session DROP CONSTRAINT reject_member_session").update(); }
    }

    @Test
    void shouldInvalidateOldRecoveryAndInvitationAfterRegeneration() {
        var invitation = links.create(owner, new AccessLinkRequest("INVITE", null, ""));
        var renewed = links.renew(owner, invitation.record().id());
        assertThat(links.preview(token(invitation)).status()).isEqualTo("REVOKED");
        var member = links.redeem(token(renewed), AuthSecrets.generate(), null).user();
        var first = links.create(owner, new AccessLinkRequest("RECOVERY", member.id(), ""));
        var second = links.create(owner, new AccessLinkRequest("RECOVERY", member.id(), ""));
        assertThat(links.preview(token(first)).status()).isEqualTo("REVOKED");
        assertThat(links.preview(token(second)).status()).isEqualTo("PENDING");
    }

    private boolean redeemOnce(String token) {
        try { links.redeem(token, AuthSecrets.generate(), null); return true; }
        catch (AuthException exception) { return false; }
    }
    private String token(AccessLinkService.GeneratedLink generated) {
        return generated.url().substring(generated.url().indexOf("#token=") + 7);
    }
}
