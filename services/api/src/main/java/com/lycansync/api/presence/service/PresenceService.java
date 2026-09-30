package com.lycansync.api.presence.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.presence.dto.PresenceHeartbeatRequest;
import com.lycansync.api.presence.event.PresenceChangedEvent;
import com.lycansync.api.presence.mapper.PresenceMapper;
import com.lycansync.api.presence.model.PresenceExpiryCandidate;
import com.lycansync.api.presence.model.UserPresence;
import com.lycansync.api.presence.model.UserPresenceStatus;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;
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

    private static final Duration OFFLINE_THRESHOLD = Duration.ofSeconds(65);

    private final PresenceMapper mapper;
    private final Clock systemClock;
    private final ApplicationEventPublisher events;

    public PresenceService(PresenceMapper mapper, Clock systemClock, ApplicationEventPublisher events) {
        this.mapper = mapper;
        this.systemClock = systemClock;
        this.events = events;
    }

    @Transactional
    public void heartbeat(AuthenticatedUser user, PresenceHeartbeatRequest request) {
        Instant now = Instant.now(systemClock);
        UserPresence previous = mapper.findByUserForUpdate(user.id());
        PresenceHeartbeatRequest.Activity activity = request.status() == UserPresenceStatus.OFFLINE
                ? null : request.activity();
        String activityName = activity == null ? null : activity.name().strip();
        int updated = mapper.upsert(user.id(), user.sessionHash(), request.status(),
                activity == null ? null : activity.type(), activityName, now);
        if (updated > 0 && hasMeaningfulChange(previous, request.status(), activity, activityName)) {
            events.publishEvent(new PresenceChangedEvent());
        }
    }

    @Transactional
    @Scheduled(fixedDelay = 3000)
    public void markExpiredOffline() {
        Instant now = Instant.now(systemClock);
        Instant cutoff = now.minus(OFFLINE_THRESHOLD);
        boolean changed = false;
        for (PresenceExpiryCandidate candidate : mapper.findExpired(cutoff)) {
            changed |= mapper.markOfflineIfUnchanged(candidate.userId(), candidate.lastSeenAt(), cutoff, now) > 0;
        }
        if (changed) {
            events.publishEvent(new PresenceChangedEvent());
        }
    }

    public Map<UUID, UserPresence> findPresenceByUsers(Set<UUID> userIds) {
        if (userIds.isEmpty()) {
            return Map.of();
        }
        return mapper.findByUsers(userIds.stream().map(UUID::toString).toList()).stream().collect(Collectors.toMap(
                UserPresence::userId, presence -> presence, (first, second) -> first));
    }

    private boolean hasMeaningfulChange(UserPresence previous, UserPresenceStatus status,
                                        PresenceHeartbeatRequest.Activity activity, String activityName) {
        if (previous == null) {
            return status != UserPresenceStatus.OFFLINE || activity != null;
        }
        return previous.status() != status
                || previous.activityType() != (activity == null ? null : activity.type())
                || !Objects.equals(previous.activityName(), activityName);
    }
}
