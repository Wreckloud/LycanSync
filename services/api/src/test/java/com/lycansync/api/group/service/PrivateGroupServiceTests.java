package com.lycansync.api.group.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.group.exception.GroupException;
import com.lycansync.api.group.mapper.GroupMapper;
import com.lycansync.api.rtc.service.GroupRtcAccessService;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationEventPublisher;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 私密群成员资格、群主权限与定向断开边界。
 * @author Wreckloud
 * @since 2026-10-12
 */
class PrivateGroupServiceTests {
    private final UUID groupId = UUID.randomUUID();
    private final UUID roomKey = UUID.randomUUID();
    private final AuthenticatedUser owner = new AuthenticatedUser(UUID.randomUUID(), "群主", false);
    private final AuthenticatedUser member = new AuthenticatedUser(UUID.randomUUID(), "成员", true);
    private final GroupMapper mapper = mock(GroupMapper.class);
    private final GroupRtcAccessService rtc = mock(GroupRtcAccessService.class);
    private final GroupService service = new GroupService(mapper,
            Clock.fixed(Instant.parse("2026-10-12T12:00:00Z"), ZoneOffset.UTC), mock(ApplicationEventPublisher.class), rtc);

    @BeforeEach
    void setUp() {
        when(mapper.lockOwner(groupId)).thenReturn(owner.id().toString());
        when(mapper.memberExists(groupId, owner.id())).thenReturn(true);
        when(mapper.findRtcRoomKey(groupId)).thenReturn(roomKey.toString());
    }

    @Test
    void serverAdministratorDoesNotInheritGroupOwnership() {
        when(mapper.memberExists(groupId, member.id())).thenReturn(true);
        assertThatThrownBy(() -> service.inviteCode(groupId, member, true))
                .isInstanceOf(GroupException.class).hasMessage("只有群主可以执行此操作");
        verify(mapper, never()).updateInviteCode(any(), any());
    }

    @Test
    void uninvitedAccountCannotUsePrivateGroup() {
        assertThatThrownBy(() -> service.requireMember(groupId, member))
                .isInstanceOf(GroupException.class).hasMessage("群组不存在或你已不在此群");
    }

    @Test
    void ownerCannotLeaveWithoutTransferring() {
        assertThatThrownBy(() -> service.removeMember(groupId, owner, owner.id()))
                .isInstanceOf(GroupException.class).hasMessage("群主需要先转让群主，或解散群聊");
        verifyNoInteractions(rtc);
    }

    @Test
    void removingMemberOnlyDisconnectsTargetAndRefreshesInviteCode() {
        when(mapper.memberExists(groupId, member.id())).thenReturn(true);
        service.removeMember(groupId, owner, member.id());
        var order = inOrder(rtc, mapper);
        order.verify(rtc).removeParticipant(roomKey, member.id());
        order.verify(mapper).removeMember(groupId, member.id());
        verify(mapper).updateInviteCode(eq(groupId), any(String.class));
        verify(rtc, never()).closeRoom(any());
    }

    @Test
    void roomFailureDoesNotRemoveMembership() {
        when(mapper.memberExists(groupId, member.id())).thenReturn(true);
        doThrow(new IllegalStateException("房间暂时不可用")).when(rtc).removeParticipant(roomKey, member.id());
        assertThatThrownBy(() -> service.removeMember(groupId, owner, member.id())).hasMessage("房间暂时不可用");
        verify(mapper, never()).removeMember(any(), any());
    }

    @Test
    void transferOnlyTargetsExistingGroupMemberAndMovesAuthority() {
        assertThatThrownBy(() -> service.transferOwner(groupId, owner, member.id()))
                .isInstanceOf(GroupException.class).hasMessage("请选择群内的其他成员");
        verify(mapper, never()).transferOwner(any(), any(), any());
    }

    @Test
    void refreshRacingWithJoinRejectsPreviousCodeAfterLock() {
        String code = "abcdefghijk12345";
        when(mapper.findGroupByCode(code)).thenReturn(groupId.toString());
        when(mapper.findInviteCode(groupId)).thenReturn("new-code-value16");
        assertThatThrownBy(() -> service.joinByCode(member, code))
                .isInstanceOf(GroupException.class).hasMessage("邀请码无效或已更换，请向群主索取最新邀请码");
        verify(mapper, never()).addMember(any(), any(), any());
    }

    @Test
    void cannotAddAnAccountOutsideCurrentServer() {
        assertThatThrownBy(() -> service.addMember(groupId, owner, member.id()))
                .isInstanceOf(GroupException.class).hasMessage("只能添加当前服务器已有的成员");
    }
}
