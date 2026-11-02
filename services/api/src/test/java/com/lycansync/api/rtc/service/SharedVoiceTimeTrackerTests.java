package com.lycansync.api.rtc.service;

import com.lycansync.api.group.mapper.GroupMapper;
import io.livekit.server.RoomServiceClient;
import livekit.LivekitModels.ParticipantInfo;
import livekit.LivekitModels.Room;
import org.junit.jupiter.api.Test;
import retrofit2.Call;
import retrofit2.Response;

import java.io.IOException;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 核对仅确认真实成员，外部失败不伪造无人或增加时长。
 *
 * @author Wreckloud
 * @since 2026-11-02
 */
class SharedVoiceTimeTrackerTests {
    private final RoomServiceClient rooms = mock(RoomServiceClient.class);
    private final GroupMapper groups = mock(GroupMapper.class);
    private final SharedVoiceTimeService time = mock(SharedVoiceTimeService.class);
    private final Instant now = Instant.parse("2026-11-02T00:00:30Z");
    private final SharedVoiceTimeTracker tracker = new SharedVoiceTimeTracker(rooms, groups, time, Clock.fixed(now, ZoneOffset.UTC));

    @Test
    @SuppressWarnings("unchecked")
    void confirmsOnlyActiveAuthorizedMembersAndKnownGroupRooms() throws IOException {
        UUID key = UUID.randomUUID();
        UUID group = UUID.randomUUID();
        UUID user = UUID.randomUUID();
        String name = GroupRtcRooms.roomName(key);
        Call<List<Room>> roomCall = mock(Call.class);
        Call<List<ParticipantInfo>> memberCall = mock(Call.class);
        when(rooms.listRooms()).thenReturn(roomCall);
        when(roomCall.execute()).thenReturn(Response.success(List.of(Room.newBuilder().setName(name).setSid("RM_test").build())));
        when(groups.findRtcRoomKeys()).thenReturn(List.of(key.toString()));
        when(groups.lockRtcGroup(key)).thenReturn(group.toString());
        when(groups.memberExists(group, user)).thenReturn(true);
        when(rooms.listParticipants(name)).thenReturn(memberCall);
        when(memberCall.execute()).thenReturn(Response.success(List.of(
                ParticipantInfo.newBuilder().setSid("PA_valid").setIdentity("user-" + user).setState(ParticipantInfo.State.ACTIVE).build(),
                ParticipantInfo.newBuilder().setSid("PA_invalid").setIdentity("test-agent").setState(ParticipantInfo.State.ACTIVE).build(),
                ParticipantInfo.newBuilder().setSid("PA_joining").setIdentity("user-" + user).setState(ParticipantInfo.State.JOINING).build())));
        tracker.confirmConnectedMembers();
        verify(time).confirmRooms(List.of("RM_test"), now);
        verify(time).confirmRoom("RM_test", List.of(new SharedVoiceTimeService.ConnectedMember("PA_valid", user)), now);
    }

    @Test
    @SuppressWarnings("unchecked")
    void failedLookupDoesNotFreezeAsEmptyAndNextSuccessfulLookupCanRecover() throws IOException {
        Call<List<Room>> call = mock(Call.class);
        when(rooms.listRooms()).thenReturn(call);
        when(call.execute()).thenThrow(new IOException("test only"))
                .thenReturn(Response.success(List.of()));
        tracker.confirmConnectedMembers();
        verifyNoInteractions(time);
        tracker.confirmConnectedMembers();
        verify(time).confirmRooms(List.of(), now);
    }
}
