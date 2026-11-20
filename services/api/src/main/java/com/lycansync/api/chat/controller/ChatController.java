package com.lycansync.api.chat.controller;

import com.lycansync.api.auth.model.AuthenticatedUser;
import com.lycansync.api.chat.dto.ChatMessagePageResponse;
import com.lycansync.api.chat.dto.ChatMessageResponse;
import com.lycansync.api.chat.dto.ChatVideoPreviewResponse;
import com.lycansync.api.chat.model.ChatAttachmentContent;
import com.lycansync.api.chat.model.ChatFileMetadata;
import com.lycansync.api.chat.service.ChatFileMediaService;
import com.lycansync.api.chat.service.ChatFileService;
import com.lycansync.api.chat.service.ChatMessageWaitService;
import com.lycansync.api.chat.service.ChatService;
import com.lycansync.api.chat.service.ChatVideoPreviewService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;
import lombok.RequiredArgsConstructor;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.DeferredResult;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;

/**
 * 群聊消息、图片与文件附件接口。
 *
 * @author Wreckloud
 * @since 2026-09-14
 */
@RestController
@RequestMapping("/api/groups/{groupId}")
@RequiredArgsConstructor
@Tag(name = "群聊", description = "群成员可发送和读取本群文字、图片和文件")
public class ChatController {

    private final ChatService chatService;
    private final ChatFileService chatFileService;
    private final ChatFileMediaService videoThumbnails;
    private final ChatVideoPreviewService videoPreviews;
    private final ChatMessageWaitService chatMessageWaitService;

    @GetMapping(value = "/messages", params = "wait=true")
    @Operation(summary = "等待群聊新消息", description = "无新消息时最多等待 25 秒；返回前重新核对成员资格")
    public DeferredResult<ChatMessagePageResponse> waitForMessages(
            @PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @RequestParam(required = false) @Parameter(description = "已确认的最新消息游标") UUID afterMessageId,
            @RequestParam @Parameter(description = "当前客户端标识") UUID clientId,
            @RequestParam @Positive @Parameter(description = "递增请求序号") long requestId,
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        return chatMessageWaitService.await(groupId, user, afterMessageId, clientId, requestId);
    }

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
            @Parameter(description = "消息重试时保持不变的 ID") UUID messageId,
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        return ResponseEntity.status(201).cacheControl(CacheControl.noStore())
                .body(chatService.sendMessage(groupId, user, content, image, messageId));
    }

    @PostMapping(value = "/files", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    @Operation(summary = "发送群聊文件", description = "以原始字节流上传一个文件，不使用客户端 MIME 类型作为内容判断")
    @ApiResponses({
            @ApiResponse(responseCode = "201", description = "文件消息发送成功或返回已完成的同编号消息"),
            @ApiResponse(responseCode = "409", description = "同编号上传仍在进行或收尾，请稍后重试"),
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
            @RequestHeader(value = "X-File-Message", required = false) UUID messageId,
            HttpServletRequest request,
            @AuthenticationPrincipal AuthenticatedUser user
    ) throws IOException {
        return ResponseEntity.status(201).cacheControl(CacheControl.noStore())
                .body(messageId == null ? chatFileService.upload(groupId, user, uploadId, encodedFileName, content, byteSize,
                        request.getInputStream()) : chatFileService.upload(groupId, user, uploadId, encodedFileName, content,
                        byteSize, request.getInputStream(), messageId));
    }

    @Schema(description = "文件消息登记，仅发送元数据")
    public record Declaration(@NotNull UUID attemptId, @NotNull @Size(max = 2048) String encodedName,
                              @PositiveOrZero long byteSize, @Size(max = 4000) String content) { }

    @PostMapping("/files/transfers/{messageId}")
    @Operation(summary = "登记文件消息并确定群内顺序")
    public ChatMessageResponse declare(@PathVariable UUID groupId, @PathVariable UUID messageId,
                                       @Valid @RequestBody Declaration request, @AuthenticationPrincipal AuthenticatedUser user) {
        return chatFileService.declare(groupId, user, messageId, request.attemptId(), request.encodedName(),
                request.byteSize(), request.content());
    }

    @GetMapping("/files/transfers")
    @Operation(summary = "更新已有文件消息的传输状态")
    public List<ChatMessageResponse> deliveries(@PathVariable UUID groupId, @RequestParam @Size(min = 1, max = 50) List<UUID> ids,
                                                @AuthenticationPrincipal AuthenticatedUser user) {
        return chatFileService.deliveries(groupId, user, ids);
    }

    @DeleteMapping("/files/transfers/{messageId}/{attemptId}")
    @Operation(summary = "停止本次文件发送")
    public ResponseEntity<Void> stop(@PathVariable UUID groupId, @PathVariable UUID messageId, @PathVariable UUID attemptId,
                                     @AuthenticationPrincipal AuthenticatedUser user) {
        chatFileService.stop(groupId, user, messageId, attemptId);
        return ResponseEntity.noContent().build();
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

    @GetMapping("/files/{attachmentId}/thumbnail")
    @Operation(summary = "读取视频封面", description = "按需生成小尺寸 JPEG，无可用视频画面时返回 204；不传输原视频")
    public ResponseEntity<byte[]> findVideoThumbnail(
            @PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @PathVariable @Parameter(description = "文件附件 ID") UUID attachmentId,
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        byte[] thumbnail = videoThumbnails.findThumbnail(groupId, attachmentId, user);
        if (thumbnail == null) return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.IMAGE_JPEG)
                .header("X-Content-Type-Options", "nosniff").contentLength(thumbnail.length).body(thumbnail);
    }

    @PostMapping("/files/{attachmentId}/preview")
    @Operation(summary = "转换兼容视频预览", description = "仅用户主动请求时转换，重复请求复用同一任务；返回状态，不修改原文件")
    public ResponseEntity<ChatVideoPreviewResponse> prepareVideoPreview(
            @PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @PathVariable @Parameter(description = "文件附件 ID") UUID attachmentId,
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(videoPreviews.prepare(groupId, attachmentId, user));
    }

    @GetMapping("/files/{attachmentId}/preview")
    @Operation(summary = "查询兼容视频预览状态", description = "只查询，不启动转换")
    public ResponseEntity<ChatVideoPreviewResponse> findVideoPreviewStatus(
            @PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @PathVariable @Parameter(description = "文件附件 ID") UUID attachmentId,
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(videoPreviews.status(groupId, attachmentId, user));
    }

    @GetMapping("/files/{attachmentId}/preview/media")
    @Operation(summary = "播放兼容视频预览", description = "支持 Range 分段读取；缓存不存在时返回 404，不自动转换")
    public ResponseEntity<Resource> findVideoPreview(
            @PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @PathVariable @Parameter(description = "文件附件 ID") UUID attachmentId,
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).header("X-Content-Type-Options", "nosniff")
                .contentType(MediaType.parseMediaType("video/mp4")).body(videoPreviews.find(groupId, attachmentId, user));
    }

    @GetMapping("/files/{attachmentId}/media")
    @Operation(summary = "播放消息音视频", description = "校验群成员资格后读取原文件，支持 HTTP Range 分段请求；编码须受播放器支持")
    public ResponseEntity<Resource> findMedia(
            @PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @PathVariable @Parameter(description = "文件附件 ID") UUID attachmentId,
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        ChatFileMetadata metadata = chatFileService.findMetadata(groupId, attachmentId, user);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .header("X-Content-Type-Options", "nosniff")
                .contentType(MediaType.parseMediaType(ChatFileMediaService.mediaType(metadata.fileName())))
                .body(chatFileService.findFile(attachmentId));
    }

    @GetMapping("/files/{attachmentId}")
    @Operation(summary = "下载群聊文件")
    public ResponseEntity<Resource> findFile(
            @PathVariable @Parameter(description = "群组 ID") UUID groupId,
            @PathVariable @Parameter(description = "文件附件 ID") UUID attachmentId,
            @AuthenticationPrincipal AuthenticatedUser user
    ) {
        ChatFileMetadata metadata = chatFileService.findMetadata(groupId, attachmentId, user);
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
