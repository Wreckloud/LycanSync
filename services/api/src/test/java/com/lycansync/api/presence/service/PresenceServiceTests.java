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
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.context.ApplicationEventPublisher;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class PresenceServiceTests {

    private static final Instant NOW = Instant.parse("2026-09-30T12:00:00Z");
    private static final UUID USER_ID = UUID.fromString("487d94a4-24d4-4529-b284-26e4fba2b32a");
    private static final String SESSION_HASH = "server-only-session-hash";

    private final PresenceMapper mapper = mock(PresenceMapper.class);
    private final ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
    private final PresenceService service = new PresenceService(mapper,
            Clock.fixed(NOW, ZoneOffset.UTC), events);

    @ParameterizedTest
    @EnumSource(UserActivityType.class)
    void shouldNotifyOnlyWhenStatusOrActivityChanges(UserActivityType activityType) {
        AuthenticatedUser user = user();
        UserPresence current = presence(UserPresenceStatus.ONLINE, activityType, "名称");
        when(mapper.findByUserForUpdate(USER_ID)).thenReturn(current);
        when(mapper.upsert(eq(USER_ID), eq(SESSION_HASH), eq(UserPresenceStatus.ONLINE),
                eq(activityType), eq("名称"), eq(NOW))).thenReturn(1);

        service.heartbeat(user, new PresenceHeartbeatRequest(UserPresenceStatus.ONLINE,
                new PresenceHeartbeatRequest.Activity(activityType, "名称")));

        verify(events, never()).publishEvent(any(PresenceChangedEvent.class));
        verify(mapper).upsert(USER_ID, SESSION_HASH, UserPresenceStatus.ONLINE,
                activityType, "名称", NOW);
    }

    @Test
    void shouldPublishMusicChangeUsingTheSamePresenceChain() {
        when(mapper.findByUserForUpdate(USER_ID)).thenReturn(presence(UserPresenceStatus.ONLINE, UserActivityType.GAME, "游戏"));
        when(mapper.upsert(eq(USER_ID), eq(SESSION_HASH), eq(UserPresenceStatus.ONLINE),
                eq(UserActivityType.MUSIC), eq("网易云音乐"), eq(NOW))).thenReturn(1);

        service.heartbeat(user(), new PresenceHeartbeatRequest(UserPresenceStatus.ONLINE,
                new PresenceHeartbeatRequest.Activity(UserActivityType.MUSIC, " 网易云音乐 ")));

        verify(mapper).upsert(USER_ID, SESSION_HASH, UserPresenceStatus.ONLINE, UserActivityType.MUSIC, "网易云音乐", NOW);
        verify(events).publishEvent(any(PresenceChangedEvent.class));
    }

    @Test
    void shouldClearMusicWhenReportingOfflineEvenIfClientStillHasACandidate() {
        when(mapper.findByUserForUpdate(USER_ID)).thenReturn(presence(UserPresenceStatus.ONLINE, UserActivityType.MUSIC, "网易云音乐"));
        when(mapper.upsert(eq(USER_ID), eq(SESSION_HASH), eq(UserPresenceStatus.OFFLINE),
                eq(null), eq(null), eq(NOW))).thenReturn(1);

        service.heartbeat(user(), new PresenceHeartbeatRequest(UserPresenceStatus.OFFLINE,
                new PresenceHeartbeatRequest.Activity(UserActivityType.MUSIC, "网易云音乐")));

        verify(mapper).upsert(USER_ID, SESSION_HASH, UserPresenceStatus.OFFLINE, null, null, NOW);
        verify(events).publishEvent(any(PresenceChangedEvent.class));
    }

    @Test
    void shouldAcceptMusicInTheExistingPayloadAndRetainNameValidation() throws Exception {
        ObjectMapper json = new ObjectMapper();
        PresenceHeartbeatRequest request = json.readValue("""
                {"status":"ONLINE","activity":{"type":"MUSIC","name":"网易云音乐"}}
                """, PresenceHeartbeatRequest.class);
        assertEquals(UserActivityType.MUSIC, request.activity().type());
        try (var factory = Validation.buildDefaultValidatorFactory()) {
            var validator = factory.getValidator();
            assertTrue(validator.validate(request).isEmpty());
            assertFalse(validator.validate(new PresenceHeartbeatRequest(UserPresenceStatus.ONLINE,
                    new PresenceHeartbeatRequest.Activity(UserActivityType.MUSIC, "x".repeat(81)))).isEmpty());
            assertFalse(validator.validate(new PresenceHeartbeatRequest(UserPresenceStatus.ONLINE,
                    new PresenceHeartbeatRequest.Activity(UserActivityType.MUSIC, "歌曲\n"))).isEmpty());
        }
        assertThrows(JsonProcessingException.class, () -> json.readValue("""
                {"status":"ONLINE","activity":{"type":"OTHER","name":"任意程序"}}
                """, PresenceHeartbeatRequest.class));
    }

    @Test
    void shouldNotifyAfterACommittedMeaningfulHeartbeatChange() {
        when(mapper.findByUserForUpdate(USER_ID)).thenReturn(presence(UserPresenceStatus.AWAY, null, null));
        when(mapper.upsert(eq(USER_ID), eq(SESSION_HASH), eq(UserPresenceStatus.ONLINE),
                eq(null), eq(null), eq(NOW))).thenReturn(1);

        service.heartbeat(user(), new PresenceHeartbeatRequest(UserPresenceStatus.ONLINE, null));

        verify(events).publishEvent(any(PresenceChangedEvent.class));
    }

    @Test
    void shouldNotifyWhenGameActivityStartsOrEnds() {
        when(mapper.findByUserForUpdate(USER_ID))
                .thenReturn(presence(UserPresenceStatus.ONLINE, null, null))
                .thenReturn(presence(UserPresenceStatus.ONLINE, UserActivityType.GAME, "Core Keeper"));
        when(mapper.upsert(eq(USER_ID), eq(SESSION_HASH), eq(UserPresenceStatus.ONLINE),
                eq(UserActivityType.GAME), eq("Core Keeper"), eq(NOW))).thenReturn(1);
        when(mapper.upsert(eq(USER_ID), eq(SESSION_HASH), eq(UserPresenceStatus.ONLINE),
                eq(null), eq(null), eq(NOW))).thenReturn(1);

        service.heartbeat(user(), new PresenceHeartbeatRequest(UserPresenceStatus.ONLINE,
                new PresenceHeartbeatRequest.Activity(UserActivityType.GAME, "Core Keeper")));
        service.heartbeat(user(), new PresenceHeartbeatRequest(UserPresenceStatus.ONLINE, null));

        verify(events, org.mockito.Mockito.times(2)).publishEvent(any(PresenceChangedEvent.class));
    }

    @Test
    void shouldIgnoreAHeartbeatWhoseSessionStoppedBeingCurrent() {
        when(mapper.findByUserForUpdate(USER_ID)).thenReturn(presence(UserPresenceStatus.ONLINE, null, null));
        when(mapper.upsert(eq(USER_ID), eq(SESSION_HASH), eq(UserPresenceStatus.OFFLINE),
                eq(null), eq(null), eq(NOW))).thenReturn(0);

        service.heartbeat(user(), new PresenceHeartbeatRequest(UserPresenceStatus.OFFLINE, null));

        verify(events, never()).publishEvent(any(PresenceChangedEvent.class));
    }

    @Test
    void shouldClearActivityAndNotifyOnlyAfterAStaleRowWasUpdated() {
        Instant lastSeenAt = NOW.minusSeconds(66);
        when(mapper.findExpired(NOW.minusSeconds(65))).thenReturn(List.of(new PresenceExpiryCandidate(USER_ID, lastSeenAt)));
        when(mapper.markOfflineIfUnchanged(USER_ID, lastSeenAt, NOW.minusSeconds(65), NOW)).thenReturn(1);

        service.markExpiredOffline();

        verify(mapper).markOfflineIfUnchanged(USER_ID, lastSeenAt, NOW.minusSeconds(65), NOW);
        verify(events).publishEvent(any(PresenceChangedEvent.class));
    }

    @Test
    void shouldNotNotifyWhenAConcurrentHeartbeatWonTheExpiryRace() {
        Instant lastSeenAt = NOW.minusSeconds(66);
        when(mapper.findExpired(NOW.minusSeconds(65))).thenReturn(List.of(new PresenceExpiryCandidate(USER_ID, lastSeenAt)));
        when(mapper.markOfflineIfUnchanged(USER_ID, lastSeenAt, NOW.minusSeconds(65), NOW)).thenReturn(0);

        service.markExpiredOffline();

        verify(events, never()).publishEvent(any(PresenceChangedEvent.class));
    }

    private static AuthenticatedUser user() {
        return new AuthenticatedUser(USER_ID, "Tester", false, SESSION_HASH);
    }

    private static UserPresence presence(UserPresenceStatus status, UserActivityType activityType, String activityName) {
        return new UserPresence(USER_ID, status, NOW.minusSeconds(1), activityType, activityName,
                activityName == null ? null : NOW.minusSeconds(1), NOW.minusSeconds(1));
    }
}
