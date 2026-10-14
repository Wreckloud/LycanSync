package com.lycansync.api.group.controller;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.group.dto.CreateGroupRequest;
import com.lycansync.api.group.dto.GroupCandidateResponse;
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
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.DeferredResult;

import java.net.URI;
import java.util.List;
import java.util.UUID;

/**
 * 私密群组、成员资格与群主管理接口。
 *
 * @author Wreckloud
 * @since 2026-09-10
 */
@RestController
@RequestMapping("/api/groups")
@RequiredArgsConstructor
@Validated
@Tag(name = "群组管理", description = "成员访问已加入的群组，群主管理资料和成员")
public class GroupController {

    private final GroupService groupService;
    private final GroupMemberPresenceService groupMemberPresenceService;
    private final GroupPresenceChangeService groupPresenceChangeService;

    @GetMapping
    @Operation(summary = "查询当前账号已加入的群组")
    public ResponseEntity<List<GroupSummaryResponse>> findGroups(
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(groupService.findGroups(user));
    }

    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    @Operation(summary = "创建群组", description = "创建者成为群主，其他账号需添加或凭邀请码加入")
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
    @Operation(summary = "查询群组详情", description = "仅群成员可查看资料和成员列表")
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
            UUID groupId,
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(groupMemberPresenceService.findPresences(groupId, user));
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

    @Schema(description = "群内成员选择")
    public record MemberRequest(@NotNull @Schema(description = "当前服务器账号 ID") UUID userId) { }

    @Schema(description = "入群邀请码")
    public record JoinRequest(@NotNull @Pattern(regexp = "[A-Za-z0-9_-]{16}")
                              @Schema(description = "群主提供的当前邀请码") String code) { }

    @Schema(description = "群主可见的邀请码")
    public record InviteCode(String code) { }

    @Schema(description = "服务器成员分页")
    public record CandidatePage(List<GroupCandidateResponse> members, boolean hasMore) { }

    @PutMapping("/{groupId}")
    @Operation(summary = "群主修改群组资料")
    public ResponseEntity<GroupDetailResponse> updateGroup(@PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @AuthenticationPrincipal AuthenticatedUser user, @Valid @RequestBody CreateGroupRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(groupService.updateGroup(groupId, user, request));
    }

    @GetMapping("/{groupId}/candidates")
    @Operation(summary = "群主搜索服务器成员", description = "每页 20 人，仅返回公开资料和入群状态")
    public ResponseEntity<CandidatePage> candidates(@PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @AuthenticationPrincipal AuthenticatedUser user,
            @RequestParam(defaultValue = "") @Size(max = 32) @Parameter(description = "昵称搜索") String search,
            @RequestParam(defaultValue = "0") @Parameter(description = "分页起始位置") int offset) {
        List<GroupCandidateResponse> members = groupService.findCandidates(groupId, user, search, offset);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(new CandidatePage(members.stream().limit(20).toList(), members.size() > 20));
    }

    @PostMapping("/{groupId}/members")
    @Operation(summary = "群主直接添加服务器成员", description = "不发起审批，不连接语音，不能创建服务器外账号")
    public ResponseEntity<GroupDetailResponse> addMember(@PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @AuthenticationPrincipal AuthenticatedUser user, @Valid @RequestBody MemberRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(groupService.addMember(groupId, user, request.userId()));
    }

    @DeleteMapping("/{groupId}/members/{userId}")
    @Operation(summary = "退出群聊或群主移出成员", description = "撤销访问并只断开该成员的语音；移出时同时更换邀请码")
    public ResponseEntity<Void> removeMember(@PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @PathVariable @Parameter(description = "退出或移出的成员 ID") UUID userId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        groupService.removeMember(groupId, user, userId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/{groupId}/owner")
    @Operation(summary = "转让群主", description = "转给群内成员，原群主变为普通成员，并更换邀请码")
    public ResponseEntity<GroupDetailResponse> transfer(@PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @AuthenticationPrincipal AuthenticatedUser user, @Valid @RequestBody MemberRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(groupService.transferOwner(groupId, user, request.userId()));
    }

    @PostMapping("/{groupId}/invite-code")
    @Operation(summary = "群主获取邀请码", description = "首次自动生成，后续返回当前码；不进入服务器、不创建账号")
    public ResponseEntity<InviteCode> inviteCode(@PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(new InviteCode(groupService.inviteCode(groupId, user, false)));
    }

    @PostMapping("/{groupId}/invite-code/refresh")
    @Operation(summary = "群主更换邀请码", description = "旧码立即失效，现有成员不受影响")
    public ResponseEntity<InviteCode> refreshCode(@PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(new InviteCode(groupService.inviteCode(groupId, user, true)));
    }

    @PostMapping("/join")
    @Operation(summary = "服务器成员凭邀请码入群", description = "即时加入、不申请、不连接语音")
    public ResponseEntity<GroupDetailResponse> join(@AuthenticationPrincipal AuthenticatedUser user,
            @Valid @RequestBody JoinRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(groupService.joinByCode(user, request.code()));
    }

    @DeleteMapping("/{groupId}")
    @Operation(summary = "群主解散群聊", description = "删除群组、成员和聊天记录，结束群组语音并回收附件")
    public ResponseEntity<Void> dissolve(@PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @AuthenticationPrincipal AuthenticatedUser user) {
        groupService.dissolve(groupId, user);
        return ResponseEntity.noContent().build();
    }
}
