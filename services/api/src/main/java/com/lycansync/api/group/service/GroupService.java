package com.lycansync.api.group.service;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.service.AuthSecrets;
import com.lycansync.api.common.error.ApiErrorCode;
import com.lycansync.api.common.image.AvatarImageProcessor;
import com.lycansync.api.group.dto.CreateGroupRequest;
import com.lycansync.api.group.dto.GroupCandidateResponse;
import com.lycansync.api.group.dto.GroupDetailResponse;
import com.lycansync.api.group.dto.GroupMemberResponse;
import com.lycansync.api.group.dto.GroupSummaryResponse;
import com.lycansync.api.group.event.GroupChangedEvent;
import com.lycansync.api.group.exception.GroupException;
import com.lycansync.api.group.mapper.GroupMapper;
import com.lycansync.api.group.model.ChatGroup;
import com.lycansync.api.group.model.GroupMember;
import com.lycansync.api.group.model.GroupRole;
import com.lycansync.api.group.model.GroupView;
import com.lycansync.api.rtc.service.GroupRtcAccessService;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * 私密群组、成员资格及群主管理业务。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
@Service
public class GroupService {

    private final GroupMapper mapper;
    private final Clock systemClock;
    private final ApplicationEventPublisher events;
    private final GroupRtcAccessService rtcAccess;
    private final ConcurrentMap<UUID, Instant> joinAttempts = new ConcurrentHashMap<>();

    public GroupService(GroupMapper mapper, Clock systemClock, ApplicationEventPublisher events,
                        GroupRtcAccessService rtcAccess) {
        this.mapper = mapper;
        this.systemClock = systemClock;
        this.events = events;
        this.rtcAccess = rtcAccess;
    }

    public List<GroupSummaryResponse> findGroups(AuthenticatedUser user) {
        return mapper.findGroups(user.id()).stream()
                .map(this::toSummary)
                .toList();
    }

    @Transactional
    public GroupDetailResponse createGroup(AuthenticatedUser user, CreateGroupRequest request) {
        // 避免保存只有空白或包含控制字符的名称与描述。
        String name = normalizeName(request.name());
        String description = normalizeDescription(request.description());
        String avatar = request.avatar() == null ? "" : request.avatar();
        try {
            if (!avatar.isEmpty()) avatar = AvatarImageProcessor.normalize(avatar);
        } catch (AvatarImageProcessor.InvalidAvatarException exception) {
            throw invalid(exception.getMessage());
        }
        Instant now = Instant.now(systemClock);
        // 群主角色只有群组上的 owner_user_id 一个来源，成员表只记录入群资格。
        ChatGroup group = new ChatGroup(UUID.randomUUID(), name, description, avatar, user.id(), now, now);
        mapper.insertGroup(group);
        mapper.addMember(group.id(), user.id(), now);
        changed(group.id(), false);

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

    public void requireMember(UUID groupId, AuthenticatedUser user) {
        if (!mapper.memberExists(groupId, user.id())) {
            throw new GroupException(HttpStatus.NOT_FOUND, ApiErrorCode.GROUP_NOT_FOUND, "群组不存在或你已不在此群");
        }
    }

    public List<UUID> findMemberIds(UUID groupId) {
        return mapper.findMemberIds(groupId).stream().map(UUID::fromString).toList();
    }

    public UUID lockMemberRoomKey(UUID groupId, AuthenticatedUser user) {
        if (mapper.lockOwner(groupId) == null) throw missing();
        requireMember(groupId, user);
        return roomKey(groupId);
    }

    public UUID memberRoomKey(UUID groupId, AuthenticatedUser user) {
        requireMember(groupId, user);
        return roomKey(groupId);
    }

    public List<GroupCandidateResponse> findCandidates(UUID groupId, AuthenticatedUser user, String search, int offset) {
        if (offset < 0 || search.length() > 32) throw invalid("搜索条件或分页位置无效");
        GroupView group = mapper.findGroup(groupId, user.id());
        if (group == null) throw missing();
        if (group.role() != GroupRole.OWNER) throw denied();
        return mapper.findCandidates(groupId, search.strip(), offset);
    }

    @Transactional
    public GroupDetailResponse updateGroup(UUID groupId, AuthenticatedUser user, CreateGroupRequest request) {
        requireOwner(groupId, user);
        String name = normalizeName(request.name());
        String description = normalizeDescription(request.description());
        String avatar = request.avatar() == null ? "" : request.avatar();
        try {
            if (!avatar.isEmpty()) avatar = AvatarImageProcessor.normalize(avatar);
        } catch (AvatarImageProcessor.InvalidAvatarException exception) {
            throw invalid(exception.getMessage());
        }
        mapper.updateGroup(groupId, name, description, avatar, Instant.now(systemClock));
        changed(groupId, false);
        return findGroup(groupId, user);
    }

    @Transactional
    public GroupDetailResponse addMember(UUID groupId, AuthenticatedUser user, UUID memberId) {
        requireOwner(groupId, user);
        addMember(groupId, memberId);
        return findGroup(groupId, user);
    }

    private void addMember(UUID groupId, UUID memberId) {
        if (mapper.memberExists(groupId, memberId)) return;
        Instant now = Instant.now(systemClock);
        if (mapper.addMember(groupId, memberId, now) != 1) {
            throw invalid("只能添加当前服务器已有的成员");
        }
        mapper.touchGroup(groupId, now);
        changed(groupId, false);
    }

    @Transactional
    public void removeMember(UUID groupId, AuthenticatedUser user, UUID memberId) {
        String owner = mapper.lockOwner(groupId);
        if (owner == null) throw missing();
        requireMember(groupId, user);
        if (!user.id().equals(memberId) && !owner.equals(user.id().toString())) throw denied();
        if (owner.equals(memberId.toString())) throw invalid("群主需要先转让群主，或解散群聊");
        if (!mapper.memberExists(groupId, memberId)) throw invalid("此成员已不在群聊中");
        // 持有群行锁时只断开目标成员；连接入口也取这把锁，撤权进行中不能放行重连。
        rtcAccess.removeParticipant(roomKey(groupId), memberId);
        mapper.removeMember(groupId, memberId);
        if (!user.id().equals(memberId)) mapper.updateInviteCode(groupId, newCode());
        mapper.touchGroup(groupId, Instant.now(systemClock));
        changed(groupId, false);
    }

    @Transactional
    public GroupDetailResponse transferOwner(UUID groupId, AuthenticatedUser user, UUID memberId) {
        requireOwner(groupId, user);
        if (user.id().equals(memberId) || !mapper.memberExists(groupId, memberId)) {
            throw invalid("请选择群内的其他成员");
        }
        mapper.transferOwner(groupId, memberId, Instant.now(systemClock));
        mapper.updateInviteCode(groupId, newCode());
        changed(groupId, false);
        return findGroup(groupId, user);
    }

    @Transactional
    public String inviteCode(UUID groupId, AuthenticatedUser user, boolean refresh) {
        requireOwner(groupId, user);
        String code = mapper.findInviteCode(groupId);
        if (refresh || code == null) {
            code = newCode();
            mapper.updateInviteCode(groupId, code);
        }
        return code;
    }

    @Transactional
    public GroupDetailResponse joinByCode(AuthenticatedUser user, String code) {
        Instant now = Instant.now(systemClock);
        joinAttempts.entrySet().removeIf(entry -> entry.getValue().isBefore(now.minusSeconds(60)));
        joinAttempts.compute(user.id(), (id, previous) -> {
            if (previous != null && previous.isAfter(now.minusSeconds(1))) {
                throw new GroupException(HttpStatus.TOO_MANY_REQUESTS, ApiErrorCode.AUTH_RATE_LIMITED, "操作太快，请稍后再试");
            }
            return now;
        });
        String foundGroupId = mapper.findGroupByCode(code.strip());
        if (foundGroupId == null) throw invalid("邀请码无效或已更换，请向群主索取最新邀请码");
        UUID groupId = UUID.fromString(foundGroupId);
        if (mapper.lockOwner(groupId) == null
                || !code.strip().equals(mapper.findInviteCode(groupId))) {
            throw invalid("邀请码无效或已更换，请向群主索取最新邀请码");
        }
        addMember(groupId, user.id());
        return findGroup(groupId, user);
    }

    @Transactional
    public void dissolve(UUID groupId, AuthenticatedUser user) {
        requireOwner(groupId, user);
        rtcAccess.closeRoom(roomKey(groupId));
        mapper.deleteGroup(groupId);
        changed(groupId, true);
    }

    private void requireOwner(UUID groupId, AuthenticatedUser user) {
        String owner = mapper.lockOwner(groupId);
        if (owner == null) throw missing();
        requireMember(groupId, user);
        if (!owner.equals(user.id().toString())) throw denied();
    }

    private UUID roomKey(UUID groupId) {
        String key = mapper.findRtcRoomKey(groupId);
        if (key == null) throw missing();
        return UUID.fromString(key);
    }

    private String newCode() {
        return AuthSecrets.generate().substring(0, 16);
    }

    private void changed(UUID groupId, boolean deleted) {
        events.publishEvent(new GroupChangedEvent(groupId, deleted));
    }

    private GroupException missing() {
        return new GroupException(HttpStatus.NOT_FOUND, ApiErrorCode.GROUP_NOT_FOUND, "群组不存在或你已不在此群");
    }

    private GroupException denied() {
        return new GroupException(HttpStatus.FORBIDDEN, ApiErrorCode.ACCESS_DENIED, "只有群主可以执行此操作");
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
                member.userId(), member.nickname(), member.avatar(), member.role(),
                member.joinedAt());
    }

    private GroupException invalid(String message) {
        return new GroupException(HttpStatus.BAD_REQUEST, ApiErrorCode.INVALID_REQUEST, message);
    }
}
