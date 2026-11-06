package com.lycansync.api.presence.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.presence.dto.PresenceHeartbeatRequest;
import com.lycansync.api.presence.event.PresenceChangedEvent;
import com.lycansync.api.presence.mapper.PresenceMapper;
import com.lycansync.api.presence.model.PresenceExpiryCandidate;
import com.lycansync.api.presence.model.UserActivityType;
import com.lycansync.api.presence.model.UserPresence;
import com.lycansync.api.presence.model.UserPresenceStatus;
import jakarta.validation.Validation;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.context.ApplicationEventPublisher;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 核对公开在线时间、最近游戏与隐身边界。
 *
 * @author Wreckloud
 * @since 2026-11-01
 */
class PresenceServiceTests {
    private static final Instant NOW = Instant.parse("2026-11-01T08:00:00Z");
    private static final UUID USER_ID = UUID.fromString("487d94a4-24d4-4529-b284-26e4fba2b32a");
    private static final String SESSION_HASH = "server-only-session-hash";
    private final PresenceMapper mapper = mock(PresenceMapper.class);
    private final ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
    private final PresenceService service = new PresenceService(mapper, Clock.fixed(NOW, ZoneOffset.UTC), events);

    @Test
    void shouldPreserveAnOngoingPublicGameWithoutNotifyingEachHeartbeat() {
        UserPresence previous = presence(UserPresenceStatus.ONLINE, UserActivityType.GAME, "游戏", true, true);
        UserPresence next = heartbeat(previous, UserPresenceStatus.ONLINE, game("游戏"), null, null);
        assertThat(next.activityStartedAt()).isEqualTo(previous.activityStartedAt());
        assertThat(next.lastOnlineAt()).isEqualTo(NOW);
        assertThat(next.recentGameName()).isEqualTo("上一款游戏");
        verify(events, never()).publishEvent(any(PresenceChangedEvent.class));
    }

    @Test
    void shouldKeepTheLastFinishedGameWhileMusicUsesTheExistingActivityChain() {
        UserPresence next = heartbeat(presence(UserPresenceStatus.ONLINE, UserActivityType.GAME, "游戏", true, true),
                UserPresenceStatus.ONLINE, new PresenceHeartbeatRequest.Activity(UserActivityType.MUSIC, " 歌曲 "), null, null);
        assertThat(next.activityType()).isEqualTo(UserActivityType.MUSIC);
        assertThat(next.activityName()).isEqualTo("歌曲");
        assertThat(next.recentGameName()).isEqualTo("游戏");
        assertThat(next.recentGameEndedAt()).isEqualTo(NOW);
        assertThat(next.recentGamePlayedSeconds()).isEqualTo(3600L);
        verify(events).publishEvent(any(PresenceChangedEvent.class));
    }

    @Test
    void shouldFreezePublicHistoryAcrossRepeatedInvisibleHeartbeats() {
        UserPresence next = heartbeat(presence(UserPresenceStatus.ONLINE, UserActivityType.GAME, "公开游戏", true, true),
                UserPresenceStatus.OFFLINE, game("隐身游戏"), null, null);
        assertThat(next.activityName()).isNull();
        assertThat(next.lastOnlineAt()).isEqualTo(NOW.minusSeconds(20));
        assertThat(next.recentGameName()).isEqualTo("公开游戏");
        reset(mapper, events);
        when(mapper.findByUserForUpdate(USER_ID)).thenReturn(next);
        when(mapper.upsert(any(), eq(SESSION_HASH))).thenReturn(1);
        new PresenceService(mapper, Clock.fixed(NOW.plusSeconds(600), ZoneOffset.UTC), events)
                .heartbeat(user(), new PresenceHeartbeatRequest(UserPresenceStatus.OFFLINE, game("另一游戏"), null, null));
        ArgumentCaptor<UserPresence> captured = ArgumentCaptor.forClass(UserPresence.class);
        verify(mapper).upsert(captured.capture(), eq(SESSION_HASH));
        assertThat(captured.getValue().lastSeenAt()).isEqualTo(NOW.plusSeconds(600));
        assertThat(captured.getValue().lastOnlineAt()).isEqualTo(next.lastOnlineAt());
        assertThat(captured.getValue().recentGameEndedAt()).isEqualTo(next.recentGameEndedAt());
        assertThat(captured.getValue().recentGamePlayedSeconds()).isEqualTo(next.recentGamePlayedSeconds());
        verify(events, never()).publishEvent(any(PresenceChangedEvent.class));
    }

    @Test
    void shouldStartANewPublicSegmentAfterInvisibleTime() {
        UserPresence previous = presence(UserPresenceStatus.OFFLINE, null, null, true, true);
        UserPresence next = heartbeat(previous, UserPresenceStatus.ONLINE, game("游戏"), null, null);
        assertThat(next.activityStartedAt()).isEqualTo(NOW);
        assertThat(next.recentGameName()).isEqualTo(previous.recentGameName());
    }

    @Test
    void shouldFinishAndKeepPublicGameWhenDisabledButKeepLastOnlineIndependently() {
        UserPresence next = heartbeat(presence(UserPresenceStatus.ONLINE, UserActivityType.GAME, "游戏", true, true),
                UserPresenceStatus.OFFLINE, game("游戏"), false, true);
        assertThat(next.showActivity()).isFalse();
        assertThat(next.recentGameName()).isEqualTo("游戏");
        assertThat(next.recentGameEndedAt()).isEqualTo(NOW);
        assertThat(next.recentGamePlayedSeconds()).isEqualTo(3600L);
        assertThat(next.activityName()).isNull();
        assertThat(next.lastOnlineAt()).isNotNull();
    }

    @Test
    void shouldKeepHistoryWhileDisabledAndRestoreWithoutCountingHiddenTime() {
        UserPresence previous = presence(UserPresenceStatus.ONLINE, null, null, true, true);
        UserPresence hidden = heartbeat(previous, UserPresenceStatus.ONLINE, game("不应记录"), false, null);
        assertThat(hidden.recentGameName()).isEqualTo(previous.recentGameName());
        assertThat(hidden.recentGameEndedAt()).isEqualTo(previous.recentGameEndedAt());
        assertThat(hidden.recentGamePlayedSeconds()).isEqualTo(previous.recentGamePlayedSeconds());
        assertThat(hidden.activityName()).isNull();
        for (boolean visible : List.of(false, true)) {
            reset(mapper, events);
            when(mapper.findByUserForUpdate(USER_ID)).thenReturn(hidden);
            when(mapper.upsert(any(), eq(SESSION_HASH))).thenReturn(1);
            Instant later = NOW.plusSeconds(600);
            new PresenceService(mapper, Clock.fixed(later, ZoneOffset.UTC), events)
                    .heartbeat(user(), new PresenceHeartbeatRequest(UserPresenceStatus.ONLINE, game("新游戏"), visible, null));
            ArgumentCaptor<UserPresence> captured = ArgumentCaptor.forClass(UserPresence.class);
            verify(mapper).upsert(captured.capture(), eq(SESSION_HASH));
            UserPresence next = captured.getValue();
            assertThat(next.showActivity()).isEqualTo(visible);
            assertThat(next.activityName()).isEqualTo(visible ? "新游戏" : null);
            assertThat(next.activityStartedAt()).isEqualTo(visible ? later : null);
            assertThat(next.recentGameName()).isEqualTo(hidden.recentGameName());
            assertThat(next.recentGameEndedAt()).isEqualTo(hidden.recentGameEndedAt());
            assertThat(next.recentGamePlayedSeconds()).isEqualTo(hidden.recentGamePlayedSeconds());
        }
    }

    @Test
    void shouldHideLastOnlineWithoutDisablingGames() {
        UserPresence next = heartbeat(presence(UserPresenceStatus.ONLINE, UserActivityType.GAME, "游戏", true, true),
                UserPresenceStatus.ONLINE, game("游戏"), true, false);
        assertThat(next.lastOnlineAt()).isNull();
        assertThat(next.activityName()).isEqualTo("游戏");
        assertThat(next.recentGameName()).isNotNull();
        verify(events).publishEvent(any(PresenceChangedEvent.class));
    }

    @Test
    void shouldPreserveDisabledVisibilityForPayloadsWithoutNewFields() {
        UserPresence previous = new UserPresence(USER_ID, UserPresenceStatus.OFFLINE, NOW.minusSeconds(20),
                null, null, null, NOW.minusSeconds(20), false, false, null, null, null, null);
        UserPresence next = heartbeat(previous, UserPresenceStatus.ONLINE, game("不应公开"), null, null);
        assertThat(next.lastOnlineAt()).isNull();
        assertThat(next.activityName()).isNull();
        assertThat(next.recentGameName()).isNull();
    }

    @Test
    void shouldNotInventHistoryForAnUnknownOfflineUser() {
        UserPresence next = heartbeat(null, UserPresenceStatus.OFFLINE, null, null, null);
        assertThat(next.lastOnlineAt()).isNull();
        assertThat(next.recentGameName()).isNull();
    }

    @Test
    void shouldNotNotifyWhenSessionStopsBeingCurrent() {
        when(mapper.findByUserForUpdate(USER_ID)).thenReturn(presence(UserPresenceStatus.ONLINE, null, null, true, true));
        when(mapper.upsert(any(), eq(SESSION_HASH))).thenReturn(0);
        service.heartbeat(user(), new PresenceHeartbeatRequest(UserPresenceStatus.OFFLINE, null, null, null));
        verify(events, never()).publishEvent(any(PresenceChangedEvent.class));
    }

    @Test
    void shouldFinishAStaleGameAtTheLastValidHeartbeatInsteadOfTheExpiryCheck() {
        Instant lastSeen = NOW.minusSeconds(70);
        when(mapper.findExpired(NOW.minusSeconds(65))).thenReturn(List.of(new PresenceExpiryCandidate(USER_ID, lastSeen)));
        UserPresence previous = new UserPresence(USER_ID, UserPresenceStatus.ONLINE, lastSeen, UserActivityType.GAME,
                "游戏", NOW.minusSeconds(3600), lastSeen, true, true, lastSeen, null, null, null);
        when(mapper.findByUserForUpdate(USER_ID)).thenReturn(previous);
        when(mapper.markOfflineIfUnchanged(any(), eq(NOW.minusSeconds(65)), eq(NOW))).thenReturn(1);
        service.markExpiredOffline();
        ArgumentCaptor<UserPresence> captured = ArgumentCaptor.forClass(UserPresence.class);
        verify(mapper).markOfflineIfUnchanged(captured.capture(), eq(NOW.minusSeconds(65)), eq(NOW));
        assertThat(captured.getValue().recentGameEndedAt()).isEqualTo(lastSeen);
        assertThat(captured.getValue().recentGamePlayedSeconds()).isEqualTo(3530L);
        verify(events).publishEvent(any(PresenceChangedEvent.class));
    }

    @Test
    void shouldNotExpireAConcurrentHeartbeat() {
        when(mapper.findExpired(NOW.minusSeconds(65)))
                .thenReturn(List.of(new PresenceExpiryCandidate(USER_ID, NOW.minusSeconds(70))));
        when(mapper.findByUserForUpdate(USER_ID)).thenReturn(presence(UserPresenceStatus.ONLINE, null, null, true, true));
        service.markExpiredOffline();
        verify(mapper, never()).markOfflineIfUnchanged(any(), any(), any());
        verify(events, never()).publishEvent(any(PresenceChangedEvent.class));
    }

    @Test
    void shouldAcceptOldPayloadsAndRetainActivityValidation() throws Exception {
        ObjectMapper json = new ObjectMapper();
        PresenceHeartbeatRequest request = json.readValue("""
                {"status":"ONLINE","activity":{"type":"MUSIC","name":"歌曲"}}
                """, PresenceHeartbeatRequest.class);
        assertThat(request.showActivity()).isNull();
        assertThat(request.showLastOnline()).isNull();
        try (var factory = Validation.buildDefaultValidatorFactory()) {
            assertThat(factory.getValidator().validate(request)).isEmpty();
            assertThat(factory.getValidator().validate(new PresenceHeartbeatRequest(UserPresenceStatus.ONLINE,
                    game("x".repeat(81)), null, null))).isNotEmpty();
            assertThat(factory.getValidator().validate(new PresenceHeartbeatRequest(UserPresenceStatus.ONLINE,
                    game("控制\n字符"), null, null))).isNotEmpty();
        }
        assertThrows(JsonProcessingException.class, () -> json.readValue("""
                {"status":"ONLINE","activity":{"type":"OTHER","name":"任意程序"}}
                """, PresenceHeartbeatRequest.class));
    }

    @Test
    void shouldNotBridgeAStaleGameAcrossAnUnprocessedDisconnect() {
        Instant lastSeen = NOW.minusSeconds(90);
        UserPresence previous = new UserPresence(USER_ID, UserPresenceStatus.ONLINE, lastSeen, UserActivityType.GAME,
                "游戏", NOW.minusSeconds(3600), lastSeen, true, true, lastSeen, null, null, null);
        UserPresence next = heartbeat(previous, UserPresenceStatus.ONLINE, game("游戏"), null, null);
        assertThat(next.activityStartedAt()).isEqualTo(NOW);
        assertThat(next.recentGameEndedAt()).isEqualTo(lastSeen);
        assertThat(next.recentGamePlayedSeconds()).isEqualTo(3510L);
    }

    private UserPresence heartbeat(UserPresence previous, UserPresenceStatus status,
                                   PresenceHeartbeatRequest.Activity activity, Boolean showActivity, Boolean showLastOnline) {
        when(mapper.findByUserForUpdate(USER_ID)).thenReturn(previous);
        when(mapper.upsert(any(), eq(SESSION_HASH))).thenReturn(1);
        service.heartbeat(user(), new PresenceHeartbeatRequest(status, activity, showActivity, showLastOnline));
        ArgumentCaptor<UserPresence> captured = ArgumentCaptor.forClass(UserPresence.class);
        verify(mapper).upsert(captured.capture(), eq(SESSION_HASH));
        return captured.getValue();
    }

    private static PresenceHeartbeatRequest.Activity game(String name) {
        return new PresenceHeartbeatRequest.Activity(UserActivityType.GAME, name);
    }

    private static AuthenticatedUser user() {
        return new AuthenticatedUser(USER_ID, "Tester", false, SESSION_HASH);
    }

    private static UserPresence presence(UserPresenceStatus status, UserActivityType type, String name,
                                          boolean showActivity, boolean showLastOnline) {
        return new UserPresence(USER_ID, status, NOW.minusSeconds(20), type, name,
                name == null ? null : NOW.minusSeconds(3600), NOW.minusSeconds(20), showActivity, showLastOnline,
                NOW.minusSeconds(20), "上一款游戏", NOW.minusSeconds(4000), 600L);
    }
}
