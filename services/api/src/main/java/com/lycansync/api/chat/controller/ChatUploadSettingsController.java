package com.lycansync.api.chat.controller;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.dto.ChatUploadLimits;
import com.lycansync.api.chat.service.ChatUploadSettingsService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
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
 * 聊天附件选择与服主管理共用的上传限额。
 *
 * @author Wreckloud
 * @since 2026-11-20
 */
@RestController
@RequestMapping("/api/chat/upload-limits")
@RequiredArgsConstructor
@Tag(name = "群聊")
public class ChatUploadSettingsController {
    private final ChatUploadSettingsService settings;

    @GetMapping
    @Operation(summary = "读取群聊文件大小和总容量上限")
    public ResponseEntity<ChatUploadLimits> limits() {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(settings.limits());
    }

    @PutMapping
    @Operation(summary = "保存群聊文件上传限额", description = "仅当前服主可修改，保存后立即生效")
    public ChatUploadLimits save(@AuthenticationPrincipal AuthenticatedUser user,
                                                  @Valid @RequestBody ChatUploadLimits limits) {
        return settings.save(user, limits);
    }
}
