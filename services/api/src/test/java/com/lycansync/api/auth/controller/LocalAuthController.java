package com.lycansync.api.auth.controller;

import com.lycansync.api.auth.dto.LocalLoginRequest;
import com.lycansync.api.auth.dto.LocalRegistrationRequest;
import com.lycansync.api.auth.dto.LoginResponse;
import com.lycansync.api.auth.service.LocalAuthService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirements;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 仅显式测试模式开放的本地账号入口。
 * @author Wreckloud
 * @since 2026-10-10
 */
@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
@ConditionalOnProperty(name = "lycansync.account.mode", havingValue = "test")
@Tag(name = "测试账号", description = "仅独立测试环境可用")
public class LocalAuthController {
    private final LocalAuthService localAuthService;
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

}
