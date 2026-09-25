package com.lycansync.api.group.service;

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

    public List<GroupPresenceResponse> findPresences(UUID groupId) {
        List<UUID> memberIds = groupService.findMemberIds(groupId);
        Map<UUID, UserPresence> presences = presenceService.findPresenceByUsers(Set.copyOf(memberIds));
        return memberIds.stream().map(userId -> withPresence(userId, presences)).toList();
    }

    private GroupPresenceResponse withPresence(UUID userId, Map<UUID, UserPresence> presences) {
        UserPresence presence = presences.get(userId);
        UserPresenceStatus status = presence == null ? UserPresenceStatus.OFFLINE : presence.status();
        return new GroupPresenceResponse(
                userId, status, presence == null ? null : presence.lastSeenAt(),
                presence == null ? null : presence.activityType(),
                presence == null ? null : presence.activityName(),
                presence == null ? null : presence.activityStartedAt());
    }
}
