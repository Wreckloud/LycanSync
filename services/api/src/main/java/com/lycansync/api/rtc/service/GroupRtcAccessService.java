package com.lycansync.api.rtc.service;

import com.lycansync.api.group.mapper.GroupMapper;
import com.lycansync.api.rtc.exception.RtcServiceUnavailableException;
import io.livekit.server.RoomServiceClient;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.HashSet;
import java.util.UUID;

/**
 * 只断开被撤权成员；解散或清理迁移前的公开房间时才结束整个房间。
 *
 * @author Wreckloud
 * @since 2026-10-12
 */
@Service
public class GroupRtcAccessService {
    private final ObjectProvider<RoomServiceClient> clients;
    private final GroupMapper groups;

    public GroupRtcAccessService(ObjectProvider<RoomServiceClient> clients, GroupMapper groups) {
        this.clients = clients;
        this.groups = groups;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void closeObsoleteRooms() {
        RoomServiceClient client = clients.getIfAvailable();
        if (client == null) return;
        try {
            var response = client.listRooms().execute();
            if (!response.isSuccessful() || response.body() == null) {
                throw new RtcServiceUnavailableException("无法核对旧语音房间");
            }
            // 先枚举，再读当前键，不能用迁移前的公开房间继续传送媒体。
            var validNames = new HashSet<String>();
            groups.findRtcRoomKeys().forEach(key -> validNames.add(GroupRtcRooms.roomName(UUID.fromString(key))));
            for (var room : response.body()) {
                if (room.getName().startsWith(GroupRtcRooms.ROOM_PREFIX) && !validNames.contains(room.getName())) {
                    String key = room.getName().substring(GroupRtcRooms.ROOM_PREFIX.length());
                    closeRoom(UUID.fromString(key));
                }
            }
        } catch (IOException exception) {
            throw new RtcServiceUnavailableException("无法核对旧语音房间", exception);
        }
    }

    public void removeParticipant(UUID roomKey, UUID userId) {
        RoomServiceClient client = clients.getIfAvailable();
        if (client == null) return;
        try {
            var response = client.removeParticipant(GroupRtcRooms.roomName(roomKey), "user-" + userId).execute();
            // 尚未入房或已经离房属于正常状态，不需要断开其他成员。
            if (!response.isSuccessful() && response.code() != 404) {
                throw new RtcServiceUnavailableException("未能断开该成员的语音，请稍后重试");
            }
        } catch (IOException exception) {
            throw new RtcServiceUnavailableException("无法断开该成员的语音，请稍后重试", exception);
        }
    }

    public void closeRoom(UUID roomKey) {
        RoomServiceClient client = clients.getIfAvailable();
        // 未启用 RTC 的后端没有外部房间资源。
        if (client == null) return;
        try {
            var response = client.deleteRoom(GroupRtcRooms.roomName(roomKey)).execute();
            if (!response.isSuccessful() && response.code() != 404) {
                throw new RtcServiceUnavailableException("语音房间未能结束，请稍后重试");
            }
        } catch (IOException exception) {
            throw new RtcServiceUnavailableException("无法结束语音房间，请稍后重试", exception);
        }
    }
}
