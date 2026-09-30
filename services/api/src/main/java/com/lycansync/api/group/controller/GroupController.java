package com.lycansync.api.group.controller;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.group.dto.CreateGroupRequest;
import com.lycansync.api.group.dto.GroupDetailResponse;
import com.lycansync.api.group.dto.GroupPresenceChangeResponse;
import com.lycansync.api.group.dto.GroupPresenceResponse;
import com.lycansync.api.group.dto.GroupSummaryResponse;
import com.lycansync.api.group.service.GroupMemberPresenceService;
import com.lycansync.api.group.service.GroupPresenceChangeService;
import com.lycansync.api.group.service.GroupService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Positive;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.DeferredResult;

import java.net.URI;
import java.util.List;
import java.util.UUID;

/**
 * 已注册用户的群组创建与查询接口。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
@RestController
@RequestMapping("/api/groups")
@RequiredArgsConstructor
@Validated
@Tag(name = "群组管理", description = "已注册账号可查看和使用所有群组")
public class GroupController {

    private final GroupService groupService;
    private final GroupMemberPresenceService groupMemberPresenceService;
    private final GroupPresenceChangeService groupPresenceChangeService;

    @GetMapping
    @Operation(summary = "查询所有群组")
    public ResponseEntity<List<GroupSummaryResponse>> findGroups(
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(groupService.findGroups(user));
    }

    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    @Operation(summary = "创建群组", description = "创建者成为群主，所有已注册账号自动可访问")
    @ApiResponses({
            @ApiResponse(responseCode = "201", description = "群组创建成功"),
            @ApiResponse(responseCode = "400", description = "群组资料不符合要求",
                    content = @Content(mediaType = "application/problem+json",
                            schema = @Schema(implementation = ProblemDetail.class)))
    })
    public ResponseEntity<GroupDetailResponse> createGroup(
            @AuthenticationPrincipal AuthenticatedUser user,
            @Valid @RequestBody CreateGroupRequest request
    ) {
        GroupDetailResponse group = groupService.createGroup(user, request);
        return ResponseEntity.created(URI.create("/api/groups/" + group.id()))
                .cacheControl(CacheControl.noStore())
                .body(group);
    }

    @GetMapping("/{groupId}")
    @Operation(summary = "查询群组详情", description = "所有已注册账号可查看资料和成员列表")
    @ApiResponses({
            @ApiResponse(responseCode = "200", description = "查询成功"),
            @ApiResponse(responseCode = "404", description = "群组不存在",
                    content = @Content(mediaType = "application/problem+json",
                            schema = @Schema(implementation = ProblemDetail.class)))
    })
    public ResponseEntity<GroupDetailResponse> findGroup(
            @PathVariable
            @Parameter(description = "群组 ID")
            UUID groupId,
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(groupService.findGroup(groupId, user));
    }

    @GetMapping("/{groupId}/presences")
    @Operation(summary = "查询群组成员在线状态", description = "只返回定期刷新所需的在线与活动数据")
    @ApiResponses({
            @ApiResponse(responseCode = "200", description = "查询成功"),
            @ApiResponse(responseCode = "404", description = "群组不存在",
                    content = @Content(mediaType = "application/problem+json",
                            schema = @Schema(implementation = ProblemDetail.class)))
    })
    public ResponseEntity<List<GroupPresenceResponse>> findPresences(
            @PathVariable
            @Parameter(description = "群组 ID")
            UUID groupId
    ) {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(groupMemberPresenceService.findPresences(groupId));
    }

    @GetMapping("/{groupId}/presence-changes")
    @Operation(summary = "等待群组成员状态变化", description = "状态或活动变化后返回版本游标，客户端应重新查询成员状态快照")
    @ApiResponses({
            @ApiResponse(responseCode = "200", description = "返回服务实例与群组状态版本"),
            @ApiResponse(responseCode = "404", description = "群组不存在",
                    content = @Content(mediaType = "application/problem+json",
                            schema = @Schema(implementation = ProblemDetail.class)))
    })
    public DeferredResult<GroupPresenceChangeResponse> waitForPresenceChanges(
            @PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @AuthenticationPrincipal AuthenticatedUser user,
            @RequestParam @Parameter(description = "此客户端本次运行的随机标识") UUID clientId,
            @RequestParam @Positive @Parameter(description = "此客户端等待请求的递增序号") long requestId,
            @RequestParam(required = false) @Parameter(description = "上次响应的服务启动标识") UUID serverInstanceId,
            @RequestParam(required = false) @Parameter(description = "上次响应的版本") Long version,
            HttpServletResponse response
    ) {
        groupService.findGroup(groupId, user);
        response.setHeader(HttpHeaders.CACHE_CONTROL, CacheControl.noStore().getHeaderValue());
        return groupPresenceChangeService.await(user.id(), groupId, clientId, requestId, serverInstanceId, version);
    }

}
