package com.lycansync.api.chat.controller;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.dto.ChatMessagePageResponse;
import com.lycansync.api.chat.dto.ChatMessageResponse;
import com.lycansync.api.chat.model.ChatAttachmentContent;
import com.lycansync.api.chat.model.ChatFileMetadata;
import com.lycansync.api.chat.service.ChatService;
import com.lycansync.api.chat.service.ChatFileService;
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
import org.springframework.core.io.Resource;
import org.springframework.http.ContentDisposition;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.util.UUID;
import java.io.IOException;
import jakarta.servlet.http.HttpServletRequest;
import java.nio.charset.StandardCharsets;

/**
 * 群聊消息、图片与文件附件接口。
 *
 * @author Wreckloud
 * @since 2026-09-14
 */
@RestController
@RequestMapping("/api/groups/{groupId}")
@RequiredArgsConstructor
@Tag(name = "群聊", description = "已注册用户可在所有群组发送文字、图片和文件")
public class ChatController {

    private final ChatService chatService;
    private final ChatFileService chatFileService;

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
            @RequestParam(value = "messageId", required = false)
            @Parameter(description = "图片消息重试时保持不变的消息 ID") UUID messageId,
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        return ResponseEntity.status(201).cacheControl(CacheControl.noStore())
                .body(chatService.sendMessage(groupId, user, content, image, messageId));
    }

    @PostMapping(value = "/files", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    @Operation(summary = "发送群聊文件", description = "以原始字节流上传一个文件，不使用客户端 MIME 类型作为内容判断")
    @ApiResponses({
            @ApiResponse(responseCode = "201", description = "文件消息发送成功"),
            @ApiResponse(responseCode = "413", description = "文件超过单文件大小限制"),
            @ApiResponse(responseCode = "507", description = "服务器文件存储空间不足")
    })
    public ResponseEntity<ChatMessageResponse> sendFile(
            @PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @RequestHeader("X-Upload-Id") @Parameter(description = "上传重试使用的请求 ID") UUID uploadId,
            @RequestHeader("X-File-Name") @Parameter(description = "UTF-8 文件名的 Base64 URL 编码") String encodedFileName,
            @RequestHeader("X-File-Size") @Parameter(description = "预期文件字节数") long byteSize,
            @RequestHeader(value = "X-Message-Content", required = false)
            @Parameter(description = "UTF-8 消息文字的 Base64 URL 编码") String content,
            HttpServletRequest request,
            @AuthenticationPrincipal AuthenticatedUser user
    ) throws IOException {
        return ResponseEntity.status(201).cacheControl(CacheControl.noStore())
                .body(chatFileService.upload(groupId, user, uploadId, encodedFileName, content, byteSize,
                        request.getInputStream()));
    }

    @GetMapping("/files/requests/{uploadId}")
    @Operation(summary = "查询群聊文件上传结果")
    public ResponseEntity<ChatMessageResponse> findFileUpload(
            @PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @PathVariable @Parameter(description = "上传请求 ID") UUID uploadId,
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        ChatMessageResponse message = chatFileService.findCompletedUpload(groupId, uploadId, user);
        return message == null ? ResponseEntity.noContent().build()
                : ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(message);
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

    @GetMapping("/files/{attachmentId}")
    @Operation(summary = "下载群聊文件")
    public ResponseEntity<Resource> findFile(
            @PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @PathVariable @Parameter(description = "文件附件 ID") UUID attachmentId,
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        ChatFileMetadata metadata = chatFileService.findMetadata(groupId, attachmentId);
        Resource file = chatFileService.findFile(attachmentId);
        ContentDisposition disposition = ContentDisposition.attachment()
                .filename(metadata.fileName(), StandardCharsets.UTF_8).build();
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .header("X-Content-Type-Options", "nosniff")
                .header("Content-Disposition", disposition.toString())
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .contentLength(metadata.byteSize()).body(file);
    }
}
