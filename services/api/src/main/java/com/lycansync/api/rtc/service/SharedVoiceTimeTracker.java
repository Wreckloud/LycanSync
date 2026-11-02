package com.lycansync.api.rtc.service;

import com.lycansync.api.group.mapper.GroupMapper;
import com.lycansync.api.rtc.exception.RtcServiceUnavailableException;
import io.livekit.server.RoomServiceClient;
import livekit.LivekitModels.ParticipantInfo;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataAccessException;
import org.springframework.context.annotation.Profile;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 低频核对实际语音成员，补漏通知并冻结无法确认的时间。
 *
 * @author Wreckloud
 * @since 2026-11-02
 */
@Service
@Profile({"rtc-local", "rtc-server"})
@RequiredArgsConstructor
@Slf4j
public class SharedVoiceTimeTracker {
    private final RoomServiceClient rooms;
    private final GroupMapper groups;
    private final SharedVoiceTimeService time;
    private final Clock systemClock;
    private boolean unavailable;

    @Scheduled(fixedDelay = 15_000, initialDelay = 5_000, scheduler = "sharedVoiceScheduler")
    public void confirmConnectedMembers() {
        try {
            confirmRooms();
            if (unavailable) log.info("共同连麦时间核对已恢复");
            unavailable = false;
        } catch (IOException | RtcServiceUnavailableException | DataAccessException exception) {
            // 此项失败只冻结统计；同一故障不每轮输出堆栈，也不干扰语音连接。
            if (!unavailable) log.warn("共同连麦时间核对暂停，保留最近确认的时长：{}", exception.getClass().getSimpleName());
            unavailable = true;
        }
    }

    private void confirmRooms() throws IOException {
        Instant observedAt = Instant.now(systemClock);
        var response = rooms.listRooms().execute();
        if (!response.isSuccessful() || response.body() == null) {
            throw new RtcServiceUnavailableException("共同连麦时间的语音房间核对失败");
        }
        Set<String> validNames = groups.findRtcRoomKeys().stream()
                .map(key -> GroupRtcRooms.roomName(UUID.fromString(key))).collect(Collectors.toSet());
        var activeRooms = response.body().stream().filter(room -> validNames.contains(room.getName())).toList();
        time.confirmRooms(activeRooms.stream().map(room -> room.getSid()).toList(), observedAt);
        for (var room : activeRooms) {
            String groupId = groups.lockRtcGroup(UUID.fromString(room.getName().substring(GroupRtcRooms.ROOM_PREFIX.length())));
            if (groupId == null) continue;
            Instant checkedAt = Instant.now(systemClock);
            var participants = rooms.listParticipants(room.getName()).execute();
            if (participants.code() == 404) { time.confirmRoom(room.getSid(), List.of(), checkedAt); continue; }
            if (!participants.isSuccessful() || participants.body() == null) {
                throw new RtcServiceUnavailableException("共同连麦时间的语音成员核对失败");
            }
            var connected = new ArrayList<SharedVoiceTimeService.ConnectedMember>();
            for (ParticipantInfo participant : participants.body()) {
                if (participant.getState() != ParticipantInfo.State.ACTIVE || participant.getSid().isBlank()
                        || !participant.getIdentity().matches("user-[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}")) continue;
                UUID userId = UUID.fromString(participant.getIdentity().substring(5));
                if (groups.memberExists(UUID.fromString(groupId), userId)) {
                    connected.add(new SharedVoiceTimeService.ConnectedMember(participant.getSid(), userId));
                }
            }
            time.confirmRoom(room.getSid(), connected, checkedAt);
        }
    }
}
