package com.lycansync.api.auth.controller;

import io.swagger.v3.oas.annotations.Hidden;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import jakarta.servlet.http.HttpServletRequest;

/**
 * 与账号接口同源的轻量官网，不加载桌面媒体或前端应用。
 *
 * @author Wreckloud
 * @since 2026-11-03
 */
@Hidden
@RestController
public class QqSiteController {
    @GetMapping({"/", "/account", "/privacy", "/terms", "/qq/result", "/site.css", "/site.js", "/qq-login.png", "/site-icon.png"})
    public ResponseEntity<Resource> page(HttpServletRequest request) {
        String path = request.getRequestURI();
        String file = switch (path) {
            case "/site.css" -> "site.css";
            case "/site.js" -> "site.js";
            case "/qq-login.png" -> "qq-login.png";
            case "/site-icon.png" -> "site-icon.png";
            default -> "index.html";
        };
        MediaType type = switch (file) {
            case "site.css" -> MediaType.valueOf("text/css;charset=UTF-8");
            case "site.js" -> MediaType.valueOf("text/javascript;charset=UTF-8");
            case "qq-login.png", "site-icon.png" -> MediaType.IMAGE_PNG;
            default -> MediaType.TEXT_HTML;
        };
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(type)
                .header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
                .header("Referrer-Policy", "no-referrer").header("X-Content-Type-Options", "nosniff")
                .body(new ClassPathResource("site-icon.png".equals(file) ? "account/default.png" : "qq-site/" + file));
    }
}
