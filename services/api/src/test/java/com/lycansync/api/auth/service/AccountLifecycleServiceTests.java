package com.lycansync.api.auth.service;

import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AccessLinkMapper;
import com.lycansync.api.auth.mapper.AccountLifecycleMapper;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.group.mapper.GroupMapper;
import com.lycansync.api.group.model.GroupRole;
import com.lycansync.api.group.model.GroupView;
import com.lycansync.api.rtc.service.GroupRtcAccessService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 恢复凭据、双方交接和注销保留历史的业务边界。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
class AccountLifecycleServiceTests {
    private static final Instant NOW = Instant.parse("2026-11-03T00:00:00Z");
    private static final String PASSWORD = "owner-recovery-test-password";
    private final AccountLifecycleMapper accounts = mock(AccountLifecycleMapper.class);
    private final AccessLinkMapper links = mock(AccessLinkMapper.class);
    private final AuthMapper users = mock(AuthMapper.class);
    private final AuthService sessions = mock(AuthService.class);
    private final GroupMapper groups = mock(GroupMapper.class);
    private final GroupRtcAccessService rtc = mock(GroupRtcAccessService.class);
    private final ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
    private final TransactionTemplate transactions = mock(TransactionTemplate.class);
    private final AuthUser owner = new AuthUser(UUID.randomUUID(), "服主", "头像", true, "签名", NOW);
    private final AuthUser member = new AuthUser(UUID.randomUUID(), "朋友", "头像", false, "签名", NOW);
    private final AtomicReference<AccountLifecycleMapper.State> state = new AtomicReference<>();
    private AccountLifecycleService service;

    @BeforeEach
    void setup() {
        when(links.lockInitialization()).thenReturn(true);
        when(users.findUserProfile(owner.id())).thenReturn(owner);
        when(users.findUserProfile(member.id())).thenReturn(member);
        when(accounts.state()).thenAnswer(invocation -> state.get());
        state.set(new AccountLifecycleMapper.State(true, owner.id(), null, null, null, null));
        doAnswer(invocation -> {
            var previous = state.get();
            state.set(new AccountLifecycleMapper.State(true, previous.ownerId(), invocation.getArgument(0),
                    invocation.getArgument(1), previous.transferTargetId(), previous.transferExpiresAt()));
            return null;
        }).when(accounts).saveRecovery(any(), anyString());
        doAnswer(invocation -> { ((Consumer<TransactionStatus>) invocation.getArgument(0))
                .accept(new SimpleTransactionStatus()); return null; }).when(transactions).executeWithoutResult(any());
        when(transactions.execute(any())).thenAnswer(invocation ->
                ((TransactionCallback<?>) invocation.getArgument(0)).doInTransaction(new SimpleTransactionStatus()));
        when(sessions.issueSession(any(), anyString())).thenAnswer(invocation -> invocation.getArgument(1));
        service = new AccountLifecycleService(accounts, links, users, sessions, groups, rtc, events,
                transactions, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    @Test
    void shouldRecoverSameOwnerWithStableRetryAndRejectWrongPassword() {
        service.initializeRecovery(owner.id(), PASSWORD);
        assertThat(state.get().recoveryHash()).doesNotContain(PASSWORD);
        assertThatThrownBy(() -> service.recover("wrong", "a".repeat(43))).isInstanceOf(AuthException.class);
        verifyNoInteractions(sessions);
        var recovered = service.recover(PASSWORD, "a".repeat(43));
        assertThat(recovered.user()).isEqualTo(owner);
        assertThat(service.recover(PASSWORD, "a".repeat(43)).sessionToken()).isEqualTo(recovered.sessionToken());
        assertThat(service.recover(PASSWORD, "b".repeat(43)).sessionToken()).isNotEqualTo(recovered.sessionToken());
    }

    @Test
    void shouldRequireExistingPasswordBeforeReplacingRecoverySecret() {
        service.initializeRecovery(owner.id(), PASSWORD);
        var original = state.get().recoveryHash();
        assertThatThrownBy(() -> service.saveRecovery(principal(owner), "wrong", "replacement-password"))
                .isInstanceOf(AuthException.class);
        assertThat(state.get().recoveryHash()).isEqualTo(original);
        service.saveRecovery(principal(owner), PASSWORD, "replacement-password");
        assertThatThrownBy(() -> service.recover(PASSWORD, "a".repeat(43))).isInstanceOf(AuthException.class);
        assertThat(service.recover("replacement-password", "a".repeat(43)).user().id()).isEqualTo(owner.id());
    }

    @Test
    void shouldOnlyTransferAfterTargetAcceptsAndReplaceOldCredentials() {
        service.initializeRecovery(owner.id(), PASSWORD);
        service.offerTransfer(principal(owner), member.id(), PASSWORD);
        verify(accounts).offerTransfer(member.id(), NOW.plusSeconds(86400));
        verify(accounts, never()).demoteOwner(any());
        var previous = state.get();
        state.set(new AccountLifecycleMapper.State(true, owner.id(), owner.id(), previous.recoveryHash(), member.id(), NOW.plusSeconds(86400)));
        assertThatThrownBy(() -> service.acceptTransfer(principal(owner), "replacement-password"))
                .isInstanceOf(AuthException.class);
        when(accounts.demoteOwner(owner.id())).thenReturn(1);
        when(accounts.promoteOwner(member.id())).thenAnswer(invocation -> {
            var current = state.get();
            state.set(new AccountLifecycleMapper.State(true, member.id(), owner.id(), current.recoveryHash(), member.id(), current.transferExpiresAt()));
            return 1;
        });
        when(users.findUserProfile(member.id())).thenReturn(new AuthUser(member.id(), member.nickname(), member.avatar(), true, member.signature(), NOW));
        assertThat(service.acceptTransfer(principal(member), "replacement-password").administrator()).isTrue();
        var order = inOrder(accounts);
        order.verify(accounts).demoteOwner(owner.id());
        order.verify(accounts).promoteOwner(member.id());
        order.verify(accounts).saveRecovery(eq(member.id()), anyString());
        order.verify(accounts).clearTransfer();
        order.verify(accounts).revokePendingLinks(NOW);
        assertThatThrownBy(() -> service.recover(PASSWORD, "a".repeat(43))).isInstanceOf(AuthException.class);
        assertThat(service.recover("replacement-password", "a".repeat(43)).user().id()).isEqualTo(member.id());
    }

    @Test
    void shouldRejectExpiredOrDeletedTransferTarget() {
        state.set(new AccountLifecycleMapper.State(true, owner.id(), null, null, member.id(), NOW));
        assertThatThrownBy(() -> service.acceptTransfer(principal(member), PASSWORD)).isInstanceOf(AuthException.class);
        when(users.findUserProfile(member.id())).thenReturn(new AuthUser(member.id(), "朋友", "", false, "", NOW, NOW));
        assertThatThrownBy(() -> service.status(principal(member))).isInstanceOf(AuthException.class);
        verify(accounts, never()).promoteOwner(any());
    }

    @Test
    void shouldRequireServerAndGroupOwnershipToBeTransferredBeforeClosure() {
        assertThatThrownBy(() -> service.closeAccount(principal(owner), "注销账号")).isInstanceOf(AuthException.class);
        UUID groupId = UUID.randomUUID();
        when(groups.findGroups(member.id())).thenReturn(List.of(new GroupView(groupId, "群组", "", "", GroupRole.OWNER, 1, NOW, NOW)));
        assertThatThrownBy(() -> service.closeAccount(principal(member), "注销账号")).isInstanceOf(AuthException.class);
        verify(accounts, never()).closeAccount(any(), any());
        verifyNoInteractions(rtc);
    }

    @Test
    void shouldRevokeAccessButKeepMembershipAndIdentityHistory() {
        UUID groupId = UUID.randomUUID();
        UUID room = UUID.randomUUID();
        when(groups.findGroups(member.id())).thenReturn(List.of(new GroupView(groupId, "群组", "", "", GroupRole.MEMBER, 2, NOW, NOW)));
        when(groups.findRtcRoomKey(groupId)).thenReturn(room.toString());
        when(accounts.closeAccount(member.id(), NOW)).thenReturn(1);
        service.closeAccount(principal(member), "注销账号");
        var order = inOrder(rtc, accounts);
        order.verify(rtc).removeParticipant(room, member.id());
        order.verify(accounts).closeAccount(member.id(), NOW);
        order.verify(accounts).revokeSessions(member.id());
        order.verify(accounts).revokeLinks(member.id(), NOW);
        verify(groups, never()).removeMember(any(), any());
        verify(users, never()).updateProfile(any(), anyString(), anyString(), anyString());
        verify(events).publishEvent(any(Object.class));
    }

    private AuthenticatedUser principal(AuthUser user) {
        return new AuthenticatedUser(user.id(), user.nickname(), user.administrator());
    }
}
