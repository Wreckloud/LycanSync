package com.lycansync.api.group.service;

import com.lycansync.api.group.dto.GroupPresenceChangeResponse;
import com.lycansync.api.presence.event.PresenceChangedEvent;
import org.junit.jupiter.api.Test;
import org.springframework.web.context.request.async.DeferredResult;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class GroupPresenceChangeServiceTests {

    @Test
    void firstSubscriptionAndChangedVersionRequireSnapshotRefresh() {
        GroupPresenceChangeService service = new GroupPresenceChangeService();
        UUID userId = UUID.randomUUID();
        UUID groupId = UUID.randomUUID();
        UUID clientId = UUID.randomUUID();

        GroupPresenceChangeResponse first = response(service.await(userId, groupId, clientId, 1, null, null));
        assertThat(first.changed()).isTrue();
        assertThat(first.version()).isZero();

        DeferredResult<GroupPresenceChangeResponse> waiting = service.await(userId, groupId, clientId, 2,
                first.serverInstanceId(), first.version());
        assertThat(waiting.getResult()).isNull();
        service.presenceChanged(new PresenceChangedEvent());
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
        GroupPresenceChangeService previous = new GroupPresenceChangeService();
        GroupPresenceChangeResponse cursor = response(previous.await(userId, groupId, clientId, 1, null, null));

        GroupPresenceChangeResponse restarted = response(new GroupPresenceChangeService()
                .await(userId, groupId, clientId, 1, cursor.serverInstanceId(), cursor.version()));

        assertThat(restarted.serverInstanceId()).isNotEqualTo(cursor.serverInstanceId());
        assertThat(restarted.changed()).isTrue();
    }

    @Test
    void aNewRequestReplacesThePreviousWaitWithoutWaitingForItsTimeout() {
        GroupPresenceChangeService service = new GroupPresenceChangeService();
        UUID userId = UUID.randomUUID();
        UUID groupId = UUID.randomUUID();
        UUID clientId = UUID.randomUUID();
        GroupPresenceChangeResponse cursor = response(service.await(userId, groupId, clientId, 1, null, null));

        DeferredResult<GroupPresenceChangeResponse> previous = service.await(userId, groupId, clientId, 2,
                cursor.serverInstanceId(), cursor.version());
        DeferredResult<GroupPresenceChangeResponse> replacement = service.await(userId, groupId, clientId, 3,
                cursor.serverInstanceId(), cursor.version());

        assertThat(response(previous).changed()).isTrue();
        assertThat(replacement.getResult()).isNull();
        service.presenceChanged(new PresenceChangedEvent());
        assertThat(response(replacement).version()).isEqualTo(1);
    }

    private static GroupPresenceChangeResponse response(DeferredResult<GroupPresenceChangeResponse> result) {
        return (GroupPresenceChangeResponse) result.getResult();
    }
}
