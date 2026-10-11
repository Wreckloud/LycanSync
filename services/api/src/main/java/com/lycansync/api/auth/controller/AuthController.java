package com.lycansync.api.auth.controller;

import com.lycansync.api.auth.dto.ProfileUpdateRequest;
import com.lycansync.api.auth.dto.SessionStatusResponse;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.service.AuthService;
import com.lycansync.api.auth.service.ProfileService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 通用登录会话与个人资料接口。
 *
 * @author Wreckloud
 * @since 2026-09-06
 */
@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
@Tag(name = "登录认证", description = "账号资料与业务接口共用的 Bearer 会话")
public class AuthController {

    private final AuthService authService;
    private final ProfileService profileService;

    @GetMapping("/me")
    @Operation(summary = "获取当前账号资料")
    public ResponseEntity<AuthUser> me(@AuthenticationPrincipal AuthenticatedUser user) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(profileService.findProfile(user));
    }

    @GetMapping("/session")
    @Operation(summary = "检查当前登录会话", description = "返回不包含头像的轻量会话状态")
    public ResponseEntity<SessionStatusResponse> session(@AuthenticationPrincipal AuthenticatedUser user) {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(new SessionStatusResponse(user.id(), user.nickname(), user.administrator()));
    }

    @PutMapping("/me")
    @Operation(summary = "修改昵称、头像和个性签名", description = "提交裁剪后的 PNG/JPEG data URL，最多 2 MiB、1024×1024；服务器统一为 256×256 PNG；签名选填，最多 120 个字符，省略时保留原值")
    public AuthUser update(@AuthenticationPrincipal AuthenticatedUser user,
                           @Valid @RequestBody ProfileUpdateRequest request) {
        return profileService.update(user, request);
    }

    @PostMapping("/logout")
    @Operation(summary = "退出当前设备登录")
    public ResponseEntity<Void> logout(@RequestHeader("Authorization") String authorization) {
        // 认证过滤器已校验 Bearer 前缀及当前会话，此处只提取待撤销的原始凭据。
        authService.logout(authorization.substring("Bearer ".length()));
        return ResponseEntity.noContent().build();
    }
}
