package com.lycansync.api.auth.mapper;

import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.model.LocalCredential;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.Instant;
import java.util.UUID;

/**
 * 用户、本地凭据和认证会话数据访问。
 *
 * @author Wreckloud
 * @since 2026-09-06
 */
@Mapper
public interface AuthMapper {

    int markInitialized(@Param("now") Instant now);

    LocalCredential findLocalCredential(@Param("username") String username);

    void insertUser(@Param("user") AuthUser user, @Param("now") Instant now);

    void insertLocalCredential(@Param("userId") UUID userId, @Param("username") String username,
                               @Param("passwordHash") String passwordHash, @Param("now") Instant now);

    int updateProfile(@Param("id") UUID id, @Param("nickname") String nickname, @Param("avatar") String avatar);

    void replaceSession(@Param("hash") String hash, @Param("userId") UUID userId, @Param("expires") Instant expires);

    AuthenticatedUser findSessionUser(@Param("hash") String hash, @Param("now") Instant now);

    AuthUser findUserProfile(@Param("id") UUID id);

    int extendSession(@Param("hash") String hash, @Param("now") Instant now, @Param("expires") Instant expires);

    int deleteSession(@Param("hash") String hash);

    int deleteExpiredSessions(@Param("now") Instant now);

}
