package com.lycansync.api.group.dto;

import io.swagger.v3.oas.annotations.media.Schema;

import java.util.UUID;

/**
 * 成员资料卡按需读取的公开资料。
 *
 * @author Wreckloud
 * @since 2026-10-30
 */
@Schema(description = "同群成员资料卡补充资料，头像和昵称沿用成员列表")
public record GroupMemberProfileResponse(
        UUID userId,
        @Schema(description = "个性签名，未填写时为空串") String signature
) {
}
