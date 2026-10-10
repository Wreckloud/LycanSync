package com.lycansync.api.rtc.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.group.dto.GroupSummaryResponse;
import com.lycansync.api.group.service.GroupService;
import com.lycansync.api.rtc.dto.RtcParticipantSummaryResponse;
import com.lycansync.api.rtc.dto.RtcRoomOccupancyResponse;
import com.lycansync.api.rtc.dto.RtcRoomSummaryResponse;
import com.lycansync.api.rtc.exception.RtcServiceUnavailableException;
import io.livekit.server.RoomServiceClient;
import livekit.LivekitModels.ParticipantInfo;
import livekit.LivekitModels.Room;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;
import retrofit2.Response;

import java.io.IOException;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * 查询房间外允许展示的 RTC 成员摘要。
 *
 * @author Wreckloud
 * @since 2026-09-04
 */
@Service
@Profile({"rtc-local", "rtc-server"})
@RequiredArgsConstructor
public class LocalRtcRoomSummaryService {

    private final RoomServiceClient roomServiceClient;
    private final GroupService groupService;

    public RtcRoomSummaryResponse getSummary(UUID groupId) {
        groupService.requireGroup(groupId);
        // TODO: 多客户端高频查询时增加短时有界缓存，但不能把查询失败当作无人。
        try {
            Response<List<ParticipantInfo>> response = roomServiceClient
                    .listParticipants(GroupRtcRooms.roomName(groupId))
                    .execute();

            // LiveKit 在无人房间销毁后返回 404，对业务而言就是当前没有语音成员。
            // TODO: 查询链路引入代理时区分房间不存在与路由错误，避免将所有 404 解释为无人。
            if (response.code() == 404) {
                return new RtcRoomSummaryResponse(0, List.of());
            }
            if (!response.isSuccessful() || response.body() == null) {
                throw new RtcServiceUnavailableException(
                        "LiveKit 房间摘要查询失败，HTTP " + response.code());
            }

            List<RtcParticipantSummaryResponse> participants = response.body().stream()
                    .sorted(Comparator.comparingLong(ParticipantInfo::getJoinedAtMs))
                    .map(participant -> new RtcParticipantSummaryResponse(participant.getIdentity(),
                            participant.getName().isBlank() ? participant.getIdentity() : participant.getName().strip()))
                    .toList();
            return new RtcRoomSummaryResponse(participants.size(), participants);
        } catch (IOException exception) {
            throw new RtcServiceUnavailableException("无法连接 LiveKit 房间服务", exception);
        }
    }

    public List<RtcRoomOccupancyResponse> getOccupancies(AuthenticatedUser user) {
        List<GroupSummaryResponse> groups = groupService.findGroups(user);
        if (groups.isEmpty()) {
            return List.of();
        }
        Map<String, UUID> groupIdsByRoomName = groups.stream()
                .collect(Collectors.toMap(group -> GroupRtcRooms.roomName(group.id()), GroupSummaryResponse::id));
        try {
            Response<List<Room>> response = roomServiceClient.listRooms(List.copyOf(groupIdsByRoomName.keySet())).execute();
            if (!response.isSuccessful() || response.body() == null) {
                throw new RtcServiceUnavailableException(
                        "LiveKit 房间占用查询失败，HTTP " + response.code());
            }
            Map<UUID, Integer> participantCounts = response.body().stream()
                    .filter(room -> groupIdsByRoomName.containsKey(room.getName()))
                    .collect(Collectors.toMap(room -> groupIdsByRoomName.get(room.getName()),
                            Room::getNumParticipants, Math::max));
            return groups.stream()
                    .map(group -> new RtcRoomOccupancyResponse(
                            group.id(), participantCounts.getOrDefault(group.id(), 0)))
                    .toList();
        } catch (IOException exception) {
            throw new RtcServiceUnavailableException("无法连接 LiveKit 房间服务", exception);
        }
    }
}
