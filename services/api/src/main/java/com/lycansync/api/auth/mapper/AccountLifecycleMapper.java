package com.lycansync.api.auth.mapper;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 服主恢复凭据、权限交接和账号停用的数据访问。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
@Mapper
public interface AccountLifecycleMapper {
    record State(boolean initialized, UUID ownerId, UUID recoveryUserId, String recoveryHash,
                 UUID transferTargetId, Instant transferExpiresAt) { }
    record Candidate(UUID id, String nickname) { }
    State state();
    void saveRecovery(@Param("userId") UUID userId, @Param("hash") String hash);
    void offerTransfer(@Param("targetId") UUID targetId, @Param("expires") Instant expires);
    void clearTransfer();
    int demoteOwner(@Param("userId") UUID userId);
    int promoteOwner(@Param("userId") UUID userId);
    List<Candidate> candidates();
    int closeAccount(@Param("userId") UUID userId, @Param("now") Instant now);
    void revokeSessions(@Param("userId") UUID userId);
    void revokeLinks(@Param("userId") UUID userId, @Param("now") Instant now);
    void revokePendingLinks(@Param("now") Instant now);
}
