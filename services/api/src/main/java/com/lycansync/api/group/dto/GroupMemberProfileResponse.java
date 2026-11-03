package com.lycansync.api.group.dto;

import io.swagger.v3.oas.annotations.media.Schema;

import java.util.UUID;
import java.time.Instant;
import org.apache.ibatis.annotations.AutomapConstructor;

/**
 * 成员资料卡按需读取的公开资料。
 *
 * @author Wreckloud
 * @since 2026-10-30
 */
@Schema(description = "同群成员资料卡补充资料，头像和昵称沿用成员列表")
public record GroupMemberProfileResponse(
        UUID userId,
        @Schema(description = "个性签名，未填写时为空串") String signature,
        @Schema(description = "当前账号与此成员的累计共同连麦秒数；查看自己时为空") Long sharedVoiceSeconds,
        @Schema(description = "注销时间，历史资料仍保留") Instant deletedAt
) {
    @AutomapConstructor
    public GroupMemberProfileResponse { }
    public GroupMemberProfileResponse(UUID userId, String signature, Long sharedVoiceSeconds) {
        this(userId, signature, sharedVoiceSeconds, null);
    }
}
