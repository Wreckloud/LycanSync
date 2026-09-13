package com.lycansync.api.group.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.common.image.AvatarImageValidator;
import com.lycansync.api.group.dto.CreateGroupRequest;
import com.lycansync.api.group.dto.GroupDetailResponse;
import com.lycansync.api.group.dto.GroupMemberResponse;
import com.lycansync.api.group.dto.GroupSummaryResponse;
import com.lycansync.api.group.exception.GroupException;
import com.lycansync.api.group.mapper.GroupMapper;
import com.lycansync.api.group.model.ChatGroup;
import com.lycansync.api.group.model.GroupMember;
import com.lycansync.api.group.model.GroupView;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 群组创建及全体已注册用户的访问业务。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
@Service
public class GroupService {

    private final GroupMapper mapper;
    private final Clock systemClock;

    public GroupService(GroupMapper mapper, Clock systemClock) {
        this.mapper = mapper;
        this.systemClock = systemClock;
    }

    public List<GroupSummaryResponse> findGroups(AuthenticatedUser user) {
        return mapper.findGroups(user.id()).stream()
                .map(this::toSummary)
                .toList();
    }

    public GroupDetailResponse createGroup(AuthenticatedUser user, CreateGroupRequest request) {
        // 避免保存只有空白或包含控制字符的名称与描述。
        String name = normalizeName(request.name());
        String description = normalizeDescription(request.description());
        String avatar = request.avatar() == null ? "" : request.avatar();
        try {
            if (!avatar.isEmpty()) AvatarImageValidator.validate(avatar);
        } catch (AvatarImageValidator.InvalidAvatarException exception) {
            throw invalid(exception.getMessage());
        }
        Instant now = Instant.now(systemClock);
        // 群主直接记录在群组上；其余已注册用户无需逐条建立成员关系。
        ChatGroup group = new ChatGroup(UUID.randomUUID(), name, description, avatar, user.id(), now, now);
        mapper.insertGroup(group);

        return findGroup(group.id(), user);
    }

    public GroupDetailResponse findGroup(UUID groupId, AuthenticatedUser user) {
        GroupView group = mapper.findGroup(groupId, user.id());
        if (group == null) {
            throw new GroupException(HttpStatus.NOT_FOUND, ApiErrorCode.GROUP_NOT_FOUND, "群组不存在");
        }
        List<GroupMemberResponse> members = mapper.findMembers(groupId).stream()
                .map(this::toMember)
                .toList();
        return new GroupDetailResponse(
                group.id(), group.name(), group.description(), group.avatar(), group.role(),
                group.memberCount(), group.createdAt(), group.updatedAt(), members);
    }

    public void requireGroup(UUID groupId) {
        if (!mapper.groupExists(groupId)) {
            throw new GroupException(HttpStatus.NOT_FOUND, ApiErrorCode.GROUP_NOT_FOUND, "群组不存在");
        }
    }

    private String normalizeName(String value) {
        String name = value.strip();
        if (name.isBlank() || name.codePoints().anyMatch(Character::isISOControl)) {
            throw invalid("群组名称不能为空或包含控制字符");
        }
        return name;
    }

    private String normalizeDescription(String value) {
        if (value == null) {
            return "";
        }
        String description = value.strip();
        if (description.codePoints().anyMatch(Character::isISOControl)) {
            throw invalid("群组描述不能包含控制字符");
        }
        return description;
    }

    private GroupSummaryResponse toSummary(GroupView group) {
        return new GroupSummaryResponse(
                group.id(), group.name(), group.description(), group.avatar(), group.role(),
                group.memberCount(), group.createdAt(), group.updatedAt());
    }

    private GroupMemberResponse toMember(GroupMember member) {
        return new GroupMemberResponse(
                member.userId(), member.nickname(), member.avatar(), member.role(), member.joinedAt());
    }

    private GroupException invalid(String message) {
        return new GroupException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST, message);
    }
}
