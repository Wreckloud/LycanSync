package com.lycansync.api.auth.mapper;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.Instant;
import java.util.UUID;

/**
 * QQ 应用身份与本地账号的一对一关联。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
@Mapper
public interface QqIdentityMapper {
    String findUserId(@Param("appId") String appId, @Param("openId") String openId);
    String findNickname(@Param("userId") UUID userId);
    int insert(@Param("appId") String appId, @Param("openId") String openId,
               @Param("userId") UUID userId, @Param("nickname") String nickname, @Param("at") Instant at);
}
