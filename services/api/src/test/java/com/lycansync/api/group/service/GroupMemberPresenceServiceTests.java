package com.lycansync.api.group.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.presence.model.UserActivityType;
import com.lycansync.api.presence.model.UserPresence;
import com.lycansync.api.presence.model.UserPresenceStatus;
import com.lycansync.api.presence.service.PresenceService;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 核对群成员公开状态的离线隐私边界。
 *
 * @author Wreckloud
 * @since 2026-10-30
 */
class GroupMemberPresenceServiceTests {

    private final GroupService groups = mock(GroupService.class);
    private final PresenceService presences = mock(PresenceService.class);
    private final GroupMemberPresenceService service = new GroupMemberPresenceService(groups, presences);

    @Test
    void shouldHideOfflineActivityAndHeartbeatTimesForEveryMember() {
        UUID groupId = UUID.randomUUID();
        UUID userId = UUID.randomUUID();
        Instant now = Instant.parse("2026-10-30T04:00:00Z");
        AuthenticatedUser requester = new AuthenticatedUser(UUID.randomUUID(), "查看者", false, "session");
        when(groups.findMemberIds(groupId)).thenReturn(List.of(userId));
        when(presences.findPresenceByUsers(Set.of(userId))).thenReturn(Map.of(userId,
                new UserPresence(userId, UserPresenceStatus.OFFLINE, now, UserActivityType.GAME, "旧游戏", now, now, true, true, null, null, null, null)));

        var result = service.findPresences(groupId, requester).get(0);

        verify(groups).requireMember(groupId, requester);
        assertThat(result.status()).isEqualTo(UserPresenceStatus.OFFLINE);
        assertThat(result.lastSeenAt()).isNull();
        assertThat(result.activityType()).isNull();
        assertThat(result.activityName()).isNull();
        assertThat(result.activityStartedAt()).isNull();
    }

    @Test
    void shouldKeepOnlineAndAwayActivityVisible() {
        UUID groupId = UUID.randomUUID();
        UUID userId = UUID.randomUUID();
        Instant now = Instant.parse("2026-10-30T04:00:00Z");
        AuthenticatedUser requester = new AuthenticatedUser(UUID.randomUUID(), "查看者", false, "session");
        when(groups.findMemberIds(groupId)).thenReturn(List.of(userId));
        for (UserPresenceStatus status : List.of(UserPresenceStatus.ONLINE, UserPresenceStatus.AWAY)) {
            when(presences.findPresenceByUsers(Set.of(userId))).thenReturn(Map.of(userId,
                    new UserPresence(userId, status, now, UserActivityType.MUSIC, "歌曲", now, now, true, true, null, null, null, null)));
            var result = service.findPresences(groupId, requester).get(0);
            assertThat(result.status()).isEqualTo(status);
            assertThat(result.lastSeenAt()).isEqualTo(now);
            assertThat(result.activityName()).isEqualTo("歌曲");
            assertThat(result.activityStartedAt()).isEqualTo(now);
        }
    }

    @Test
    void shouldExposeFrozenOfflineHistoryButNeverThePrivateHeartbeatTime() {
        UUID groupId = UUID.randomUUID();
        UUID userId = UUID.randomUUID();
        Instant publicAt = Instant.parse("2026-11-01T07:00:00Z");
        AuthenticatedUser requester = new AuthenticatedUser(UUID.randomUUID(), "查看者", false, "session");
        when(groups.findMemberIds(groupId)).thenReturn(List.of(userId));
        when(presences.findPresenceByUsers(Set.of(userId))).thenReturn(Map.of(userId,
                new UserPresence(userId, UserPresenceStatus.OFFLINE, publicAt.plusSeconds(600), null, null, null,
                        publicAt.plusSeconds(600), true, true, publicAt, "游戏", publicAt, 3600L)));
        var response = service.findPresences(groupId, requester).get(0);
        assertThat(response.lastSeenAt()).isNull();
        assertThat(response.lastOnlineAt()).isEqualTo(publicAt);
        assertThat(response.recentGame().name()).isEqualTo("游戏");
        assertThat(response.recentGame().playedSeconds()).isEqualTo(3600L);
    }

    @Test
    void shouldEnforceVisibilityIndependentlyEvenWhenStoredFieldsAreStale() {
        UUID groupId = UUID.randomUUID();
        UUID userId = UUID.randomUUID();
        Instant now = Instant.parse("2026-11-01T08:00:00Z");
        AuthenticatedUser requester = new AuthenticatedUser(UUID.randomUUID(), "查看者", false, "session");
        when(groups.findMemberIds(groupId)).thenReturn(List.of(userId));
        when(presences.findPresenceByUsers(Set.of(userId))).thenReturn(Map.of(userId,
                new UserPresence(userId, UserPresenceStatus.OFFLINE, now, null, null, null,
                        now, false, true, now.minusSeconds(600), "不应返回的游戏", now, 3600L)));
        var hiddenGame = service.findPresences(groupId, requester).get(0);
        assertThat(hiddenGame.lastOnlineAt()).isEqualTo(now.minusSeconds(600));
        assertThat(hiddenGame.recentGame()).isNull();
        when(presences.findPresenceByUsers(Set.of(userId))).thenReturn(Map.of(userId,
                new UserPresence(userId, UserPresenceStatus.ONLINE, now, UserActivityType.GAME, "当前游戏", now,
                        now, true, false, now.minusSeconds(600), "最近游戏", now.minusSeconds(600), 3600L)));
        var hiddenOnlineTime = service.findPresences(groupId, requester).get(0);
        assertThat(hiddenOnlineTime.lastOnlineAt()).isNull();
        assertThat(hiddenOnlineTime.activityName()).isEqualTo("当前游戏");
        assertThat(hiddenOnlineTime.recentGame().name()).isEqualTo("最近游戏");
    }

}
