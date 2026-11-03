package com.lycansync.api.group.service;

import com.lycansync.api.group.dto.GroupPresenceChangeResponse;
import com.lycansync.api.group.mapper.GroupMapper;
import com.lycansync.api.group.event.GroupChangedEvent;
import com.lycansync.api.presence.event.PresenceChangedEvent;
import org.junit.jupiter.api.Test;
import org.springframework.web.context.request.async.DeferredResult;

import java.util.UUID;
import java.util.Set;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.mockito.ArgumentMatchers.any;

class GroupPresenceChangeServiceTests {

    @Test
    void firstSubscriptionAndChangedVersionRequireSnapshotRefresh() {
        UUID userId = UUID.randomUUID();
        UUID groupId = UUID.randomUUID();
        UUID clientId = UUID.randomUUID();
        GroupPresenceChangeService service = service(groupId);

        GroupPresenceChangeResponse first = response(service.await(userId, groupId, clientId, 1, null, null));
        assertThat(first.changed()).isTrue();
        assertThat(first.version()).isZero();

        DeferredResult<GroupPresenceChangeResponse> waiting = service.await(userId, groupId, clientId, 2,
                first.serverInstanceId(), first.version());
        assertThat(waiting.getResult()).isNull();
        service.presenceChanged(new PresenceChangedEvent(Set.of(userId)));
        GroupPresenceChangeResponse changed = response(waiting);
        assertThat(changed.serverInstanceId()).isEqualTo(first.serverInstanceId());
        assertThat(changed.version()).isEqualTo(first.version() + 1);
        assertThat(changed.changed()).isTrue();
    }

    @Test
    void newClientStartsWithAChangedResponseAfterServiceRestart() {
        UUID userId = UUID.randomUUID();
        UUID groupId = UUID.randomUUID();
        UUID clientId = UUID.randomUUID();
        GroupPresenceChangeService previous = service(groupId);
        GroupPresenceChangeResponse cursor = response(previous.await(userId, groupId, clientId, 1, null, null));

        GroupPresenceChangeResponse restarted = response(service(groupId)
                .await(userId, groupId, clientId, 1, cursor.serverInstanceId(), cursor.version()));

        assertThat(restarted.serverInstanceId()).isNotEqualTo(cursor.serverInstanceId());
        assertThat(restarted.changed()).isTrue();
    }

    @Test
    void aNewRequestReplacesThePreviousWaitWithoutWaitingForItsTimeout() {
        UUID userId = UUID.randomUUID();
        UUID groupId = UUID.randomUUID();
        UUID clientId = UUID.randomUUID();
        GroupPresenceChangeService service = service(groupId);
        GroupPresenceChangeResponse cursor = response(service.await(userId, groupId, clientId, 1, null, null));

        DeferredResult<GroupPresenceChangeResponse> previous = service.await(userId, groupId, clientId, 2,
                cursor.serverInstanceId(), cursor.version());
        DeferredResult<GroupPresenceChangeResponse> replacement = service.await(userId, groupId, clientId, 3,
                cursor.serverInstanceId(), cursor.version());

        assertThat(response(previous).changed()).isTrue();
        assertThat(replacement.getResult()).isNull();
        service.presenceChanged(new PresenceChangedEvent(Set.of(userId)));
        assertThat(response(replacement).version()).isEqualTo(1);
    }

    private static GroupPresenceChangeResponse response(DeferredResult<GroupPresenceChangeResponse> result) {
        return (GroupPresenceChangeResponse) result.getResult();
    }

    private static GroupPresenceChangeService service(UUID groupId) {
        GroupMapper mapper = mock(GroupMapper.class);
        when(mapper.findGroupIdsByMember(any())).thenReturn(List.of(groupId.toString()));
        return new GroupPresenceChangeService(mapper);
    }

    @Test
    void onlyGroupsContainingChangedUsersAreWokenOnce() {
        UUID groupId = UUID.randomUUID();
        UUID otherGroup = UUID.randomUUID();
        UUID userId = UUID.randomUUID();
        GroupPresenceChangeService service = service(groupId);
        GroupPresenceChangeResponse cursor = response(service.await(userId, groupId, UUID.randomUUID(), 1, null, null));
        GroupPresenceChangeResponse other = response(service.await(userId, otherGroup, UUID.randomUUID(), 1, null, null));
        var waiting = service.await(userId, groupId, UUID.randomUUID(), 2, cursor.serverInstanceId(), cursor.version());
        var unrelated = service.await(userId, otherGroup, UUID.randomUUID(), 2, other.serverInstanceId(), other.version());
        service.presenceChanged(new PresenceChangedEvent(Set.of(userId, UUID.randomUUID())));
        assertThat(response(waiting).version()).isEqualTo(1);
        assertThat(unrelated.getResult()).isNull();
    }

    @Test
    void presenceChangesDoNotInvalidateMemberDetailsButProfileOrMembershipChangesDo() {
        UUID groupId = UUID.randomUUID();
        UUID userId = UUID.randomUUID();
        GroupPresenceChangeService service = service(groupId);
        var cursor = response(service.await(userId, groupId, UUID.randomUUID(), 1, null, null));
        service.presenceChanged(new PresenceChangedEvent(Set.of(userId)));
        var presence = response(service.await(userId, groupId, UUID.randomUUID(), 2, null, null));
        assertThat(presence.detailVersion()).isEqualTo(cursor.detailVersion());
        service.groupChanged(new GroupChangedEvent(groupId, false));
        var details = response(service.await(userId, groupId, UUID.randomUUID(), 3, null, null));
        assertThat(details.detailVersion()).isEqualTo(presence.detailVersion() + 1);
    }
}
