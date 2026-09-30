package com.lycansync.api.presence.model;

import java.time.Instant;
import java.util.UUID;

/**
 * 定时离线检查时观察到的待更新状态。
 *
 * @author Wreckloud
 * @since 2026-09-30
 */
public record PresenceExpiryCandidate(UUID userId, Instant lastSeenAt) {
}
