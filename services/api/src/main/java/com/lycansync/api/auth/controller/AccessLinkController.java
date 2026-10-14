package com.lycansync.api.auth.controller;

import com.lycansync.api.auth.config.AccountAccessProperties;
import com.lycansync.api.auth.dto.AccessLinkRequest;
import com.lycansync.api.auth.dto.AccessRedeemRequest;
import com.lycansync.api.auth.dto.LoginResponse;
import com.lycansync.api.auth.model.AccessLink;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.service.AccessLinkService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirements;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/**
 * 公开入口检查、一次性兑换及仅服主可用的管理接口。
 *
 * @author Wreckloud
 * @since 2026-10-10
 */
@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
@Tag(name = "账号准入", description = "激活、邀请与恢复成员登录")
public class AccessLinkController {
    private final AccessLinkService links;
    private final AccountAccessProperties settings;

    public record LoginOptions(String mode, String serverName, boolean qqAvailable) { }

    @GetMapping("/options")
    @SecurityRequirements
    @Operation(summary = "获取服务器支持的登录方式")
    public ResponseEntity<LoginOptions> options() {
        return noStore(new LoginOptions(settings.getMode(), settings.getServerName(), false));
    }

    @PostMapping("/access/preview")
    @SecurityRequirements
    @Operation(summary = "检查链接用途与有效状态", description = "仅检查，不消耗链接，不返回成员身份信息")
    public ResponseEntity<AccessLinkService.LinkPreview> preview(@Valid @RequestBody AccessRedeemRequest request) {
        return noStore(links.preview(request.token()));
    }

    @PostMapping("/access/redeem")
    @SecurityRequirements
    @Operation(summary = "确认加入、激活或恢复", description = "成功后原子消耗链接并签发当前设备会话")
    public ResponseEntity<LoginResponse> redeem(@Valid @RequestBody AccessRedeemRequest request,
                                              @AuthenticationPrincipal AuthenticatedUser user) {
        return noStore(links.redeem(request.token(), request.redemptionKey(), user));
    }

    @GetMapping("/access/links")
    @Operation(summary = "服主查看链接状态", description = "每页最多 100 条")
    public ResponseEntity<List<AccessLink>> list(@AuthenticationPrincipal AuthenticatedUser user,
                                               @RequestParam(defaultValue = "0") int offset) {
        return noStore(links.list(user, offset));
    }

    @PostMapping("/access/links")
    @Operation(summary = "服主邀请新朋友或恢复成员登录", description = "原始链接仅在生成响应返回；邀请 3 天，恢复 12 小时")
    public ResponseEntity<AccessLinkService.GeneratedLink> create(@AuthenticationPrincipal AuthenticatedUser user,
                                                               @Valid @RequestBody AccessLinkRequest request) {
        return noStore(links.create(user, request));
    }

    @PostMapping("/access/links/{id}/renew")
    @Operation(summary = "重新生成未使用链接", description = "旧链接失效，已使用邀请不能重新生成")
    public ResponseEntity<AccessLinkService.GeneratedLink> renew(@AuthenticationPrincipal AuthenticatedUser user,
                                                               @PathVariable UUID id) {
        return noStore(links.renew(user, id));
    }

    @DeleteMapping("/access/links/{id}")
    @Operation(summary = "撤销未使用链接")
    public ResponseEntity<Void> revoke(@AuthenticationPrincipal AuthenticatedUser user, @PathVariable UUID id) {
        links.revoke(user, id);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/access/members")
    @Operation(summary = "服主查看可恢复成员", description = "每页最多 100 个成员")
    public ResponseEntity<List<AuthUser>> members(@AuthenticationPrincipal AuthenticatedUser user,
                                                @RequestParam(defaultValue = "0") int offset) {
        return noStore(links.members(user, offset));
    }

    private <T> ResponseEntity<T> noStore(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
