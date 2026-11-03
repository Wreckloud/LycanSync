package com.lycansync.api.rtc.mapper;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 持久化服务端确认过的语音连接区间，不保存音频内容。
 *
 * @author Wreckloud
 * @since 2026-11-02
 */
@Mapper
public interface SharedVoiceTimeMapper {
    long findOwnSeconds(@Param("userId") UUID userId);
    void join(@Param("participantSid") String participantSid, @Param("roomSid") String roomSid,
              @Param("userId") UUID userId, @Param("at") Instant at);
    void confirm(@Param("participantSid") String participantSid, @Param("at") Instant at);
    void leave(@Param("participantSid") String participantSid, @Param("roomSid") String roomSid,
               @Param("at") Instant at);
    void finishRoom(@Param("roomSid") String roomSid, @Param("at") Instant at);
    void pauseMissingParticipants(@Param("roomSid") String roomSid,
                                  @Param("participantSids") List<String> participantSids, @Param("at") Instant at);
    void pauseMissingRooms(@Param("roomSids") List<String> roomSids, @Param("at") Instant at);
}
