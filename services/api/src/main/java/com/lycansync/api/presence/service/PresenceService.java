package com.lycansync.api.presence.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.presence.dto.PresenceHeartbeatRequest;
import com.lycansync.api.presence.event.PresenceChangedEvent;
import com.lycansync.api.presence.mapper.PresenceMapper;
import com.lycansync.api.presence.model.PresenceExpiryCandidate;
import com.lycansync.api.presence.model.UserPresence;
import com.lycansync.api.presence.model.UserActivityType;
import com.lycansync.api.presence.model.UserPresenceStatus;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashSet;
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
        UserPresence observed = previous;
        if (previous != null && previous.status() != UserPresenceStatus.OFFLINE
                && !previous.lastSeenAt().isAfter(now.minus(OFFLINE_THRESHOLD))) {
            // 服务重启或过期任务迟到时，也不能把断线间隔延续到新的一段游戏。
            observed = nextPresence(user.id(), previous,
                    new PresenceHeartbeatRequest(UserPresenceStatus.OFFLINE, null, null, null), previous.lastSeenAt());
        }
        UserPresence next = nextPresence(user.id(), observed, request, now);
        int updated = mapper.upsert(next, user.sessionHash());
        if (updated > 0 && hasMeaningfulChange(previous, next)) {
            events.publishEvent(new PresenceChangedEvent(Set.of(user.id())));
        }
    }

    @Transactional
    @Scheduled(fixedDelay = 3000)
    public void markExpiredOffline() {
        Instant now = Instant.now(systemClock);
        Instant cutoff = now.minus(OFFLINE_THRESHOLD);
        Set<UUID> changed = new HashSet<>();
        for (PresenceExpiryCandidate candidate : mapper.findExpired(cutoff)) {
            UserPresence previous = mapper.findByUserForUpdate(candidate.userId());
            if (previous == null || previous.status() == UserPresenceStatus.OFFLINE
                    || !previous.lastSeenAt().equals(candidate.lastSeenAt()) || previous.lastSeenAt().isAfter(cutoff)) {
                continue;
            }
            // 断线时只累计到最后有效心跳，不能将离线判定的等待时间计入游戏。
            UserPresence next = nextPresence(candidate.userId(), previous,
                    new PresenceHeartbeatRequest(UserPresenceStatus.OFFLINE, null, null, null), previous.lastSeenAt());
            if (mapper.markOfflineIfUnchanged(next, cutoff, now) > 0) changed.add(candidate.userId());
        }
        if (!changed.isEmpty()) {
            events.publishEvent(new PresenceChangedEvent(Set.copyOf(changed)));
        }
    }

    public Map<UUID, UserPresence> findPresenceByUsers(Set<UUID> userIds) {
        if (userIds.isEmpty()) {
            return Map.of();
        }
        return mapper.findByUsers(userIds.stream().map(UUID::toString).toList()).stream().collect(Collectors.toMap(
                UserPresence::userId, presence -> presence, (first, second) -> first));
    }

    private UserPresence nextPresence(UUID userId, UserPresence previous, PresenceHeartbeatRequest request, Instant now) {
        boolean showActivity = request.showActivity() != null ? request.showActivity()
                : previous == null || previous.showActivity();
        boolean showLastOnline = request.showLastOnline() != null ? request.showLastOnline()
                : previous == null || previous.showLastOnline();
        PresenceHeartbeatRequest.Activity activity = showActivity && request.status() != UserPresenceStatus.OFFLINE
                ? request.activity() : null;
        UserActivityType activityType = activity == null ? null : activity.type();
        String activityName = activity == null ? null : activity.name().strip();
        boolean sameActivity = previous != null && previous.status() != UserPresenceStatus.OFFLINE
                && previous.activityType() == activityType && Objects.equals(previous.activityName(), activityName);
        Instant startedAt = activity == null ? null
                : sameActivity && previous.activityStartedAt() != null ? previous.activityStartedAt() : now;
        Instant lastOnline = !showLastOnline ? null : request.status() != UserPresenceStatus.OFFLINE
                ? now : previous == null ? null : previous.lastOnlineAt();
        String recentGame = showActivity && previous != null ? previous.recentGameName() : null;
        Instant recentEnd = showActivity && previous != null ? previous.recentGameEndedAt() : null;
        Long recentSeconds = showActivity && previous != null ? previous.recentGamePlayedSeconds() : null;
        // 隐身仅结束上一段公开游戏，重复离线心跳不刷新历史；重新公开时另起一段。
        if (showActivity && previous != null && previous.showActivity() && !sameActivity
                && previous.status() != UserPresenceStatus.OFFLINE && previous.activityType() == UserActivityType.GAME
                && previous.activityName() != null && previous.activityStartedAt() != null) {
            long seconds = Duration.between(previous.activityStartedAt(), now).getSeconds();
            if (seconds > 0) {
                recentGame = previous.activityName();
                recentEnd = now;
                recentSeconds = seconds;
            }
        }
        return new UserPresence(userId, request.status(), now, activityType, activityName, startedAt, now,
                showActivity, showLastOnline, lastOnline, recentGame, recentEnd, recentSeconds);
    }

    private boolean hasMeaningfulChange(UserPresence previous, UserPresence next) {
        if (previous == null) {
            return next.status() != UserPresenceStatus.OFFLINE;
        }
        return previous.status() != next.status() || previous.activityType() != next.activityType()
                || !Objects.equals(previous.activityStartedAt(), next.activityStartedAt())
                || !Objects.equals(previous.activityName(), next.activityName())
                || previous.showActivity() != next.showActivity() || previous.showLastOnline() != next.showLastOnline()
                || !Objects.equals(previous.recentGameName(), next.recentGameName())
                || !Objects.equals(previous.recentGameEndedAt(), next.recentGameEndedAt());
    }
}
