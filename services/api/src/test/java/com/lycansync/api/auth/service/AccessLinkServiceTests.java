package com.lycansync.api.auth.service;

import com.lycansync.api.auth.config.AccountAccessProperties;
import com.lycansync.api.auth.dto.AccessLinkRequest;
import com.lycansync.api.auth.exception.AuthException;
import com.lycansync.api.auth.mapper.AccessLinkMapper;
import com.lycansync.api.auth.mapper.AuthMapper;
import com.lycansync.api.auth.model.AccessLink;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.model.AuthenticatedUser;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.UUID;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 邀请时效、身份归属与响应丢失重试边界。
 * @author Wreckloud
 * @since 2026-10-10
 */
class AccessLinkServiceTests {
    private static final Instant NOW = Instant.parse("2026-10-10T00:00:00Z");
    private static final String TOKEN = "a".repeat(43);
    private static final String KEY = "b".repeat(43);
    private final AccessLinkMapper links = mock(AccessLinkMapper.class);
    private final AuthMapper users = mock(AuthMapper.class);
    private final AuthService sessions = mock(AuthService.class);
    private final TransactionTemplate transactions = mock(TransactionTemplate.class);
    private final AccountAccessProperties settings = new AccountAccessProperties();
    private final AuthUser member = new AuthUser(UUID.randomUUID(), "朋友", "", false, "签名", NOW);
    private final AuthenticatedUser owner = new AuthenticatedUser(UUID.randomUUID(), "服主", true);
    private AccessLinkService service;

    @BeforeEach
    void setup() {
        settings.setPublicUrl("https://example.com");
        when(transactions.execute(any())).thenAnswer(invocation ->
                ((TransactionCallback<?>) invocation.getArgument(0)).doInTransaction(new SimpleTransactionStatus()));
        when(links.lockInitialization()).thenReturn(true);
        when(links.consume(any(), any(), anyString(), any())).thenReturn(1);
        when(sessions.issueSession(any(), anyString())).thenAnswer(invocation -> invocation.getArgument(1));
        service = new AccessLinkService(links, users, sessions, settings, transactions, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    @Test
    void shouldUseThreeDaysForInvitationAndTwelveHoursForRecovery() {
        var invitation = service.create(owner, new AccessLinkRequest("INVITE", null, "朋友一"));
        assertThat(Duration.between(NOW, invitation.record().expiresAt())).isEqualTo(Duration.ofDays(3));
        when(users.findUserProfile(member.id())).thenReturn(member);
        var recovery = service.create(owner, new AccessLinkRequest("RECOVERY", member.id(), ""));
        assertThat(Duration.between(NOW, recovery.record().expiresAt())).isEqualTo(Duration.ofHours(12));
        verify(links).revokeRecovery(eq(member.id()), eq(NOW));
    }

    @Test
    void shouldRejectMemberManagementAndAdminRecovery() {
        assertThatThrownBy(() -> service.create(new AuthenticatedUser(member.id(), "朋友", false),
                new AccessLinkRequest("INVITE", null, ""))).isInstanceOf(AuthException.class);
        when(users.findUserProfile(owner.id())).thenReturn(new AuthUser(owner.id(), "服主", "", true, "", NOW));
        assertThatThrownBy(() -> service.create(owner, new AccessLinkRequest("RECOVERY", owner.id(), "")))
                .isInstanceOf(AuthException.class);
        verify(links, never()).insert(any(), anyString());
    }

    @Test
    void shouldRestoreSameProfileAndReplaceItsSession() {
        AccessLink link = link("RECOVERY", null, NOW.plusSeconds(60));
        when(links.lockByHash(AuthSecrets.hash(TOKEN))).thenReturn(link);
        when(users.findUserProfile(member.id())).thenReturn(member);
        var result = service.redeem(TOKEN, KEY, null);
        assertThat(result.user()).isSameAs(member);
        verify(users, never()).insertUser(any(), any());
        verify(sessions).issueSession(eq(member), eq(result.sessionToken()));
    }

    @Test
    void shouldNotCreateOrReplaceAccountWhileAlreadyLoggedIn() {
        when(links.lockByHash(anyString())).thenReturn(link("INVITE", null, NOW.plusSeconds(60)));
        assertThatThrownBy(() -> service.redeem(TOKEN, KEY, owner)).isInstanceOf(AuthException.class);
        verifyNoInteractions(sessions);
        verify(links, never()).consume(any(), any(), anyString(), any());
    }

    @Test
    void shouldIssueIdenticalCredentialOnlyForOriginalRetryWithinTwoMinutes() {
        AccessLink pending = link("RECOVERY", null, NOW.plusSeconds(600));
        AccessLink completed = new AccessLink(pending.id(), "RECOVERY", owner.id(), member.id(), "", NOW,
                pending.expiresAt(), NOW.minusSeconds(60), null, member.id(), null, null);
        when(links.lockByHash(anyString())).thenReturn(pending, completed);
        when(users.findUserProfile(member.id())).thenReturn(member);
        when(links.redemptionKeyHash(pending.id())).thenReturn(AuthSecrets.hash(KEY));
        when(users.findSessionUser(anyString(), eq(NOW))).thenReturn(new AuthenticatedUser(member.id(), "朋友", false));
        var first = service.redeem(TOKEN, KEY, null);
        var retry = service.redeem(TOKEN, KEY, null);
        assertThat(retry.sessionToken()).isEqualTo(first.sessionToken());
        assertThatThrownBy(() -> service.redeem(TOKEN, "c".repeat(43), null)).isInstanceOf(AuthException.class);
        verify(links, times(1)).consume(any(), any(), anyString(), any());
        verify(sessions, times(1)).issueSession(any(), anyString());
    }

    @Test
    void shouldRejectExpiredLinkWithoutChangingUserOrSession() {
        when(links.lockByHash(anyString())).thenReturn(link("RECOVERY", null, NOW));
        assertThatThrownBy(() -> service.redeem(TOKEN, KEY, null)).isInstanceOf(AuthException.class);
        verifyNoInteractions(sessions);
        verify(users, never()).insertUser(any(), any());
        verify(links).recordFailure(eq(AuthSecrets.hash(TOKEN)), anyString(), eq(NOW));
    }

    @Test
    void shouldNotResurrectLoggedOutSessionUsingRetryCredential() {
        AccessLink completed = new AccessLink(UUID.randomUUID(), "INVITE", owner.id(), null, "", NOW.minusSeconds(100),
                NOW.plusSeconds(600), NOW.minusSeconds(10), null, member.id(), null, null);
        when(links.lockByHash(anyString())).thenReturn(completed);
        when(links.redemptionKeyHash(completed.id())).thenReturn(AuthSecrets.hash(KEY));
        when(users.findUserProfile(member.id())).thenReturn(member);
        assertThatThrownBy(() -> service.redeem(TOKEN, KEY, null)).isInstanceOf(AuthException.class);
        verifyNoInteractions(sessions);
    }

    @Test
    void shouldRejectOriginalRetryAfterTwoMinuteWindow() {
        AccessLink completed = new AccessLink(UUID.randomUUID(), "INVITE", owner.id(), null, "", NOW.minusSeconds(200),
                NOW.plusSeconds(600), NOW.minusSeconds(120), null, member.id(), null, null);
        when(links.lockByHash(anyString())).thenReturn(completed);
        assertThatThrownBy(() -> service.redeem(TOKEN, KEY, null)).isInstanceOf(AuthException.class);
        verifyNoInteractions(sessions);
    }

    @Test
    void shouldCreateNumberedDefaultProfileAndKeepCredentialsOutOfListRecord() {
        when(links.lockByHash(anyString())).thenReturn(link("INVITE", null, NOW.plusSeconds(60)));
        when(links.nextGuestNumber()).thenReturn(1001L);
        var result = service.redeem(TOKEN, KEY, null);
        assertThat(result.user().nickname()).isEqualTo("行者1001");
        assertThat(result.user().avatar()).isEqualTo(DefaultAvatar.value());
        assertThat(result.user().signature()).isEmpty();
        assertThat(result.user().administrator()).isFalse();
        verify(users).insertUser(eq(result.user()), eq(NOW));
    }

    @Test
    void shouldInvalidatePreviousUnconsumedLinkWhenRenewed() {
        AccessLink previous = link("INVITE", null, NOW.minusSeconds(1));
        when(links.lockById(previous.id())).thenReturn(previous);
        var renewed = service.renew(owner, previous.id());
        verify(links).revoke(previous.id(), NOW);
        assertThat(renewed.record().id()).isNotEqualTo(previous.id());
    }

    private AccessLink link(String kind, Instant consumed, Instant expires) {
        return new AccessLink(UUID.randomUUID(), kind, owner.id(), "RECOVERY".equals(kind) ? member.id() : null,
                "", NOW.minusSeconds(100), expires, consumed, null, consumed == null ? null : member.id(), null, null);
    }
}
