package com.lycansync.api.rtc.service;

import com.lycansync.api.rtc.mapper.SharedVoiceTimeMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 只结算经过语音服务器确认的区间，失联空档不延续计时。
 *
 * @author Wreckloud
 * @since 2026-11-02
 */
@Service
@RequiredArgsConstructor
public class SharedVoiceTimeService {
    private final SharedVoiceTimeMapper mapper;

    public record ConnectedMember(String participantSid, UUID userId) { }

    public long findOwnSeconds(UUID userId) {
        return mapper.findOwnSeconds(userId);
    }

    @Transactional
    public void joined(String roomSid, String participantSid, UUID userId, Instant at) {
        mapper.join(participantSid, roomSid, userId, at);
    }

    @Transactional
    public void left(String roomSid, String participantSid, Instant at) {
        mapper.leave(participantSid, roomSid, at);
    }

    @Transactional
    public void roomFinished(String roomSid, Instant at) {
        mapper.finishRoom(roomSid, at);
    }

    @Transactional
    public void confirmRoom(String roomSid, List<ConnectedMember> members, Instant at) {
        for (ConnectedMember member : members) {
            mapper.join(member.participantSid(), roomSid, member.userId(), at);
            mapper.confirm(member.participantSid(), at);
        }
        mapper.pauseMissingParticipants(roomSid, members.stream().map(ConnectedMember::participantSid).toList(), at);
    }

    @Transactional
    public void confirmRooms(List<String> roomSids, Instant at) {
        mapper.pauseMissingRooms(roomSids, at);
    }
}
