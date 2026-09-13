package com.lycansync.api.group.model;

import io.swagger.v3.oas.annotations.media.Schema;

/**
 * 群组内的成员角色，与系统管理员身份相互独立。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
@Schema(description = "群组角色")
public enum GroupRole {

    OWNER,
    MEMBER
}
