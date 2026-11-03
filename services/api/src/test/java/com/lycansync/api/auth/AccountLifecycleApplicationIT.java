package com.lycansync.api.auth;

import com.lycansync.api.auth.dto.AccessLinkRequest;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.service.AccessLinkService;
import com.lycansync.api.auth.service.AccountLifecycleService;
import com.lycansync.api.auth.service.AuthSecrets;
import com.lycansync.api.auth.service.AuthService;
import com.lycansync.api.chat.service.ChatService;
import com.lycansync.api.group.dto.CreateGroupRequest;
import com.lycansync.api.group.service.GroupService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.annotation.Transactional;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 在隔离数据库验证迁移、服主交接、凭据撤销及历史资料映射。
 * @author Wreckloud
 * @since 2026-11-03
 */
@EnabledIfEnvironmentVariable(named = "ACCOUNT_TEST_DB_URL", matches = ".+/lycansync_lifecycle_test")
@ActiveProfiles("test-fixtures")
@SpringBootTest(properties = "lycansync.account.public-url=https://example.com")
@Transactional
class AccountLifecycleApplicationIT {
    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        properties.add("spring.datasource.url", () -> System.getenv("ACCOUNT_TEST_DB_URL"));
        properties.add("spring.datasource.username", () -> "postgres");
        properties.add("spring.datasource.password", () -> System.getenv("ACCOUNT_TEST_DB_PASSWORD"));
        properties.add("spring.flyway.user", () -> "postgres");
        properties.add("spring.flyway.password", () -> System.getenv("ACCOUNT_TEST_DB_PASSWORD"));
    }
    @Autowired private JdbcClient jdbc;
    @Autowired private AccessLinkService links;
    @Autowired private AuthService sessions;
    @Autowired private AccountLifecycleService accounts;
    @Autowired private GroupService groups;
    @Autowired private ChatService chat;

    @Test
    void shouldRecoverTransferAndCloseWhilePreservingHistoricalIdentity() {
        assertThat(jdbc.sql("SELECT current_database()").query(String.class).single()).isEqualTo("lycansync_lifecycle_test");
        var activation = links.activation();
        String password = "owner-recovery-test-password";
        var first = links.redeem(token(activation), AuthSecrets.generate(), null, password);
        var recovered = accounts.recover(password, AuthSecrets.generate());
        assertThat(recovered.user().id()).isEqualTo(first.user().id());
        assertThatThrownBy(() -> sessions.authenticate(first.sessionToken())).isInstanceOf(AuthException.class);
        var owner = sessions.authenticate(recovered.sessionToken());
        var invitation = links.create(owner, new AccessLinkRequest("INVITE", null, "测试"));
        var joined = links.redeem(token(invitation), AuthSecrets.generate(), null);
        var member = sessions.authenticate(joined.sessionToken());
        var group = groups.createGroup(owner, new CreateGroupRequest("历史保留测试", "", ""));
        groups.addMember(group.id(), owner, member.id());
        var message = chat.sendMessage(group.id(), owner, "保留这条消息", null, null);
        groups.transferOwner(group.id(), owner, member.id());
        accounts.offerTransfer(owner, member.id(), password);
        accounts.acceptTransfer(member, "new-owner-recovery-password");
        assertThat(sessions.authenticate(recovered.sessionToken()).administrator()).isFalse();
        assertThat(sessions.authenticate(joined.sessionToken()).administrator()).isTrue();
        assertThatThrownBy(() -> accounts.recover(password, AuthSecrets.generate())).isInstanceOf(AuthException.class);
        accounts.closeAccount(owner, "注销账号");
        assertThatThrownBy(() -> sessions.authenticate(recovered.sessionToken())).isInstanceOf(AuthException.class);
        assertThat(groups.findGroup(group.id(), member).members()).hasSize(1);
        var historical = chat.findMessages(group.id(), member, null, null).messages().get(0);
        assertThat(historical.id()).isEqualTo(message.id());
        assertThat(historical.senderNickname()).isEqualTo(first.user().nickname());
        assertThat(historical.senderAvatar()).isEqualTo(first.user().avatar());
        assertThat(historical.senderDeletedAt()).isNotNull();
        assertThat(groups.findMemberProfile(group.id(), owner.id(), member).deletedAt()).isNotNull();
    }
    private String token(AccessLinkService.GeneratedLink generated) {
        return generated.url().substring(generated.url().indexOf("#token=") + 7);
    }
}
