package com.lycansync.api.auth.model;

import java.time.Instant;
import java.util.UUID;

/**
 * 链接兑换记录；不包含原始链接凭据。
 * @author Wreckloud
 * @since 2026-10-10
 */
public record AccessLink(UUID id, String kind, UUID creatorId, UUID targetId, String note,
                         Instant createdAt, Instant expiresAt, Instant consumedAt, Instant revokedAt,
                         UUID resultUserId, String lastFailure, Instant lastFailureAt) { }
