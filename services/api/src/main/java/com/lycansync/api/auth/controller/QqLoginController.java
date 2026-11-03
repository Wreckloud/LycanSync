package com.lycansync.api.auth.controller;

import com.lycansync.api.auth.dto.QqLoginResponse;
import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.auth.service.QqLoginService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Pattern;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.net.URI;
import java.time.Duration;
import java.util.Arrays;

/**
 * 系统浏览器 QQ 授权入口，原始 QQ 令牌不返回页面。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
@RestController
@RequiredArgsConstructor
@RequestMapping("/api/auth/qq")
@Tag(name = "QQ 登录与绑定")
public class QqLoginController {
    private final QqLoginService login;

    @Schema(description = "原发起端持有随机 verifier，仅向服务端提交其 SHA-256 摘要")
    public record StartRequest(@Pattern(regexp = "[a-f0-9]{64}") String challenge, boolean desktop, boolean binding) { }
    @Schema(description = "一次性授权任务与原发起端凭据")
    public record ExchangeRequest(@Pattern(regexp = "[A-Za-z0-9_-]{43}") String request,
                                  @Pattern(regexp = "[A-Za-z0-9_-]{43}") String verifier) { }

    @PostMapping("/start")
    @Operation(summary = "创建 QQ 登录或绑定请求")
    public ResponseEntity<QqLoginService.Start> start(@Valid @RequestBody StartRequest request,
                                                     @AuthenticationPrincipal AuthenticatedUser user) {
        return noStore(login.start(request.challenge(), request.desktop(), request.binding(), user));
    }

    @GetMapping("/authorize")
    @Operation(summary = "绑定浏览器并跳转 QQ 官方授权页")
    public ResponseEntity<Void> authorize(@RequestParam String request, HttpServletRequest servletRequest) {
        var result = login.authorize(request, proof(request, servletRequest));
        String cookie = ResponseCookie.from(login.cookieName(request), result.browserProof()).httpOnly(true)
                .secure(true).sameSite("Lax").path("/").maxAge(Duration.ofMinutes(10)).build().toString();
        return ResponseEntity.status(HttpStatus.FOUND).header(HttpHeaders.SET_COOKIE, cookie)
                .header("Referrer-Policy", "no-referrer").cacheControl(CacheControl.noStore()).location(URI.create(result.url())).build();
    }

    @GetMapping("/callback")
    @Operation(summary = "接收 QQ 授权结果并验证身份")
    public ResponseEntity<Void> callback(@RequestParam String state, @RequestParam(required = false) String code,
                                         @RequestParam(required = false) String error, HttpServletRequest request) {
        login.callback(state, proof(state, request), code, error);
        return ResponseEntity.status(HttpStatus.FOUND).cacheControl(CacheControl.noStore())
                .header("Referrer-Policy", "no-referrer").location(URI.create("/qq/result#request=" + state)).build();
    }

    @GetMapping("/result")
    @Operation(summary = "在授权浏览器查看待确认的 QQ 资料")
    public ResponseEntity<QqLoginService.Result> result(@RequestParam String request, HttpServletRequest servletRequest) {
        return noStore(login.result(request, proof(request, servletRequest)));
    }

    @PostMapping("/exchange")
    @Operation(summary = "原发起端确认登录并领取本地账号会话")
    public ResponseEntity<QqLoginResponse> exchange(@Valid @RequestBody ExchangeRequest request) {
        return noStore(login.exchange(request.request(), request.verifier()));
    }

    @PostMapping("/binding/confirm")
    @Operation(summary = "已登录原账号确认绑定，不改变账号资料和权限")
    public ResponseEntity<QqLoginService.Binding> confirm(@Valid @RequestBody ExchangeRequest request,
                                                          @AuthenticationPrincipal AuthenticatedUser user) {
        return noStore(login.confirmBinding(request.request(), request.verifier(), user));
    }

    @GetMapping("/binding")
    @Operation(summary = "查看当前账号的 QQ 绑定状态")
    public ResponseEntity<QqLoginService.Binding> binding(@AuthenticationPrincipal AuthenticatedUser user) {
        return noStore(login.binding(user));
    }

    private String proof(String request, HttpServletRequest servletRequest) {
        String name = login.cookieName(request);
        Cookie[] cookies = servletRequest.getCookies();
        return cookies == null ? null : Arrays.stream(cookies).filter(cookie -> name.equals(cookie.getName()))
                .map(Cookie::getValue).findFirst().orElse(null);
    }

    private <T> ResponseEntity<T> noStore(T result) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).header("Referrer-Policy", "no-referrer").body(result);
    }
}
