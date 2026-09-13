package com.lycansync.api.rtc.controller;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.rtc.dto.LocalRtcTokenRequest;
import com.lycansync.api.rtc.dto.RtcRoomSummaryResponse;
import com.lycansync.api.rtc.dto.RtcTokenResponse;
import com.lycansync.api.rtc.service.LocalRtcRoomSummaryService;
import com.lycansync.api.rtc.service.LocalRtcTokenService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Profile;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/**
 * 群组 RTC 接口，仅在本地媒体环境启用。
 *
 * @author Wreckloud
 * @since 2026-09-03
 */
@RestController
@Profile("rtc-local")
@RequiredArgsConstructor
@Validated
@RequestMapping("/api/rtc")
@Tag(name = "群组 RTC", description = "仅 rtc-local 模式启用，需要已登录账号")
public class LocalRtcController {

    private final LocalRtcTokenService localRtcTokenService;
    private final LocalRtcRoomSummaryService localRtcRoomSummaryService;

    @PostMapping(value = "/token", consumes = MediaType.APPLICATION_JSON_VALUE)
    @Operation(summary = "签发群组语音凭证", description = "已登录账号可进入任一现存群组的语音房间")
    @ApiResponses({
            @ApiResponse(responseCode = "200", description = "凭证签发成功，不代表媒体连接成功"),
            @ApiResponse(responseCode = "400", description = "请求参数无效",
                    content = @Content(mediaType = "application/problem+json",
                            schema = @Schema(implementation = ProblemDetail.class))),
            @ApiResponse(responseCode = "404", description = "业务房间不存在")
    })
    public ResponseEntity<RtcTokenResponse> issueToken(@Valid @RequestBody LocalRtcTokenRequest request,
                                                      @AuthenticationPrincipal AuthenticatedUser user) {
        // 凭证不能被缓存后重复分发，每次申请都交由 Service 签发。
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(localRtcTokenService.issueToken(request.groupId(), user));
    }

    @GetMapping("/room-summary")
    @Operation(summary = "查询群组语音成员摘要",
            description = "已登录账号可查看人数、参与者身份和昵称，不返回媒体状态")
    @ApiResponses({
            @ApiResponse(responseCode = "200", description = "摘要查询成功；LiveKit 尚未创建房间时返回空摘要"),
            @ApiResponse(responseCode = "400", description = "群组标识格式不正确"),
            @ApiResponse(responseCode = "404", description = "业务房间不存在"),
            @ApiResponse(responseCode = "503", description = "LiveKit 服务暂时不可用")
    })
    public ResponseEntity<RtcRoomSummaryResponse> getRoomSummary(
            @RequestParam
            @Parameter(description = "持久化群组 UUID")
            UUID groupId
    ) {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(localRtcRoomSummaryService.getSummary(groupId));
    }
}
