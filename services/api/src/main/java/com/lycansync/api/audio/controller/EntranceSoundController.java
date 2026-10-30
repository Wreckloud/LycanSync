package com.lycansync.api.audio.controller;

import com.lycansync.api.audio.service.EntranceSoundService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;

/**
 * 已登录用户的入场音效上传与规范化接口。
 *
 * @author Wreckloud
 * @since 2026-10-30
 */
@RestController
@RequestMapping("/api/audio/entrance-sound")
@RequiredArgsConstructor
@Tag(name = "入场音效", description = "受认证的短音效处理，不长期保存上传文件")
public class EntranceSoundController {

    private final EntranceSoundService service;

    @PostMapping(value = "/normalize", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    @Operation(summary = "规范入场音效", description = "原始字节上传 MP3/OGG/WAV/WebM，最多 512 KB、5 秒；返回 48 kHz 单声道 PCM WAV。统一能量和峰值上限，处理后删除临时文件，不写入账号资料")
    public ResponseEntity<byte[]> normalize(HttpServletRequest request) throws IOException {
        byte[] sound = service.normalize(request.getInputStream());
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .header("X-Content-Type-Options", "nosniff")
                .contentType(MediaType.parseMediaType("audio/wav"))
                .contentLength(sound.length).body(sound);
    }
}
