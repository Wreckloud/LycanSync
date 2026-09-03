package com.lycansync.api.rtc.controller;

import com.lycansync.api.rtc.dto.LocalRtcTokenRequest;
import com.lycansync.api.rtc.dto.RtcTokenResponse;
import com.lycansync.api.rtc.service.LocalRtcTokenService;
import io.swagger.v3.oas.annotations.Operation;
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
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
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
@RequestMapping("/api/rtc")
@Tag(name = "本地 RTC 调试", description = "仅 rtc-local 模式启用，不提供正式登录能力")
public class LocalRtcController {

    private final LocalRtcTokenService localRtcTokenService;

    @PostMapping(value = "/token", consumes = MediaType.APPLICATION_JSON_VALUE)
    @Operation(summary = "签发本地测试房间凭证", description = "固定房间、临时身份；不创建数据库用户或房间记录")
    @ApiResponses({
            @ApiResponse(responseCode = "200", description = "凭证签发成功，不代表媒体连接成功"),
            @ApiResponse(responseCode = "400", description = "请求参数无效",
                    content = @Content(mediaType = "application/problem+json",
                            schema = @Schema(implementation = ProblemDetail.class)))
    })
    public ResponseEntity<RtcTokenResponse> issueToken(@Valid @RequestBody LocalRtcTokenRequest request) {
        // 凭证不能被缓存后重复分发，每次申请都交由 Service 签发。
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(localRtcTokenService.issueToken(request.displayName()));
    }
}
