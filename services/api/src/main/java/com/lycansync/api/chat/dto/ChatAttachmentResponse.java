package com.lycansync.api.chat.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import java.util.UUID;

/**
 * 群聊图片的元数据，不内联图片二进制内容。
 *
 * @author Wreckloud
 * @since 2026-09-14
 */
@Schema(description = "消息图片元数据")
public record ChatAttachmentResponse(
        @Schema(description = "附件 ID") UUID id,
        @Schema(description = "图片 MIME 类型", example = "image/jpeg") String contentType,
        @Schema(description = "图片宽度", example = "1920") int width,
        @Schema(description = "图片高度", example = "1080") int height,
        @Schema(description = "图片字节大小", example = "3145728") int byteSize) {
}
