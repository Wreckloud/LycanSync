package com.lycansync.api.auth;

import com.lycansync.api.auth.dto.LocalRegistrationRequest;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.service.AccountLifecycleService;
import com.lycansync.api.auth.service.AuthService;
import com.lycansync.api.auth.service.LocalAuthService;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.group.dto.CreateGroupRequest;
import com.lycansync.api.group.service.GroupService;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 在隔离 PostgreSQL 验证注销的行锁等待有界、超时保留访问及锁释放后可再次操作。
 *
 * @author Wreckloud
 * @since 2026-11-18
 */
@Testcontainers
@ActiveProfiles("test-fixtures")
@SpringBootTest(properties = "lycansync.account.public-url=https://synthetic.invalid")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class AccountClosureTimeoutApplicationIT {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:18.6-bookworm");

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        properties.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        properties.add("spring.datasource.username", POSTGRES::getUsername);
        properties.add("spring.datasource.password", POSTGRES::getPassword);
        properties.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        properties.add("spring.flyway.user", POSTGRES::getUsername);
        properties.add("spring.flyway.password", POSTGRES::getPassword);
    }

    @Autowired private LocalAuthService localAuth;
    @Autowired private AuthService sessions;
    @Autowired private AccountLifecycleService accounts;
    @Autowired private GroupService groups;
    @Autowired private JdbcClient jdbc;
    @Autowired private TransactionTemplate transactions;

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void shouldEndClosureBeforeHeldRowIsReleasedAndAllowAnExplicitRetry(boolean groupRow) throws Exception {
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        String password = "closure-test-password";
        var owner = sessions.authenticate(localAuth.register(new LocalRegistrationRequest("LockOwner" + suffix, password)).sessionToken());
        var registration = localAuth.register(new LocalRegistrationRequest("LockMember" + suffix, password));
        var member = sessions.authenticate(registration.sessionToken());
        var group = groups.createGroup(owner, new CreateGroupRequest("持锁注销测试", "", ""));
        groups.addMember(group.id(), owner, member.id());
        var held = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var workers = Executors.newFixedThreadPool(2);
        var holder = workers.submit(() -> transactions.executeWithoutResult(transaction -> {
            if (groupRow) jdbc.sql("SELECT id FROM chat_group WHERE id = :id FOR UPDATE").param("id", group.id()).query(UUID.class).single();
            else jdbc.sql("SELECT id FROM system_state WHERE id = 1 FOR UPDATE").query(Long.class).single();
            held.countDown();
            try {
                if (!release.await(20, TimeUnit.SECONDS)) throw new IllegalStateException("测试持锁线程未收到释放信号");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("测试持锁线程被中断", interrupted);
            }
        }));
        try {
            assertThat(held.await(5, TimeUnit.SECONDS)).isTrue();
            long started = System.nanoTime();
            var closing = workers.submit(() -> accounts.closeAccount(member, member.nickname()));
            assertThatThrownBy(() -> closing.get(13, TimeUnit.SECONDS))
                    .isInstanceOf(ExecutionException.class)
                    .satisfies(failure -> {
                        assertThat(failure.getCause()).isInstanceOfSatisfying(AuthException.class, timeout -> {
                            assertThat(timeout.getStatus()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                            assertThat(timeout.getCode()).isEqualTo(ApiErrorCode.AUTH_SERVICE_UNAVAILABLE);
                        });
                    });
            assertThat(Duration.ofNanos(System.nanoTime() - started).toMillis()).isBetween(9_000L, 13_000L);
            assertThat(holder.isDone()).isFalse();
            assertThat(sessions.authenticate(registration.sessionToken()).id()).isEqualTo(member.id());
            assertThat(jdbc.sql("SELECT deleted_at IS NULL FROM app_user WHERE id = :id").param("id", member.id()).query(Boolean.class).single()).isTrue();
        } finally {
            release.countDown();
            try {
                holder.get(5, TimeUnit.SECONDS);
            } finally {
                workers.shutdownNow();
                assertThat(workers.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
            }
        }
        accounts.closeAccount(member, member.nickname());
        assertThatThrownBy(() -> sessions.authenticate(registration.sessionToken())).isInstanceOf(AuthException.class);
        assertThat(groups.findGroup(group.id(), owner).members()).hasSize(1);
    }
}
