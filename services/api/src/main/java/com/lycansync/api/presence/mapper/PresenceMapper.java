package com.lycansync.api.presence.mapper;

import com.lycansync.api.presence.model.PresenceExpiryCandidate;
import com.lycansync.api.presence.model.UserActivityType;
import com.lycansync.api.presence.model.UserPresence;
import com.lycansync.api.presence.model.UserPresenceStatus;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 用户在线状态数据访问。
 *
 * @author Wreckloud
 * @since 2026-09-20
 */
@Mapper
public interface PresenceMapper {

    UserPresence findByUserForUpdate(@Param("userId") UUID userId);

    int upsert(@Param("userId") UUID userId, @Param("sessionHash") String sessionHash,
               @Param("status") UserPresenceStatus status,
               @Param("activityType") UserActivityType activityType,
               @Param("activityName") String activityName, @Param("now") Instant now);

    List<UserPresence> findByUsers(@Param("userIds") List<String> userIds);

    List<PresenceExpiryCandidate> findExpired(@Param("cutoff") Instant cutoff);

    int markOfflineIfUnchanged(@Param("userId") UUID userId, @Param("lastSeenAt") Instant lastSeenAt,
                               @Param("cutoff") Instant cutoff, @Param("now") Instant now);
}
