package com.lycansync.api.group.mapper;

import com.lycansync.api.group.dto.GroupCandidateResponse;
import com.lycansync.api.group.model.ChatGroup;
import com.lycansync.api.group.model.GroupMember;
import com.lycansync.api.group.model.GroupView;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 群组资料、成员资格及群主操作的数据访问。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
@Mapper
public interface GroupMapper {

    int insertGroup(@Param("group") ChatGroup group);

    List<GroupView> findGroups(@Param("userId") UUID userId);

    GroupView findGroup(@Param("groupId") UUID groupId, @Param("userId") UUID userId);

    List<GroupMember> findMembers(@Param("groupId") UUID groupId);

    List<String> findMemberIds(@Param("groupId") UUID groupId);

    String lockOwner(@Param("groupId") UUID groupId);
    boolean memberExists(@Param("groupId") UUID groupId, @Param("userId") UUID userId);
    int addMember(@Param("groupId") UUID groupId, @Param("userId") UUID userId, @Param("now") Instant now);
    int removeMember(@Param("groupId") UUID groupId, @Param("userId") UUID userId);
    List<GroupCandidateResponse> findCandidates(@Param("groupId") UUID groupId,
            @Param("search") String search, @Param("offset") int offset);
    int updateGroup(@Param("groupId") UUID groupId, @Param("name") String name,
            @Param("description") String description, @Param("avatar") String avatar, @Param("now") Instant now);
    int transferOwner(@Param("groupId") UUID groupId, @Param("userId") UUID userId, @Param("now") Instant now);
    int touchGroup(@Param("groupId") UUID groupId, @Param("now") Instant now);
    String findInviteCode(@Param("groupId") UUID groupId);
    int updateInviteCode(@Param("groupId") UUID groupId, @Param("code") String code);
    String findGroupByCode(@Param("code") String code);
    String findRtcRoomKey(@Param("groupId") UUID groupId);
    List<String> findRtcRoomKeys();
    String lockRtcGroup(@Param("roomKey") UUID roomKey);
    int deleteGroup(@Param("groupId") UUID groupId);
}
