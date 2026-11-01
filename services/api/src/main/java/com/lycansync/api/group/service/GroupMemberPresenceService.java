package com.lycansync.api.group.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.group.dto.GroupPresenceResponse;
import com.lycansync.api.presence.model.UserPresence;
import com.lycansync.api.presence.model.UserPresenceStatus;
import com.lycansync.api.presence.service.PresenceService;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * 查询群组成员的轻量在线与活动状态。
 *
 * @author Wreckloud
 * @since 2026-09-20
 */
@Service
public class GroupMemberPresenceService {

    private final GroupService groupService;
    private final PresenceService presenceService;

    public GroupMemberPresenceService(GroupService groupService, PresenceService presenceService) {
        this.groupService = groupService;
        this.presenceService = presenceService;
    }

    public List<GroupPresenceResponse> findPresences(UUID groupId, AuthenticatedUser user) {
        groupService.requireMember(groupId, user);
        List<UUID> memberIds = groupService.findMemberIds(groupId);
        Map<UUID, UserPresence> presences = presenceService.findPresenceByUsers(Set.copyOf(memberIds));
        return memberIds.stream().map(userId -> withPresence(userId, presences)).toList();
    }

    private GroupPresenceResponse withPresence(UUID userId, Map<UUID, UserPresence> presences) {
        UserPresence presence = presences.get(userId);
        UserPresenceStatus status = presence == null ? UserPresenceStatus.OFFLINE : presence.status();
        boolean offline = status == UserPresenceStatus.OFFLINE;
        GroupPresenceResponse.RecentGame recentGame = presence != null && presence.showActivity()
                && presence.recentGameName() != null && presence.recentGameEndedAt() != null
                && presence.recentGamePlayedSeconds() != null && presence.recentGamePlayedSeconds() > 0
                ? new GroupPresenceResponse.RecentGame(presence.recentGameName(), presence.recentGameEndedAt(),
                        presence.recentGamePlayedSeconds()) : null;
        // 离线只公开冻结的历史，不返回仍会被隐身心跳刷新的 lastSeenAt。
        return new GroupPresenceResponse(userId, status,
                offline ? null : presence.lastSeenAt(),
                offline || !presence.showActivity() ? null : presence.activityType(),
                offline || !presence.showActivity() ? null : presence.activityName(),
                offline || !presence.showActivity() ? null : presence.activityStartedAt(),
                offline && presence != null && presence.showLastOnline() ? presence.lastOnlineAt() : null, recentGame);
    }
}
