package com.lycansync.api.auth.model;

import java.util.UUID;

/**
 * 安全上下文中的轻量认证身份，不携带头像等大字段。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
public record AuthenticatedUser(UUID id, String nickname, boolean administrator) {
}
