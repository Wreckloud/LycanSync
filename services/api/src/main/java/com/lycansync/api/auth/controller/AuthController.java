package com.lycansync.api.auth.controller;

import com.lycansync.api.auth.dto.LocalLoginRequest;
import com.lycansync.api.auth.dto.LocalRegistrationRequest;
import com.lycansync.api.auth.dto.LoginResponse;
import com.lycansync.api.auth.dto.ProfileUpdateRequest;
import com.lycansync.api.auth.model.AuthUser;
import com.lycansync.api.auth.service.AuthService;
import com.lycansync.api.auth.service.LocalAuthService;
import com.lycansync.api.auth.service.ProfileService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirements;
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
 * 本地登录与个人资料接口。
 *
 * @author Wreckloud
 * @since 2026-09-06
 */
@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
@Tag(name = "登录认证", description = "本地账号登录与业务接口共用的 Bearer 会话")
public class AuthController {

    private final AuthService authService;
    private final LocalAuthService localAuthService;
    private final ProfileService profileService;

    @PostMapping("/local/register")
    @Operation(summary = "注册本地账号", description = "首个成功注册的账号自动成为管理员")
    @SecurityRequirements
    public ResponseEntity<LoginResponse> register(@Valid @RequestBody LocalRegistrationRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(localAuthService.register(request));
    }

    @PostMapping("/local/login")
    @Operation(summary = "登录本地账号", description = "成功后返回一次会话凭据，请勿记录响应内容")
    @SecurityRequirements
    public ResponseEntity<LoginResponse> login(@Valid @RequestBody LocalLoginRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(localAuthService.login(request));
    }

    @GetMapping("/me")
    @Operation(summary = "获取当前账号资料")
    public ResponseEntity<AuthUser> me(@AuthenticationPrincipal AuthUser user) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(user);
    }

    @PutMapping("/me")
    @Operation(summary = "修改昵称和头像", description = "头像支持不超过 512 KB、1024×1024 的 PNG/JPEG data URL")
    public AuthUser update(@AuthenticationPrincipal AuthUser user, @Valid @RequestBody ProfileUpdateRequest request) {
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
