package com.lycansync.api.presence.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.presence.dto.PresenceHeartbeatRequest;
import com.lycansync.api.presence.mapper.PresenceMapper;
import com.lycansync.api.presence.model.UserPresence;
import com.lycansync.api.presence.model.UserPresenceStatus;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * 用户在线状态心跳与查询。
 *
 * @author Wreckloud
 * @since 2026-09-20
 */
@Service
public class PresenceService {

    private static final Duration OFFLINE_THRESHOLD = Duration.ofSeconds(90);

    private final PresenceMapper mapper;
    private final Clock systemClock;

    public PresenceService(PresenceMapper mapper, Clock systemClock) {
        this.mapper = mapper;
        this.systemClock = systemClock;
    }

    public void heartbeat(AuthenticatedUser user, PresenceHeartbeatRequest request) {
        Instant now = Instant.now(systemClock);
        PresenceHeartbeatRequest.Activity activity = request.activity();
        mapper.upsert(user.id(), request.status(), activity == null ? null : activity.type(),
                activity == null ? null : activity.name().strip(), now);
    }

    public Map<UUID, UserPresence> findPresenceByUsers(Set<UUID> userIds) {
        if (userIds.isEmpty()) {
            return Map.of();
        }
        Instant threshold = Instant.now(systemClock).minus(OFFLINE_THRESHOLD);
        return mapper.findByUsers(userIds.stream().map(UUID::toString).toList()).stream().collect(Collectors.toMap(
                UserPresence::userId,
                presence -> !presence.lastSeenAt().isBefore(threshold) ? presence : offline(presence),
                (first, second) -> first
        ));
    }

    private UserPresence offline(UserPresence presence) {
        return new UserPresence(presence.userId(), UserPresenceStatus.OFFLINE, presence.lastSeenAt(),
                null, null, null, presence.updatedAt());
    }
}
