package com.lycansync.api.auth.mapper;

import com.lycansync.api.auth.model.LocalCredential;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.Instant;
import java.util.UUID;

/**
 * 测试账号密码凭据的数据访问，不进入后端部署包。
 *
 * @author Wreckloud
 * @since 2026-10-14
 */
@Mapper
public interface LocalCredentialMapper {

    LocalCredential findByUsername(@Param("username") String username);

    void insert(@Param("userId") UUID userId, @Param("username") String username,
                @Param("passwordHash") String passwordHash, @Param("now") Instant now);
}
