package com.lycansync.api.rtc.service;

import com.lycansync.api.rtc.dto.RtcRoomSummaryResponse;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.group.exception.GroupException;
import com.lycansync.api.group.service.GroupService;
import com.lycansync.api.rtc.exception.RtcServiceUnavailableException;
import io.livekit.server.RoomServiceClient;
import livekit.LivekitModels.ParticipantInfo;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import retrofit2.Call;
import retrofit2.Response;

import java.io.IOException;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 本地 RTC 房间摘要服务测试。
 *
 * @author Wreckloud
 * @since 2026-09-04
 */
class LocalRtcRoomSummaryServiceTests {

    private static final UUID GROUP_ID = UUID.fromString("01b08c29-d1e5-4bca-987f-64946541e93b");

    private RoomServiceClient roomServiceClient;
    private GroupService groupService;
    private Call<List<ParticipantInfo>> participantCall;
    private LocalRtcRoomSummaryService roomSummaryService;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        roomServiceClient = mock(RoomServiceClient.class);
        groupService = mock(GroupService.class);
        participantCall = mock(Call.class);
        roomSummaryService = new LocalRtcRoomSummaryService(roomServiceClient, groupService);
        when(roomServiceClient.listParticipants("lycan-sync-group-" + GROUP_ID)).thenReturn(participantCall);
    }

    @Test
    void shouldReturnOnlyNamesOrderedByJoinTime() throws IOException {
        List<ParticipantInfo> participants = List.of(
                participant("阿澈", 20), participant(" 小北 ", 10));
        when(participantCall.execute()).thenReturn(Response.success(participants));

        RtcRoomSummaryResponse summary = roomSummaryService.getSummary(GROUP_ID);

        assertThat(summary.participantCount()).isEqualTo(2);
        assertThat(summary.participants()).extracting("displayName").containsExactly("小北", "阿澈");
        assertThat(summary.participants()).extracting("participantIdentity").containsExactly("test-10", "test-20");
    }

    @Test
    @SuppressWarnings("unchecked")
    void shouldTreatDestroyedRoomAsEmpty() throws IOException {
        Response<List<ParticipantInfo>> response = mock(Response.class);
        when(response.code()).thenReturn(404);
        when(participantCall.execute()).thenReturn(response);

        RtcRoomSummaryResponse summary = roomSummaryService.getSummary(GROUP_ID);

        assertThat(summary.participantCount()).isZero();
        assertThat(summary.participants()).isEmpty();
    }

    @Test
    void shouldRejectLiveKitTransportFailure() throws IOException {
        when(participantCall.execute()).thenThrow(new IOException("connection refused"));

        assertThatThrownBy(() -> roomSummaryService.getSummary(GROUP_ID))
                .isInstanceOf(RtcServiceUnavailableException.class)
                .hasMessage("无法连接 LiveKit 房间服务");
    }

    @Test
    void shouldNotQueryLiveKitForMissingGroup() {
        doThrow(new GroupException(HttpStatus.NOT_FOUND, ApiErrorCode.GROUP_NOT_FOUND, "群组不存在"))
                .when(groupService).requireGroup(GROUP_ID);
        assertThatThrownBy(() -> roomSummaryService.getSummary(GROUP_ID))
                .isInstanceOf(GroupException.class);
        verifyNoInteractions(participantCall);
    }

    private ParticipantInfo participant(String name, long joinedAtMs) {
        return ParticipantInfo.newBuilder()
                .setIdentity("test-" + joinedAtMs)
                .setName(name)
                .setJoinedAtMs(joinedAtMs)
                .build();
    }
}
