package com.lycansync.api.auth.controller;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.dto.QqConfigurationRequest;
import jakarta.validation.Valid;
import com.lycansync.api.auth.service.OwnerSettingsService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 服主面板的服务器配置状态入口。
 *
 * @author Wreckloud
 * @since 2026-11-04
 */
@RestController
@RequestMapping("/api/auth/server-settings")
@RequiredArgsConstructor
@Tag(name = "服主管理", description = "服务器配置状态与管理入口")
public class OwnerSettingsController {
    private final OwnerSettingsService settings;

    @GetMapping
    @Operation(summary = "读取服务器配置状态", description = "仅当前服主可见，不返回密钥、内部地址或部署路径，不代表服务健康检查通过")
    public ResponseEntity<OwnerSettingsService.Status> status(@AuthenticationPrincipal AuthenticatedUser user) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(settings.status(user));
    }

    @GetMapping("/qq")
    @Operation(summary = "读取 QQ 登录配置", description = "仅当前服主可见；不返回 App Key")
    public ResponseEntity<OwnerSettingsService.QqSettings> qqSettings(@AuthenticationPrincipal AuthenticatedUser user) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(settings.qqSettings(user));
    }

    @PutMapping("/qq")
    @Operation(summary = "保存 QQ 登录配置", description = "仅当前服主可用，保存后立即生效；App Key 留空保留同一应用的已有密钥，有绑定成员时不可更换 App ID")
    public ResponseEntity<OwnerSettingsService.QqSettings> saveQqSettings(@AuthenticationPrincipal AuthenticatedUser user,
                                                                       @Valid @RequestBody QqConfigurationRequest request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(settings.saveQqSettings(user, request));
    }
}
