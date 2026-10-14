package com.lycansync.api.rtc.controller;

import com.lycansync.api.rtc.service.GroupRtcAdmissionService;
import io.swagger.v3.oas.annotations.Hidden;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Profile;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/**
 * Caddy 信令预检入口；部署网关不向公网开放此内部路径。
 *
 * @author Wreckloud
 * @since 2026-10-13
 */
@RestController
@Profile({"rtc-local", "rtc-server"})
@RequiredArgsConstructor
@Hidden
@Tag(name = "信令内部校验")
public class GroupRtcAdmissionController {

    private final GroupRtcAdmissionService admission;

    @GetMapping("/internal/rtc/access")
    @Operation(summary = "核验信令连接的当前成员资格")
    public ResponseEntity<Void> checkAccess(
            @Parameter(description = "原始 LiveKit 认证头")
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @Parameter(description = "网关从 access_token 查询参数提取，不采信客户端同名头")
            @RequestHeader(value = "X-Lycan-Rtc-Token", required = false) String queryToken) {
        admission.requireMember(authorization, queryToken);
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    @PostMapping("/internal/rtc/events")
    @Operation(summary = "复核签名入房事件，断开撤权期间迟到的连接")
    public ResponseEntity<Void> roomEvent(
            @Parameter(description = "LiveKit 签名与正文校验凭据")
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody String body) {
        admission.checkJoinedParticipant(body, authorization);
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }
}
