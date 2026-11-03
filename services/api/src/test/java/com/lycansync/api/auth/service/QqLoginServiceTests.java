package com.lycansync.api.auth.service;

import com.lycansync.api.auth.config.QqLoginProperties;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AccessLinkMapper;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.mapper.QqIdentityMapper;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.model.AuthUser;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.UUID;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * QQ 授权的浏览器绑定、一次性交付与老账号关联边界。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
class QqLoginServiceTests {
    private static final Instant NOW = Instant.parse("2026-11-03T00:00:00Z");
    private static final String VERIFIER = "v".repeat(43);
    private static final String OPEN_ID = "A".repeat(32);
    private final QqLoginProperties settings = new QqLoginProperties();
    private final QqIdentityClient client = mock(QqIdentityClient.class);
    private final QqIdentityMapper identities = mock(QqIdentityMapper.class);
    private final AuthMapper users = mock(AuthMapper.class);
    private final AccessLinkMapper access = mock(AccessLinkMapper.class);
    private final AuthService sessions = mock(AuthService.class);
    private final TransactionTemplate transactions = mock(TransactionTemplate.class);
    private QqLoginService service;

    @BeforeEach
    void setup() {
        settings.setEnabled(true); settings.setAppId("1234567"); settings.setAppKey("test-key");
        settings.setCallbackUrl("https://example.com/api/auth/qq/callback");
        when(access.lockInitialization()).thenReturn(true);
        when(client.exchange("test-code")).thenReturn(new QqIdentityClient.Identity(OPEN_ID, "来自 QQ 的昵称", DefaultAvatar.value()));
        when(identities.insert(anyString(), anyString(), any(), anyString(), any())).thenReturn(1);
        when(sessions.issueSession(any(), anyString())).thenAnswer(invocation -> invocation.getArgument(1));
        when(transactions.execute(any())).thenAnswer(invocation ->
                ((TransactionCallback<?>) invocation.getArgument(0)).doInTransaction(new SimpleTransactionStatus()));
        doAnswer(invocation -> { ((Consumer<org.springframework.transaction.TransactionStatus>) invocation.getArgument(0))
                .accept(new SimpleTransactionStatus()); return null; }).when(transactions).executeWithoutResult(any());
        service = new QqLoginService(settings, client, identities, users, access, sessions, transactions, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private QqLoginService.Start start(boolean binding, AuthenticatedUser user) {
        return service.start(AuthSecrets.hash(VERIFIER), true, binding, user);
    }

    private void ready(QqLoginService.Start start) {
        var authorization = service.authorize(start.request(), null);
        service.callback(start.request(), authorization.browserProof(), "test-code", null);
    }

    @Test
    void callbackRequiresBothStateAndOriginalBrowserAndCannotBeReplayed() {
        var start = start(false, null);
        var authorization = service.authorize(start.request(), null);
        assertThat(authorization.url()).startsWith("https://graph.qq.com/oauth2.0/authorize?");
        assertThatThrownBy(() -> service.callback(start.request(), "x".repeat(43), "test-code", null)).isInstanceOf(AuthException.class);
        verifyNoInteractions(client);
        service.callback(start.request(), authorization.browserProof(), "test-code", null);
        assertThatThrownBy(() -> service.callback(start.request(), authorization.browserProof(), "test-code", null)).isInstanceOf(AuthException.class);
        verify(client, times(1)).exchange("test-code");
        assertThat(service.result(start.request(), authorization.browserProof()).ready()).isTrue();
    }

    @Test
    void exchangeRequiresOriginalVerifierAndNewAccountIsNeverAdministrator() {
        var start = start(false, null); ready(start);
        assertThatThrownBy(() -> service.exchange(start.request(), "x".repeat(43))).isInstanceOf(AuthException.class);
        verifyNoInteractions(users);
        var response = service.exchange(start.request(), VERIFIER);
        assertThat(response.user().administrator()).isFalse();
        assertThat(response.newAccount()).isTrue();
        assertThat(response.user().nickname()).isEqualTo("来自 QQ 的昵称");
        assertThat(response.sessionToken()).matches("[A-Za-z0-9_-]{43}");
        verify(identities).insert(eq("1234567"), eq(OPEN_ID), eq(response.user().id()), anyString(), eq(NOW));
    }

    @Test
    void knownIdentityKeepsExistingProfileAndRetryOnlyReturnsItsOriginalActiveSession() {
        var user = new AuthUser(UUID.randomUUID(), "修改后的昵称", "", true, "自己的签名", NOW);
        when(identities.findUserId("1234567", OPEN_ID)).thenReturn(user.id().toString());
        when(users.findUserProfile(user.id())).thenReturn(user);
        var start = start(false, null); ready(start);
        var response = service.exchange(start.request(), VERIFIER);
        assertThat(response.user()).isEqualTo(user);
        assertThat(response.newAccount()).isFalse();
        assertThatThrownBy(() -> service.exchange(start.request(), VERIFIER)).isInstanceOf(AuthException.class);
        when(users.findSessionUser(AuthSecrets.hash(response.sessionToken()), NOW))
                .thenReturn(new AuthenticatedUser(user.id(), user.nickname(), true));
        assertThat(service.exchange(start.request(), VERIFIER)).isEqualTo(response);
        verify(sessions, times(1)).issueSession(any(), anyString());
        verify(users, never()).insertUser(any(), any());
    }

    @Test
    void bindingRequiresSameOriginalAccountAndSessionAndNeverOverwritesAnotherIdentity() {
        var owner = new AuthenticatedUser(UUID.randomUUID(), "服主", true, "original-hash");
        var start = start(true, owner); ready(start);
        assertThatThrownBy(() -> service.exchange(start.request(), VERIFIER)).isInstanceOf(AuthException.class);
        assertThatThrownBy(() -> service.confirmBinding(start.request(), VERIFIER,
                new AuthenticatedUser(owner.id(), owner.nickname(), true, "changed-hash"))).isInstanceOf(AuthException.class);
        when(identities.findUserId("1234567", OPEN_ID)).thenReturn(UUID.randomUUID().toString());
        assertThatThrownBy(() -> service.confirmBinding(start.request(), VERIFIER, owner)).isInstanceOf(AuthException.class);
        verify(identities, never()).insert(anyString(), anyString(), any(), anyString(), any());
        verifyNoInteractions(sessions);
    }

    @Test
    void disabledIncompleteCancelledAndUnfinishedFlowsNeverIssueSessions() {
        settings.setEnabled(false);
        assertThatThrownBy(() -> start(false, null)).isInstanceOf(AuthException.class);
        settings.setEnabled(true);
        var start = start(false, null);
        assertThatThrownBy(() -> service.exchange(start.request(), VERIFIER)).isInstanceOf(AuthException.class);
        var authorization = service.authorize(start.request(), null);
        service.callback(start.request(), authorization.browserProof(), null, "access_denied");
        assertThat(service.result(start.request(), authorization.browserProof()).error()).contains("取消");
        assertThatThrownBy(() -> service.exchange(start.request(), VERIFIER)).isInstanceOf(AuthException.class);
        verifyNoInteractions(client, sessions);
    }

    @Test
    void authorizationTasksAreBoundedAndApplicationConfigurationRejectsArbitraryCallback() {
        for (int i = 0; i < 128; i++) start(false, null);
        assertThatThrownBy(() -> start(false, null)).isInstanceOf(AuthException.class).hasMessageContaining("请求较多");
        settings.setCallbackUrl("https://user:password@example.com/api/auth/qq/callback");
        assertThatThrownBy(settings::validate).isInstanceOf(IllegalStateException.class);
    }
}
