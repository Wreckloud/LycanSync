package com.lycansync.api.group.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import java.util.UUID;

/**
 * 群主添加服务器成员时需要的公开资料，不包含账号恢复或登录信息。
 * @author Wreckloud
 * @since 2026-10-12
 */
@Schema(description = "服务器成员及当前群成员资格")
public record GroupCandidateResponse(UUID userId, String nickname, String avatar, boolean joined) { }
