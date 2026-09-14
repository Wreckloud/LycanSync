package com.lycansync.api.chat.controller;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.dto.ChatMessagePageResponse;
import com.lycansync.api.chat.dto.ChatMessageResponse;
import com.lycansync.api.chat.model.ChatAttachmentContent;
import com.lycansync.api.chat.service.ChatService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.util.UUID;

/**
 * 群聊消息与图片附件接口。
 *
 * @author Wreckloud
 * @since 2026-09-14
 */
@RestController
@RequestMapping("/api/groups/{groupId}")
@RequiredArgsConstructor
@Tag(name = "群聊", description = "已注册用户可在所有群组发送文字和图片")
public class ChatController {

    private final ChatService chatService;

    @GetMapping("/messages")
    @Operation(summary = "查询群聊消息")
    public ResponseEntity<ChatMessagePageResponse> findMessages(
            @PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @RequestParam(required = false) @Parameter(description = "查询更早消息的游标") UUID beforeMessageId,
            @RequestParam(required = false) @Parameter(description = "查询更新消息的游标") UUID afterMessageId,
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(chatService.findMessages(groupId, user, beforeMessageId, afterMessageId));
    }

    @PostMapping(value = "/messages", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    @Operation(summary = "发送群聊消息", description = "一条消息可包含文本和一张 PNG/JPEG 图片")
    @ApiResponses({
            @ApiResponse(responseCode = "201", description = "发送成功"),
            @ApiResponse(responseCode = "400", description = "消息或图片不符合要求",
                    content = @Content(mediaType = "application/problem+json", schema = @Schema(implementation = ProblemDetail.class)))
    })
    public ResponseEntity<ChatMessageResponse> sendMessage(
            @PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @RequestParam(value = "content", required = false) @Parameter(description = "消息文字") String content,
            @RequestPart(value = "image", required = false) @Parameter(description = "PNG 或 JPEG 图片") MultipartFile image,
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        return ResponseEntity.status(201).cacheControl(CacheControl.noStore())
                .body(chatService.sendMessage(groupId, user, content, image));
    }

    @GetMapping("/attachments/{attachmentId}")
    @Operation(summary = "读取消息图片")
    public ResponseEntity<byte[]> findAttachment(
            @PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @PathVariable @Parameter(description = "图片附件 ID") UUID attachmentId,
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        ChatAttachmentContent attachment = chatService.findAttachment(groupId, attachmentId, user);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .header("X-Content-Type-Options", "nosniff")
                .contentType(MediaType.parseMediaType(attachment.contentType()))
                .contentLength(attachment.data().length).body(attachment.data());
    }
}
