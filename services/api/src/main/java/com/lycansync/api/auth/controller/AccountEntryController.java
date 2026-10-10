package com.lycansync.api.auth.controller;

import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;

/**
 * 下载与唤起应用的链接入口；浏览器打开页面不兑换凭据。
 * @author Wreckloud
 * @since 2026-10-10
 */
@RestController
@Tag(name = "账号入口", description = "邀请网页与下载引导")
public class AccountEntryController {
    @GetMapping("/join")
    @Operation(summary = "打开邀请与激活页面")
    public ResponseEntity<Resource> entry() {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .header("Referrer-Policy", "no-referrer")
                .header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
                .contentType(MediaType.TEXT_HTML).body(new ClassPathResource("account/join.html"));
    }

    @GetMapping("/join.js")
    @Operation(summary = "获取账号入口脚本")
    public ResponseEntity<Resource> script() {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .contentType(MediaType.valueOf("application/javascript"))
                .body(new ClassPathResource("account/join.js"));
    }
}
