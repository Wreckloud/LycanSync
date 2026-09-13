package com.lycansync.api.group.mapper;

import com.lycansync.api.group.model.ChatGroup;
import com.lycansync.api.group.model.GroupMember;
import com.lycansync.api.group.model.GroupView;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;
import java.util.UUID;

/**
 * 群组及全体注册用户的资料查询。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
@Mapper
public interface GroupMapper {

    int insertGroup(@Param("group") ChatGroup group);

    boolean groupExists(@Param("groupId") UUID groupId);

    List<GroupView> findGroups(@Param("userId") UUID userId);

    GroupView findGroup(@Param("groupId") UUID groupId, @Param("userId") UUID userId);

    List<GroupMember> findMembers(@Param("groupId") UUID groupId);
}
