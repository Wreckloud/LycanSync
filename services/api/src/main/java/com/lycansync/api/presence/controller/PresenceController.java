package com.lycansync.api.presence.controller;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.diagnostics.service.DiagnosticReportRequests;
import com.lycansync.api.presence.dto.PresenceHeartbeatRequest;
import com.lycansync.api.presence.service.PresenceService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 用户在线状态接口。
 *
 * @author Wreckloud
 * @since 2026-09-20
 */
@RestController
@RequestMapping("/api/presence")
@RequiredArgsConstructor
@Validated
@Tag(name = "在线状态", description = "客户端心跳上报与查询")
public class PresenceController {

    private final PresenceService presenceService;

    private final DiagnosticReportRequests diagnosticRequests;

    @PostMapping(value = "/heartbeat", consumes = MediaType.APPLICATION_JSON_VALUE)
    @Operation(summary = "在线状态心跳", description = "客户端定期上报当前状态；离线结束当前公开动态并冻结历史；分别控制游戏动态及上次公开在线时间的展示")
    public ResponseEntity<Boolean> heartbeat(@AuthenticationPrincipal AuthenticatedUser user,
                                          @Valid @RequestBody PresenceHeartbeatRequest request,
                                          @RequestParam(defaultValue = "false") boolean acceptDiagnosticRequest) {
        presenceService.heartbeat(user, request);
        if (acceptDiagnosticRequest && diagnosticRequests.claim(user.id())) {
            return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(true);
        }
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }
}
