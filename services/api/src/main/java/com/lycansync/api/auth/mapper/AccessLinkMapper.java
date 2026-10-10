package com.lycansync.api.auth.mapper;

import com.lycansync.api.auth.model.AccessLink;
import com.lycansync.api.auth.model.AuthUser;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 激活、邀请和恢复链接的持久化及行锁。
 * @author Wreckloud
 * @since 2026-10-10
 */
@Mapper
public interface AccessLinkMapper {
    Boolean lockInitialization();
    long nextGuestNumber();
    void insert(@Param("link") AccessLink link, @Param("hash") String hash);
    AccessLink lockByHash(@Param("hash") String hash);
    AccessLink lockById(@Param("id") UUID id);
    int consume(@Param("id") UUID id, @Param("userId") UUID userId, @Param("keyHash") String keyHash, @Param("now") Instant now);
    String redemptionKeyHash(@Param("id") UUID id);
    int revoke(@Param("id") UUID id, @Param("now") Instant now);
    int revokeActivation(@Param("now") Instant now);
    int revokeRecovery(@Param("userId") UUID userId, @Param("now") Instant now);
    int recordFailure(@Param("hash") String hash, @Param("failure") String failure, @Param("now") Instant now);
    List<AccessLink> list(@Param("offset") int offset);
    List<AuthUser> members(@Param("offset") int offset);
}
