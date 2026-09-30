package com.lycansync.api.auth.model;

import com.fasterxml.jackson.annotation.JsonIgnore;
import org.apache.ibatis.annotations.AutomapConstructor;

import java.util.UUID;

/**
 * 安全上下文中的轻量认证身份，不携带头像等大字段。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
public record AuthenticatedUser(UUID id, String nickname, boolean administrator,
                                @JsonIgnore String sessionHash) {

    @AutomapConstructor
    public AuthenticatedUser(UUID id, String nickname, boolean administrator) {
        this(id, nickname, administrator, null);
    }
}
