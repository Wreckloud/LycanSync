package com.lycansync.api.chat.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.dto.ChatMessagePageResponse;
import com.lycansync.api.chat.dto.ChatMessageResponse;
import com.lycansync.api.chat.event.ChatMessageCreatedEvent;
import com.lycansync.api.chat.model.ChatMessageType;
import com.lycansync.api.group.event.GroupChangedEvent;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 群聊等待、提交交错与成员资格撤销的回归验证。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
class ChatMessageWaitServiceTests {

    private final ChatService chat = mock(ChatService.class);
    private final ChatMessageWaitService service = new ChatMessageWaitService(chat);
    private final UUID groupId = UUID.randomUUID();
    private final UUID cursor = UUID.randomUUID();
    private final UUID clientId = UUID.randomUUID();
    private final AuthenticatedUser user = new AuthenticatedUser(UUID.randomUUID(), "测试成员", false);
    private final ChatMessagePageResponse empty = new ChatMessagePageResponse(List.of(), false);
    private final ChatMessagePageResponse added = new ChatMessagePageResponse(List.of(new ChatMessageResponse(
            UUID.randomUUID(), user.id(), user.nickname(), ChatMessageType.TEXT, "新消息", Instant.EPOCH, null)), false);

    @Test
    void idleWaitIsWokenOnlyByItsGroupAndReturnsTheConfirmedIncrement() {
        when(chat.findMessages(groupId, user, null, cursor)).thenReturn(empty, empty, added);
        var result = service.await(groupId, user, cursor, clientId, 1);
        assertThat(result.getResult()).isNull();
        service.messageCreated(new ChatMessageCreatedEvent(UUID.randomUUID()));
        assertThat(result.getResult()).isNull();
        service.messageCreated(new ChatMessageCreatedEvent(groupId));
        assertThat(result.getResult()).isEqualTo(added);
    }

    @Test
    void aMessageCommittedBetweenInitialQueryAndRegistrationIsNotMissed() {
        when(chat.findMessages(groupId, user, null, cursor)).thenReturn(empty, added);
        assertThat(service.await(groupId, user, cursor, clientId, 1).getResult()).isEqualTo(added);
    }

    @Test
    void membershipChangesRecheckPermissionRatherThanReturningCachedPrivateMessages() {
        var denied = new IllegalStateException("测试成员已退群");
        when(chat.findMessages(groupId, user, null, cursor)).thenReturn(empty, empty).thenThrow(denied);
        var result = service.await(groupId, user, cursor, clientId, 1);
        service.groupChanged(new GroupChangedEvent(groupId, false));
        assertThat(result.getResult()).isSameAs(denied);
    }

    @Test
    void oneClientReplacesItsOldWaitAndLateOlderRequestsCannotReplaceTheCurrentWait() {
        when(chat.findMessages(groupId, user, null, cursor)).thenReturn(empty);
        var previous = service.await(groupId, user, cursor, clientId, 1);
        var current = service.await(groupId, user, cursor, clientId, 3);
        assertThat(previous.getResult()).isEqualTo(empty);
        assertThat(current.getResult()).isNull();
        assertThat(service.await(groupId, user, cursor, clientId, 2).getResult()).isEqualTo(empty);
        when(chat.findMessages(groupId, user, null, cursor)).thenReturn(added);
        service.messageCreated(new ChatMessageCreatedEvent(groupId));
        assertThat(current.getResult()).isEqualTo(added);
    }
}
