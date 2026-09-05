package com.lycansync.api.rtc.service;

import com.lycansync.api.rtc.dto.RtcRoomSummaryResponse;
import com.lycansync.api.rtc.exception.RtcServiceUnavailableException;
import io.livekit.server.RoomServiceClient;
import livekit.LivekitModels.ParticipantInfo;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import retrofit2.Call;
import retrofit2.Response;

import java.io.IOException;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 本地 RTC 房间摘要服务测试。
 *
 * @author Wreckloud
 * @since 2026-09-04
 */
class LocalRtcRoomSummaryServiceTests {

    private RoomServiceClient roomServiceClient;
    private Call<List<ParticipantInfo>> participantCall;
    private LocalRtcRoomSummaryService roomSummaryService;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        roomServiceClient = mock(RoomServiceClient.class);
        participantCall = mock(Call.class);
        roomSummaryService = new LocalRtcRoomSummaryService(roomServiceClient);
        when(roomServiceClient.listParticipants("lycan-sync-dev-pack")).thenReturn(participantCall);
    }

    @Test
    void shouldReturnOnlyNamesOrderedByJoinTime() throws IOException {
        List<ParticipantInfo> participants = List.of(
                participant("阿澈", 20), participant(" 小北 ", 10));
        when(participantCall.execute()).thenReturn(Response.success(participants));

        RtcRoomSummaryResponse summary = roomSummaryService.getSummary("pack");

        assertThat(summary.participantCount()).isEqualTo(2);
        assertThat(summary.participantNames()).containsExactly("小北", "阿澈");
    }

    @Test
    @SuppressWarnings("unchecked")
    void shouldTreatDestroyedRoomAsEmpty() throws IOException {
        Response<List<ParticipantInfo>> response = mock(Response.class);
        when(response.code()).thenReturn(404);
        when(participantCall.execute()).thenReturn(response);

        RtcRoomSummaryResponse summary = roomSummaryService.getSummary("pack");

        assertThat(summary.participantCount()).isZero();
        assertThat(summary.participantNames()).isEmpty();
    }

    @Test
    void shouldRejectLiveKitTransportFailure() throws IOException {
        when(participantCall.execute()).thenThrow(new IOException("connection refused"));

        assertThatThrownBy(() -> roomSummaryService.getSummary("pack"))
                .isInstanceOf(RtcServiceUnavailableException.class)
                .hasMessage("无法连接 LiveKit 房间服务");
    }

    private ParticipantInfo participant(String name, long joinedAtMs) {
        return ParticipantInfo.newBuilder()
                .setIdentity("test-" + joinedAtMs)
                .setName(name)
                .setJoinedAtMs(joinedAtMs)
                .build();
    }
}
