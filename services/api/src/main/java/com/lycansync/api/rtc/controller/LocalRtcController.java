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
import jakarta.validation.constraints.Pattern;
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

/**
 * 本地 RTC 调试接口。
 *
 * @author Wreckloud
 * @since 2026-09-03
 */
@RestController
@Profile("rtc-local")
@RequiredArgsConstructor
@Validated
@RequestMapping("/api/rtc")
@Tag(name = "本地 RTC 调试", description = "仅 rtc-local 模式启用，需要已登录账号")
public class LocalRtcController {

    private final LocalRtcTokenService localRtcTokenService;
    private final LocalRtcRoomSummaryService localRtcRoomSummaryService;

    @PostMapping(value = "/token", consumes = MediaType.APPLICATION_JSON_VALUE)
    @Operation(summary = "签发本地测试房间凭证", description = "使用已认证账号身份进入本地调试房间，不创建群组记录")
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
    @Operation(summary = "查询本地测试群组的语音成员摘要",
            description = "仅返回人数和显示昵称，不返回发言、麦克风、收听或共享状态")
    @ApiResponses({
            @ApiResponse(responseCode = "200", description = "摘要查询成功；LiveKit 尚未创建房间时返回空摘要"),
            @ApiResponse(responseCode = "400", description = "群组标识格式不正确"),
            @ApiResponse(responseCode = "404", description = "业务房间不存在"),
            @ApiResponse(responseCode = "503", description = "LiveKit 服务暂时不可用")
    })
    public ResponseEntity<RtcRoomSummaryResponse> getRoomSummary(
            @RequestParam
            @Pattern(regexp = LocalRtcTokenRequest.GROUP_ID_PATTERN, message = "群组标识格式不正确")
            @Parameter(description = "本地界面使用的群组标识", example = "pack")
            String groupId
    ) {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(localRtcRoomSummaryService.getSummary(groupId));
    }
}
